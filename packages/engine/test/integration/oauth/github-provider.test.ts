import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../../src/index";
import { GITHUB_TOKEN_URL } from "@habenula-ai/tools/services/github/provider";
import { REFRESH_FNS } from "@habenula-ai/tools";
import {
  encryptCredentialForRow,
  makeExpiredCredential,
} from "../../helpers/seed-credential";

/**
 * Hand-authored token-endpoint fixtures of the documented shape (unlike
 * Slack's live-captured ones — GitHub's response is flat and unambiguous, so
 * a live capture buys nothing and would only risk committing a real token).
 * Every token value is an obvious non-secret placeholder. `scope` is always
 * "" for a GitHub App user token; `refresh_token_expires_in` is present in
 * the response but deliberately unstored.
 */
const exchangeFixture = {
  access_token: "ghu_placeholder-user-access-token-exchange",
  expires_in: 28800,
  refresh_token: "ghr_placeholder-refresh-token-exchange",
  refresh_token_expires_in: 15811200,
  token_type: "bearer",
  scope: "",
};

const refreshFixture = {
  access_token: "ghu_placeholder-user-access-token-refreshed",
  expires_in: 28800,
  refresh_token: "ghr_placeholder-refresh-token-rotated",
  refresh_token_expires_in: 15811200,
  token_type: "bearer",
  scope: "",
};

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Intercept outbound fetches to GitHub's token endpoint.
 * Callers restore globalThis.fetch in afterEach.
 */
function interceptGithubToken(
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
    if (url === GITHUB_TOKEN_URL) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

/**
 * End-to-end connect → callback for the github provider, driven through the
 * worker. The generic begin-flow contract is covered over the catalog in
 * integration/connect-dispatch; this bundle pins the github-specific
 * details: the authorize URL GitHub expects (PKCE challenge, no scope), the
 * verifier reaching the exchange, the credential landing encrypted on the
 * github row, the error path, and single-use refresh persistence through
 * the DO refresher.
 */
describe("GitHub OAuth flow (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("/connect/github returns a github.com authorize URL with a PKCE challenge and no scope", async () => {
    const response = await workerFetch(
      new Request("http://localhost/connect/github?userId=github-test-user", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl?: string };
    expect(body.authorizeUrl).toBeDefined();

    const url = new URL(body.authorizeUrl!);
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    // PKCE on the URL, like google (S256 supported for GitHub Apps).
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // No scope param anywhere: repository access is chosen at App install.
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("state")).toContain("github-test-user:");
    expect(url.searchParams.get("redirect_uri")).toContain("/callback/github");
  });

  it("full happy path: connect → callback (mocked GitHub) → token stored encrypted", async () => {
    const userId = "github-happy-path";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/github?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    interceptGithubToken(200, exchangeFixture);

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/github?code=test-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const body = (await callbackResponse.json()) as {
      success: boolean;
      service: string;
    };
    expect(body.success).toBe(true);
    expect(body.service).toBe("github");

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "github")).toBe(true);

    // Credential stored encrypted — no plaintext token on the row.
    const credential = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'github'
      `][0]?.credential ?? null;
    });
    expect(credential).not.toBeNull();
    expect(credential).not.toContain(exchangeFixture.access_token);
    expect(credential).not.toContain(exchangeFixture.refresh_token);
  });

  it("the exchange sends the code_verifier through the shared callback", async () => {
    // The connect entry generates PKCE into DO state; the github strategy
    // must thread the verifier into the exchange (the opposite of slack's
    // deliberately-verifier-free flow).
    const userId = "github-verifier";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/github?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const authorizeUrl = new URL(connectBody.authorizeUrl);
    const fullState = authorizeUrl.searchParams.get("state")!;
    const challenge = authorizeUrl.searchParams.get("code_challenge")!;

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
      if (url === GITHUB_TOKEN_URL) {
        tokenRequestBody = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify(exchangeFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return original(input, init);
    };

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/github?code=verifier-check&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);

    expect(tokenRequestBody).not.toBeNull();
    const verifier = tokenRequestBody!.get("code_verifier");
    expect(verifier).toBeTruthy();
    // The verifier is the state-stored preimage of the URL's challenge, so
    // it can never equal the challenge itself.
    expect(verifier).not.toBe(challenge);
    expect(tokenRequestBody!.get("redirect_uri")).toContain(
      "/callback/github",
    );
  });

  it("a misconfigured-App exchange response fails the callback and stores nothing", async () => {
    const userId = "github-misconfigured-app";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/github?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    // "Expire user authorization tokens" off: no expires_in, no refresh_token.
    interceptGithubToken(200, {
      access_token: "ghu_placeholder-non-expiring",
      token_type: "bearer",
      scope: "",
    });

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/github?code=bad-app&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(400);
    const body = (await callbackResponse.json()) as { error: string };
    expect(body.error).toContain("Expire user authorization tokens");

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "github")).toBe(false);
  });

  it("single-use refresh: the new refresh token is persisted by the write-back", async () => {
    const userId = "github-refresh-persistence";

    // An expired github credential holding the soon-to-be-spent refresh token.
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      makeExpiredCredential({
        access_token: "ghu_placeholder-user-access-token-exchange",
        refresh_token: "ghr_placeholder-refresh-token-exchange",
        scopes: [],
      }),
    );

    let refreshBody: URLSearchParams | null = null;
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
      if (url === GITHUB_TOKEN_URL) {
        refreshBody = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify(refreshFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return original(input, init);
    };

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      instance.connectService("github", ciphertext);
    });

    // Resolve through the DO's refresher with the catalog's github refresh
    // mapping — the same path dispatch takes.
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "github", (old) =>
        REFRESH_FNS.github!(old, env),
      ),
    );

    expect(refreshBody).not.toBeNull();
    expect(refreshBody!.get("grant_type")).toBe("refresh_token");
    expect(refreshBody!.get("refresh_token")).toBe(
      "ghr_placeholder-refresh-token-exchange",
    );
    expect(resolved.access_token).toBe(refreshFixture.access_token);
    expect(resolved.refresh_token).toBe(refreshFixture.refresh_token);

    // Persistence: a second resolve (no refresh — the rotated credential is
    // fresh) reads the row back and must see the NEW refresh token. If the
    // write-back had dropped it, the next real refresh would present a spent
    // token and brick the connection.
    const persisted = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "github", async (c) => c),
    );
    expect(persisted.access_token).toBe(refreshFixture.access_token);
    expect(persisted.refresh_token).toBe(refreshFixture.refresh_token);
  });
});
