import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../../src/index";
import {
  decryptCredential,
  importEncryptionKey,
} from "@habenula-ai/credentials";
import { CALENDAR_SCOPES } from "@habenula-ai/tools/services/google/calendar";
import { gmail } from "@habenula-ai/tools/services/google/gmail";
import { GOOGLE_TOKEN_URL } from "@habenula-ai/tools/services/google/provider";

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Begin the Gmail connect flow through the single connect entry
 * (`POST /connect/gmail`), which returns the provider authorize URL as JSON.
 * Returns the full OAuth state string carried in that URL.
 */
async function initiateGmail(userId: string): Promise<string> {
  const response = await workerFetch(
    new Request(`http://localhost/connect/gmail?userId=${userId}`, {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizeUrl?: string };
  expect(body.authorizeUrl).toBeDefined();
  return new URL(body.authorizeUrl!).searchParams.get("state")!;
}

/**
 * Intercept outbound fetches to Google's token endpoint.
 * Saves/restores globalThis.fetch around each test.
 */
function interceptGoogleToken(
  status: number,
  body: Record<string, unknown>,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === GOOGLE_TOKEN_URL) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

/**
 * End-to-end connect → callback OAuth flow for the google provider, driven
 * through the worker. The generic begin-flow contract (state prefix, per-provider
 * PKCE placement) is covered over the catalog in integration/connect-dispatch;
 * this bundle pins the google-specific detail: the authorize URL Google expects,
 * the null auth_code state shape, callback validation and replay, the token
 * exchange error path, and the redirect_uri thread the mock leg cannot exercise.
 */
describe("Gmail OAuth flow (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("/connect/gmail returns an authorize URL to accounts.google.com with correct params", async () => {
    const response = await workerFetch(
      new Request("http://localhost/connect/gmail?userId=gmail-test-user", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl?: string };
    expect(body.authorizeUrl).toBeDefined();

    const url = new URL(body.authorizeUrl!);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    // Assert the Worker echoed whatever client_id it was configured with,
    // not the specific wrangler.toml placeholder value. Devs who set real
    // GOOGLE_CLIENT_ID in .dev.vars (to test the live Gmail path) would
    // otherwise break this test locally even though CI stays green.
    expect(url.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    // Tier 3: the least-privilege non-redundant
    // request set — readonly + send + modify, and never gmail.compose
    // (modify already authorizes drafts).
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("scope")).toContain("gmail.modify");
    expect(url.searchParams.get("scope")).not.toContain("gmail.compose");
    // Per-service consent: include_granted_scopes is
    // deliberately absent, so a consent returns a credential scoped to
    // exactly the requested set — connecting another Google service never
    // widens this one's stored token.
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
    // The complete-scope-set invariant the dropped parameter rests on: the
    // authorize request carries Gmail's full connect.scopes set, never a
    // delta. A delta request would silently drop every previously granted
    // scope from the next credential.
    const gmailScopes =
      gmail.connect.type === "oauth" ? gmail.connect.scopes : [];
    expect(gmailScopes.length).toBeGreaterThan(0);
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      [...gmailScopes].sort(),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // State contains userId
    const state = url.searchParams.get("state");
    expect(state).not.toBeNull();
    expect(state).toContain("gmail-test-user:");

    // Redirect URI points to our callback
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toContain("/callback/google");
  });

  it("full happy path: connect → callback (mocked Google) → credential stored → service connected", async () => {
    const userId = "gmail-happy-path";

    // Step 1: Initiate flow
    const fullState = await initiateGmail(userId);

    // Step 2: Intercept Google token exchange
    interceptGoogleToken(200, {
      access_token: "ya29.gmail-real-token",
      refresh_token: "1//gmail-real-refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
    });

    // Step 3: Simulate Google redirect to callback
    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/test-auth-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const body = (await callbackResponse.json()) as {
      success: boolean;
      service: string;
    };
    expect(body.success).toBe(true);
    expect(body.service).toBe("gmail");

    // Verify service connected in DO
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "gmail")).toBe(true);

    // Verify credential stored encrypted on the connection's row (not KV)
    const credential = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'gmail'
      `][0]?.credential ?? null;
    });
    expect(credential).not.toBeNull();
    // Stored value must not contain plaintext tokens
    expect(credential).not.toContain("ya29.gmail-real-token");
    expect(credential).not.toContain("1//gmail-real-refresh");
  });

  it("OAuth state stores null auth_code for Gmail flow", async () => {
    const userId = "gmail-null-authcode";

    const fullState = await initiateGmail(userId);
    const randomPart = fullState.slice(fullState.indexOf(":") + 1);

    // Verify the stored OAuth state has null auth_code
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const stateData = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState(randomPart);
    });
    expect(stateData).not.toBeNull();
    expect(stateData!.auth_code).toBeNull();
    expect(stateData!.service).toBe("gmail");
    expect(stateData!.code_verifier).toBeTruthy();
    expect(stateData!.code_challenge).toBeTruthy();
  });

  it("invalid state returns 400", async () => {
    const response = await workerFetch(
      new Request(
        "http://localhost/callback/google?code=4/fake&state=nobody%3Anonexistent",
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid or expired");
  });

  it("replay: second callback with same state returns 400", async () => {
    const userId = "gmail-replay";

    const fullState = await initiateGmail(userId);

    // Intercept Google endpoint
    interceptGoogleToken(200, {
      access_token: "ya29.replay-test",
      refresh_token: "1//replay-refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
    });

    // First callback succeeds
    const first = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/test-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(first.status).toBe(200);

    // Replay returns 400 — state consumed atomically
    const second = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/test-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("Invalid or expired");
  });

  it("token exchange re-sends the exact redirect_uri the begin-flow sent", async () => {
    // The one regression the mock leg cannot catch: Google's token exchange
    // rejects a redirect_uri that differs from the authorize-time value
    // (RFC 6749 §4.1.3), so the shared callback must hand exchangeCode the
    // same /callback/google URL beginAuth sent. If the strategy refactor
    // dropped that thread, every mock test would stay green while real Gmail
    // connect broke with redirect_uri_mismatch.
    const userId = "gmail-redirect-uri-guard";

    // Step 1: begin the flow and capture the authorize-time redirect_uri.
    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/gmail?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const authorizeUrl = new URL(connectBody.authorizeUrl);
    const authorizeRedirectUri = authorizeUrl.searchParams.get("redirect_uri")!;
    expect(new URL(authorizeRedirectUri).pathname).toBe("/callback/google");
    const fullState = authorizeUrl.searchParams.get("state")!;

    // Step 2: intercept the token exchange, capturing the outgoing body.
    let tokenRequestBody: URLSearchParams | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === GOOGLE_TOKEN_URL) {
        tokenRequestBody = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({
            access_token: "ya29.redirect-guard",
            refresh_token: "1//redirect-guard",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return original(input, init);
    };

    // Step 3: complete the flow through the shared callback.
    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/guard-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);

    // The exchange body carried exactly the authorize-time redirect_uri.
    expect(tokenRequestBody).not.toBeNull();
    expect(tokenRequestBody!.get("redirect_uri")).toBe(authorizeRedirectUri);
  });

  it("Google token exchange error returns 400", async () => {
    const userId = "gmail-exchange-error";

    const fullState = await initiateGmail(userId);

    interceptGoogleToken(400, {
      error: "invalid_grant",
      error_description: "Code has expired.",
    });

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/expired-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(400);
    const body = (await callbackResponse.json()) as { error: string };
    expect(body.error).toContain("Google token exchange failed");
  });

  it("missing code parameter returns 400", async () => {
    const response = await workerFetch(
      new Request("http://localhost/callback/google?state=user%3Atest"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Missing code or state");
  });
});

/**
 * Per-service consent scoping: google_calendar is
 * the second real service on the shared google provider. Its connect must
 * request Calendar's complete scope set with include_granted_scopes absent,
 * and the credential it stores must hold Calendar-only scopes — never the
 * cross-service union a prior Gmail grant used to widen it to.
 */
describe("google_calendar on the shared google provider (per-service scoping)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a Calendar consent stores Calendar-only scopes despite a prior Gmail grant", async () => {
    const userId = "calendar-per-service-scopes";

    // A prior Gmail grant on the same account — the fixture the old
    // include_granted_scopes union would have leaked into Calendar's token.
    const gmailState = await initiateGmail(userId);
    interceptGoogleToken(200, {
      access_token: "ya29.gmail-token",
      refresh_token: "1//gmail-refresh",
      expires_in: 3600,
      scope:
        "https://www.googleapis.com/auth/gmail.readonly " +
        "https://www.googleapis.com/auth/gmail.send " +
        "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
    const gmailCallback = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/gmail-code&state=${encodeURIComponent(gmailState)}`,
      ),
    );
    expect(gmailCallback.status).toBe(200);

    // Calendar connect through the same provider: the authorize request
    // carries Calendar's complete scope set, include_granted_scopes absent.
    const connectResponse = await workerFetch(
      new Request(
        `http://localhost/connect/google_calendar?userId=${userId}`,
        { method: "POST" },
      ),
    );
    expect(connectResponse.status).toBe(200);
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const authorizeUrl = new URL(connectBody.authorizeUrl);
    expect(authorizeUrl.hostname).toBe("accounts.google.com");
    expect(authorizeUrl.searchParams.get("include_granted_scopes")).toBeNull();
    expect(authorizeUrl.searchParams.get("scope")!.split(" ").sort()).toEqual(
      [...CALENDAR_SCOPES].sort(),
    );
    const calendarState = authorizeUrl.searchParams.get("state")!;

    // Without the union parameter Google returns exactly the requested set.
    interceptGoogleToken(200, {
      access_token: "ya29.calendar-token",
      refresh_token: "1//calendar-refresh",
      expires_in: 3600,
      scope: CALENDAR_SCOPES.join(" "),
      token_type: "Bearer",
    });
    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=4/calendar-code&state=${encodeURIComponent(calendarState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const callbackBody = (await callbackResponse.json()) as {
      success: boolean;
      service: string;
    };
    expect(callbackBody.success).toBe(true);
    expect(callbackBody.service).toBe("google_calendar");

    // The stored Calendar credential holds Calendar's scopes and nothing of
    // Gmail's; both rows coexist, each scoped to its own service.
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) =>
      instance.listConnectedServices(),
    );
    expect(services.some((s) => s.service === "gmail")).toBe(true);
    expect(services.some((s) => s.service === "google_calendar")).toBe(true);

    const ciphertext = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services
        WHERE service = 'google_calendar'
      `][0]?.credential ?? null;
    });
    expect(ciphertext).not.toBeNull();
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const credential = await decryptCredential(
      encKey,
      JSON.parse(ciphertext!) as { ct: string; iv: string },
    );
    expect([...credential.scopes].sort()).toEqual([...CALENDAR_SCOPES].sort());
    for (const scope of credential.scopes) {
      expect(scope).not.toContain("gmail");
    }
  });
});
