import type { HabenulaEnv } from "../../src/env";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";

// Augment the catalog with a credential-less (`none`) service so the `none`
// dispatch branch can be exercised — no `none` service is wired yet. The mock
// delegates to the real catalog for every other name, so the OAuth and
// unknown-service cases below hit the real entries.
//
// The mock target is the `@habenula-ai/tools` barrel, not the package's
// internal `services/catalog` module: the worker resolves the catalog through
// the barrel (`import { lookupService } from "@habenula-ai/tools"` in
// src/index.ts), so overriding the barrel export is what the dispatch path
// actually sees. Mocking the internal module would not intercept the re-export.
vi.mock("@habenula-ai/tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@habenula-ai/tools")>();
  return {
    ...actual,
    lookupService: (name: string) =>
      name === "test_none"
        ? { service: "test_none", connect: { type: "none" }, tools: [] }
        : actual.lookupService(name),
  };
});

import worker, { resolveCallbackUrl } from "../../src/index";
import { OAUTH_PROVIDERS, SERVICES } from "@habenula-ai/tools";
import type { OAuthProviderId } from "@habenula-ai/tools";

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Where each provider's begin-flow must send the browser, and how PKCE rides
// along — the two differ, so the challenge assertion is per provider, not
// generic. Keyed by provider, not service, so a second service on an existing
// provider is asserted automatically by the iterated test below.
//   - google: the challenge is on the authorize URL (Google's server reads it).
//   - mock: the challenge travels via DO state, so it is NOT on the URL; the
//     consent handler loads it from state and verifies at exchange time.
//   - slack: no challenge anywhere on the URL — Slack authenticates the
//     exchange with client_secret, and a recorded challenge could break the
//     exchange. Scopes ride user_scope, not scope.
//   - github: the challenge is on the authorize URL, like google; no scope
//     param at all — a GitHub App's repository access is chosen at install.
const AUTHORIZE_URL_SHAPE: Record<OAuthProviderId, (url: URL) => void> = {
  google: (url) => {
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  },
  mock: (url) => {
    expect(url.pathname).toBe("/oauth/mock/authorize");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
  },
  slack: (url) => {
    expect(url.hostname).toBe("slack.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("user_scope")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();
  },
  github: (url) => {
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBeNull();
  },
  microsoft: (url) => {
    // The "not Google-shaped" checkpoint: Entra's
    // common-tenant authorize endpoint, PKCE on the URL, and the
    // provider-level offline_access scope (no refresh token without it).
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  },
};

describe("POST /connect/{service} dispatch", () => {
  for (const service of SERVICES.filter((s) => s.connect.type === "oauth")) {
    const provider =
      service.connect.type === "oauth" ? service.connect.provider : null;

    it(`[${service.service}] returns its provider's authorize URL`, async () => {
      const userId = `dispatch-${service.service}`;
      const response = await workerFetch(
        new Request(
          `http://localhost/connect/${service.service}?userId=${userId}`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { authorizeUrl?: string };
      expect(body.authorizeUrl).toBeDefined();

      const url = new URL(body.authorizeUrl!);
      // Generic begin-flow contract: the state carries the userId prefix. How
      // the PKCE challenge rides along is provider-specific (see the shape map).
      expect(url.searchParams.get("state")).toContain(`${userId}:`);
      AUTHORIZE_URL_SHAPE[provider!](url);
    });
  }

  it("credential-less (none) service connects directly", async () => {
    const userId = "dispatch-none";
    const response = await workerFetch(
      new Request(`http://localhost/connect/test_none?userId=${userId}`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connected?: string };
    expect(body.connected).toBe("test_none");

    // The service is now connected (a credential-less row).
    const servicesResponse = await workerFetch(
      new Request(`http://localhost/api/services?userId=${userId}`),
    );
    const services = (await servicesResponse.json()) as {
      services: { service: string }[];
    };
    expect(services.services.some((s) => s.service === "test_none")).toBe(true);
  });

  it("unknown service is rejected with 400", async () => {
    const response = await workerFetch(
      new Request("http://localhost/connect/nope?userId=dispatch-unknown", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("Unknown service 'nope'");
  });

  it("malformed percent-encoding in the path is rejected with 400, not a 500", async () => {
    const response = await workerFetch(
      new Request("http://localhost/connect/%?userId=dispatch-malformed", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("Malformed service name");
  });
});

/**
 * A provider whose OAuth client is not configured is refused at the connect
 * entry. Without the check, `beginAuth` coerces the absent binding into
 * `client_id=undefined` and the engine hands back a well-formed authorize URL
 * whose only feedback is the provider's opaque `invalid_client` page — the
 * failure mode the container path makes easy to hit, since its `.env` carries
 * only the encryption key and internal token by default.
 */
describe("POST /connect/{service} on an unconfigured provider", () => {
  async function connect(
    service: string,
    userId: string,
    envOverride: Partial<Record<string, string | undefined>>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://localhost/connect/${service}?userId=${userId}`, {
        method: "POST",
      }),
      { ...env, ...envOverride } as HabenulaEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it("refuses with the machine-readable code and no authorize URL", async () => {
    const { status, body } = await connect("gmail", "unconfigured-absent", {
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });
    expect(status).toBe(400);
    expect(body.error_code).toBe("PROVIDER_NOT_CONFIGURED");
    // Nothing was minted: no URL for the CLI to open, no flow handle to poll.
    expect(body.authorizeUrl).toBeUndefined();
    expect(body.flow).toBeUndefined();
  });

  it("names the service, the provider, and both missing vars", async () => {
    // The whole point of the refusal is that the operator learns what to set,
    // so the message is asserted, not just the status.
    const { body } = await connect("gmail", "unconfigured-message", {
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
    });
    const error = body.error as string;
    expect(error).toContain("gmail");
    expect(error).toContain("google");
    expect(error).toContain("GOOGLE_CLIENT_ID");
    expect(error).toContain("GOOGLE_CLIENT_SECRET");
    // And where to put them, for both supported deployment paths.
    expect(error).toContain(".env");
    expect(error).toContain(".dev.vars");
  });

  it("refuses a set-but-blank client id", async () => {
    const { status, body } = await connect("gmail", "unconfigured-blank", {
      GOOGLE_CLIENT_ID: "",
    });
    expect(status).toBe(400);
    expect(body.error_code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(body.error as string).toContain("GOOGLE_CLIENT_ID");
  });

  it("refuses when only the secret is absent, naming the secret alone", async () => {
    // The id-only deployment reaches the provider fine and dies at the token
    // exchange, so it is refused up front and the message stays precise.
    const { status, body } = await connect("gmail", "unconfigured-secret", {
      GOOGLE_CLIENT_SECRET: undefined,
    });
    expect(status).toBe(400);
    const error = body.error as string;
    expect(error).toContain("GOOGLE_CLIENT_SECRET");
    expect(error).not.toContain("GOOGLE_CLIENT_ID");
  });

  it("is scoped per provider — an unconfigured Slack does not block gmail", async () => {
    const { status, body } = await connect("gmail", "unconfigured-scope", {
      SLACK_CLIENT_ID: undefined,
      SLACK_CLIENT_SECRET: undefined,
    });
    expect(status).toBe(200);
    expect(body.authorizeUrl).toBeDefined();
  });

  it("mock onboarding still connects with no provider credentials at all", async () => {
    // The mock needs no registered client, so the container path's default
    // `.env` is enough to walk the whole governance loop.
    const { status, body } = await connect("mock_email", "unconfigured-mock", {
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      SLACK_CLIENT_ID: undefined,
      SLACK_CLIENT_SECRET: undefined,
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      MICROSOFT_CLIENT_ID: undefined,
      MICROSOFT_CLIENT_SECRET: undefined,
    });
    expect(status).toBe(200);
    expect(body.authorizeUrl).toBeDefined();
  });
});

/**
 * The OAuth redirect URI is normally derived from the incoming request URL, but
 * an `OAUTH_REDIRECT_BASE_URL` env var overrides the base so the redirect can be
 * pinned to a stable public origin (needed behind a tunnel; see
 * docs/connect/slack.md). The begin-flow value asserted here is the exact
 * string the token exchange recomputes — both call `resolveCallbackUrl` the same
 * way — so pinning the begin-flow value pins the exchange's redirect_uri too.
 */
describe("OAuth redirect base derivation", () => {
  async function redirectUriFor(
    request: Request,
    envOverride?: Partial<HabenulaEnv>,
  ): Promise<string> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      request,
      { ...env, ...envOverride },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string };
    return new URL(body.authorizeUrl).searchParams.get("redirect_uri")!;
  }

  // For the error path: a misconfigured base is an operator mistake, not client
  // input, so the connect entry maps it to a structured 500 (ErrorResponse
  // envelope) naming the bad var — not an opaque runtime throw.
  async function connectErrorFor(
    request: Request,
    envOverride: Partial<HabenulaEnv>,
  ): Promise<{ status: number; error: string }> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, ...envOverride }, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await response.json()) as { error: string };
    return { status: response.status, error: body.error };
  }

  const gmailConnect = () =>
    new Request("http://localhost/connect/gmail?userId=redirect-base-user", {
      method: "POST",
    });
  const slackConnect = () =>
    new Request("http://localhost/connect/slack?userId=redirect-base-slack", {
      method: "POST",
    });

  it("defaults to the incoming request origin when unset", async () => {
    expect(await redirectUriFor(gmailConnect())).toBe(
      "http://localhost/callback/google",
    );
  });

  it("uses OAUTH_REDIRECT_BASE_URL when set — independent of the request origin", async () => {
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL: "https://stable.example.test",
      }),
    ).toBe("https://stable.example.test/callback/google");
  });

  it("uses only the origin of the configured base — any path is discarded", async () => {
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL: "https://stable.example.test/ignored/prefix",
      }),
    ).toBe("https://stable.example.test/callback/google");
  });

  it("preserves an explicit non-default port on the configured base", async () => {
    // The proxy/tunnel shape this feature targets: a non-default port is part
    // of the origin and must survive into the redirect, not be dropped.
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL: "https://proxy.example.test:8443/ignored",
      }),
    ).toBe("https://proxy.example.test:8443/callback/google");
  });

  it("a per-provider base overrides the global for that provider", async () => {
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL: "https://global.example.test",
        OAUTH_REDIRECT_BASE_URL_GOOGLE: "https://google-only.example.test",
      }),
    ).toBe("https://google-only.example.test/callback/google");
  });

  it("a per-provider base also uses only its origin — any path is discarded", async () => {
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL_GOOGLE: "https://g.example.test/ignored/prefix",
      }),
    ).toBe("https://g.example.test/callback/google");
  });

  it("a per-provider base is scoped — other providers stay on their fallback", async () => {
    // The "tunnel Slack, keep Gmail local" case: scoping the override to Slack
    // must not move Google off the request origin.
    const slackScoped = {
      OAUTH_REDIRECT_BASE_URL_SLACK: "https://slack-tunnel.example.test",
    };
    expect(await redirectUriFor(slackConnect(), slackScoped)).toBe(
      "https://slack-tunnel.example.test/callback/slack",
    );
    expect(await redirectUriFor(gmailConnect(), slackScoped)).toBe(
      "http://localhost/callback/google",
    );
  });

  it("the global base still applies to a provider with no per-provider var", async () => {
    // Slack override set, Google override absent → Google inherits the global.
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL: "https://global.example.test",
        OAUTH_REDIRECT_BASE_URL_SLACK: "https://slack-only.example.test",
      }),
    ).toBe("https://global.example.test/callback/google");
  });

  it("a malformed global base fails loud as a structured 500, not a silent pass", async () => {
    const { status, error } = await connectErrorFor(gmailConnect(), {
      OAUTH_REDIRECT_BASE_URL: "not a url",
    });
    expect(status).toBe(500);
    expect(error).toContain(
      "OAUTH_REDIRECT_BASE_URL is not a valid absolute URL",
    );
  });

  it("a malformed per-provider base names that var in the 500 body", async () => {
    const { status, error } = await connectErrorFor(gmailConnect(), {
      OAUTH_REDIRECT_BASE_URL_GOOGLE: "not a url",
    });
    expect(status).toBe(500);
    expect(error).toContain(
      "OAUTH_REDIRECT_BASE_URL_GOOGLE is not a valid absolute URL",
    );
  });

  it("a base that parses but is not an http(s) origin fails loud as a 500", async () => {
    // `localhost:8787` (a missing-scheme slip) parses as an opaque, hostless
    // URL — the guard rejects it rather than emit a nonsense redirect_uri.
    const { status, error } = await connectErrorFor(gmailConnect(), {
      OAUTH_REDIRECT_BASE_URL: "localhost:8787",
    });
    expect(status).toBe(500);
    expect(error).toContain("OAUTH_REDIRECT_BASE_URL must be an http(s) origin");
  });

  it("an empty per-provider base falls through to the global, not to ''", async () => {
    // Empty string is a set-but-blank var; it must not pin the base to "" and
    // silently revert to the request origin — it inherits the global instead.
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL_GOOGLE: "",
        OAUTH_REDIRECT_BASE_URL: "https://global.example.test",
      }),
    ).toBe("https://global.example.test/callback/google");
  });

  it("empty per-provider and empty global fall all the way to the request URL", async () => {
    expect(
      await redirectUriFor(gmailConnect(), {
        OAUTH_REDIRECT_BASE_URL_GOOGLE: "",
        OAUTH_REDIRECT_BASE_URL: "",
      }),
    ).toBe("http://localhost/callback/google");
  });
});

/**
 * The §4.1.3 invariant the two call sites rest on: the begin-flow and the
 * token exchange must derive the *same* redirect_uri. The HTTP tests above pin
 * the begin-flow value; these drive `resolveCallbackUrl` directly with a
 * begin-shaped and a callback-shaped request to prove the callback recomputes
 * the identical string — the property the shared helper exists to guarantee.
 */
describe("resolveCallbackUrl derives begin and callback identically", () => {
  const begin = () =>
    new Request("http://localhost/connect/slack?userId=u", { method: "POST" });
  // The callback arrives as a GET on a different path.
  const callback = (origin = "http://localhost") =>
    new Request(`${origin}/callback/slack?code=x&state=u:abc`);

  it("no base: both derive against their own (matching) request origin", () => {
    const b = resolveCallbackUrl(OAUTH_PROVIDERS.slack, begin(), env, "slack");
    const c = resolveCallbackUrl(
      OAUTH_PROVIDERS.slack,
      callback(),
      env,
      "slack",
    );
    expect(b).toBe("http://localhost/callback/slack");
    expect(c).toBe(b);
  });

  it("with a base: identical and independent of each request's origin", () => {
    const withBase = {
      ...env,
      OAUTH_REDIRECT_BASE_URL_SLACK: "https://tunnel.example.test",
    };
    const b = resolveCallbackUrl(OAUTH_PROVIDERS.slack, begin(), withBase, "slack");
    // A callback that physically arrived on a *different* origin (the tunnel
    // case) still derives the begin-flow's redirect — the point of the base.
    const c = resolveCallbackUrl(
      OAUTH_PROVIDERS.slack,
      callback("http://127.0.0.1:9999"),
      withBase,
      "slack",
    );
    expect(b).toBe("https://tunnel.example.test/callback/slack");
    expect(c).toBe(b);
  });
});

/**
 * The HTTP tests above assert the structured 500 the call sites map a bad base
 * to; these pin the helper's own contract — the throw itself, with the exact
 * offending var named — since that message is what the handlers surface.
 */
describe("resolveCallbackUrl throws on a misconfigured base", () => {
  const req = () =>
    new Request("http://localhost/connect/gmail?userId=u", { method: "POST" });

  it("throws naming the global var when it is unparseable", () => {
    expect(() =>
      resolveCallbackUrl(
        OAUTH_PROVIDERS.google,
        req(),
        { ...env, OAUTH_REDIRECT_BASE_URL: "not a url" },
        "google",
      ),
    ).toThrow("OAUTH_REDIRECT_BASE_URL is not a valid absolute URL");
  });

  it("throws naming the per-provider var when it is unparseable", () => {
    expect(() =>
      resolveCallbackUrl(
        OAUTH_PROVIDERS.google,
        req(),
        { ...env, OAUTH_REDIRECT_BASE_URL_GOOGLE: "not a url" },
        "google",
      ),
    ).toThrow("OAUTH_REDIRECT_BASE_URL_GOOGLE is not a valid absolute URL");
  });

  it("throws when the base parses but is not an http(s) origin", () => {
    expect(() =>
      resolveCallbackUrl(
        OAUTH_PROVIDERS.google,
        req(),
        { ...env, OAUTH_REDIRECT_BASE_URL: "mailto:x" },
        "google",
      ),
    ).toThrow("OAUTH_REDIRECT_BASE_URL must be an http(s) origin");
  });
});
