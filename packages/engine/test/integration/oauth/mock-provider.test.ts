import type { HabenulaEnv } from "../../../src/env";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../../src/index";
import {
  generateMockAuthCode,
  generateMockTokens,
  mockProvider,
  renderConsentPage,
} from "@habenula-ai/tools/services/mock/provider";
import {
  generateCodeChallenge,
  generateCodeVerifier,
} from "@habenula-ai/tools";
import type { OAuthStateData } from "../../../src/oauth/types";

describe("Mock OAuth provider", () => {
  describe("generateMockAuthCode", () => {
    it("starts with mock_authcode_ prefix", () => {
      const code = generateMockAuthCode();
      expect(code).toMatch(/^mock_authcode_[0-9a-f]{32}$/);
    });

    it("produces unique values", () => {
      const a = generateMockAuthCode();
      const b = generateMockAuthCode();
      expect(a).not.toBe(b);
    });
  });

  describe("generateMockTokens", () => {
    it("returns StoredCredential shape with mock prefixes", () => {
      const tokens = generateMockTokens(["email.read"]);
      expect(tokens.access_token).toMatch(/^mock_access_[0-9a-f]{32}$/);
      expect(tokens.refresh_token).toMatch(/^mock_refresh_[0-9a-f]{32}$/);
      expect(tokens.scopes).toEqual(["email.read"]);
    });

    it("has expiry in the future", () => {
      const tokens = generateMockTokens(["email.read"]);
      const now = Math.floor(Date.now() / 1000);
      expect(tokens.expiry_unix).toBeGreaterThan(now);
    });

    it("mints with the scopes it is given (catalog is the source of truth)", () => {
      const scopes = ["email.read", "email.send"];
      const tokens = generateMockTokens(scopes);
      expect(tokens.scopes).toEqual(scopes);
    });

    it("produces unique tokens", () => {
      const a = generateMockTokens(["email.read"]);
      const b = generateMockTokens(["email.read"]);
      expect(a.access_token).not.toBe(b.access_token);
      expect(a.refresh_token).not.toBe(b.refresh_token);
    });
  });

  describe("exchangeCode", () => {
    /** Build an OAuth state whose PKCE challenge matches its verifier. */
    async function validState(): Promise<OAuthStateData> {
      const code_verifier = generateCodeVerifier();
      const code_challenge = await generateCodeChallenge(code_verifier);
      return {
        code_verifier,
        code_challenge,
        service: "mock_email",
        auth_code: generateMockAuthCode(),
        created_at: "2026-01-01T00:00:00.000Z",
        expires_at: "9999-01-01T00:00:00.000Z",
        status: null,
      };
    }

    it("threads the caller's scopes into the minted credential", async () => {
      // The regression this guards: the mock used to hardcode ["email.read"],
      // so editing the service's catalog scopes had no effect. The shared
      // callback now passes connect.scopes through — a mock with different
      // declared scopes must mint a credential carrying them.
      const state = await validState();
      const scopes = ["email.read", "email.send"];
      const creds = await mockProvider.exchangeCode({} as HabenulaEnv, {
        query: new URLSearchParams({ code: state.auth_code! }),
        state,
        redirectUri: "http://localhost/callback/mock",
        scopes,
      });
      expect(creds.scopes).toEqual(scopes);
    });

    it("rejects a code that does not match the state's auth_code", async () => {
      const state = await validState();
      await expect(
        mockProvider.exchangeCode({} as HabenulaEnv, {
          query: new URLSearchParams({ code: "wrong" }),
          state,
          redirectUri: "http://localhost/callback/mock",
          scopes: ["email.read"],
        }),
      ).rejects.toThrow("Invalid authorization code");
    });
  });

  describe("renderConsentPage", () => {
    const html = renderConsentPage({
      service: "mock_email",
      scopes: ["email.read"],
      callbackUrl: "http://localhost:8787/callback/mock",
      state: "demo-user:abc123",
      code: "mock_authcode_def456",
    });

    it("contains the service name", () => {
      expect(html).toContain("mock_email");
    });

    it("renders the declared scopes, not hardcoded copy", () => {
      expect(html).toContain("email.read");
    });

    it("contains an approve link with code and state", () => {
      expect(html).toContain("href=");
      expect(html).toContain("code=mock_authcode_def456");
      expect(html).toContain("state=demo-user%3Aabc123");
    });

    it("is valid HTML with doctype", () => {
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain("</html>");
    });

    it("escapes HTML in service name and scopes", () => {
      const xss = renderConsentPage({
        service: '<script>alert("xss")</script>',
        scopes: ['<img src=x onerror="alert(1)">'],
        callbackUrl: "http://localhost/callback",
        state: "user:key",
        code: "code",
      });
      expect(xss).not.toContain("<script>");
      expect(xss).toContain("&lt;script&gt;");
      expect(xss).not.toContain("<img src=x");
    });
  });
});

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Run the connect step and extract state from the returned authorize URL.
 * The single connect entry (`POST /connect/{service}`) returns the provider
 * authorize URL as JSON rather than a 302 redirect.
 */
async function initiateFlow(userId = "oauth-test-user"): Promise<{
  fullState: string;
  authorizeUrl: URL;
}> {
  const response = await workerFetch(
    new Request(`http://localhost/connect/mock_email?userId=${userId}`, {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);

  const body = (await response.json()) as { authorizeUrl?: string };
  expect(body.authorizeUrl).toBeDefined();

  const authorizeUrl = new URL(body.authorizeUrl!);
  const fullState = authorizeUrl.searchParams.get("state");
  expect(fullState).not.toBeNull();
  expect(fullState).toContain(":");

  return { fullState: fullState!, authorizeUrl };
}

/**
 * Load the auth code from the DO state (simulates what the consent page shows).
 */
async function getAuthCode(
  userId: string,
  randomPart: string,
): Promise<string> {
  const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
  const stateData = await runInDurableObject(stub, (instance) => {
    return instance.loadOAuthState(randomPart);
  });
  expect(stateData).not.toBeNull();
  return stateData!.auth_code!;
}

/**
 * End-to-end connect → consent → callback flow for the mock provider, driven
 * through the worker. The mock simulates the authorization server Google hosts
 * off-origin, so its consent page and minted auth_code are exercised here. The
 * cross-provider routing guards (foreign state to the mock authorizer, mock
 * state to the google callback, unmatched /callback/*) live with the shared
 * dispatcher in test/index.test.ts, not in this provider bundle.
 */
describe("Mock OAuth flow (integration)", () => {
  it("full happy path: connect → callback → credential stored → service connected", async () => {
    const userId = "oauth-happy-path";
    const { fullState } = await initiateFlow(userId);

    const colonIdx = fullState.indexOf(":");
    const randomPart = fullState.slice(colonIdx + 1);
    const code = await getAuthCode(userId, randomPart);

    // Hit the callback
    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const body = (await callbackResponse.json()) as { success: boolean; service: string };
    expect(body.success).toBe(true);
    expect(body.service).toBe("mock_email");

    // Verify service is connected in DO
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "mock_email")).toBe(true);

    // Verify credential stored on the connection's row (encrypted, not KV)
    const credential = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'mock_email'
      `][0]?.credential ?? null;
    });
    expect(credential).not.toBeNull();
    expect(credential).not.toContain("mock_access_");
    expect(credential).not.toContain("mock_refresh_");
  });

  it("authorize endpoint renders consent page with approve link", async () => {
    const userId = "oauth-consent-page";
    const { fullState, authorizeUrl } = await initiateFlow(userId);

    const authorizeResponse = await workerFetch(
      new Request(authorizeUrl.toString()),
    );
    expect(authorizeResponse.status).toBe(200);
    expect(authorizeResponse.headers.get("Content-Type")).toContain("text/html");

    const html = await authorizeResponse.text();
    // The page renders the concrete service and its declared catalog scopes,
    // not hardcoded email copy.
    expect(html).toContain("mock_email");
    expect(html).toContain("email.read");
    expect(html).toContain("Approve");
    expect(html).toContain(`state=${encodeURIComponent(fullState)}`);
  });

  it("invalid state returns 400", async () => {
    const response = await workerFetch(
      new Request(
        "http://localhost/callback/mock?code=fake&state=nobody%3Anonexistent",
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid or expired");
  });

  it("invalid code returns 400", async () => {
    const userId = "oauth-bad-code";
    const { fullState } = await initiateFlow(userId);

    const response = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=wrong_code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid authorization code");
  });

  it("replay: second callback with same state returns 400", async () => {
    const userId = "oauth-replay";
    const { fullState } = await initiateFlow(userId);

    const colonIdx = fullState.indexOf(":");
    const randomPart = fullState.slice(colonIdx + 1);
    const code = await getAuthCode(userId, randomPart);

    // First callback succeeds
    const first = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(first.status).toBe(200);

    // Replay returns 400 — state consumed atomically
    const second = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("Invalid or expired");
  });

  it("PKCE: callback verifies S256(code_verifier) matches stored challenge", async () => {
    const userId = "oauth-pkce-verify";
    const { fullState } = await initiateFlow(userId);

    const colonIdx = fullState.indexOf(":");
    const randomPart = fullState.slice(colonIdx + 1);
    const code = await getAuthCode(userId, randomPart);

    // Tamper with the stored code_verifier to make PKCE fail
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      // Overwrite with a mismatched verifier — challenge won't match
      instance.sql`
        UPDATE oauth_state SET code_verifier = 'tampered-verifier' WHERE state_key = ${randomPart}
      `;
    });

    const response = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("PKCE verification failed");
  });

  it("executeTool works after OAuth connect", async () => {
    const userId = "oauth-then-tool";
    const { fullState } = await initiateFlow(userId);

    const colonIdx = fullState.indexOf(":");
    const randomPart = fullState.slice(colonIdx + 1);
    const code = await getAuthCode(userId, randomPart);

    // Complete OAuth flow
    await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );

    // Grant the one action this test executes. A task grant is session-scoped
    // so resolve the DO's single active session and mint the grant
    // under it; the later /api/tools/execute call resolves the same session
    // (the DO owns the one session) and is authorized.
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createTaskGrant("mock_email", "list", "INBOX", sessionId);
    });

    // Execute tool through full governance pipeline
    const toolResponse = await workerFetch(
      new Request("http://localhost/api/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          toolName: "mock_email_list",
          params: { label: "INBOX", maxResults: 3 },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    // The narrowed /api/tools/execute wire: decision is
    // top-level; the internal governance blob no longer ships.
    const result = (await toolResponse.json()) as {
      decision: string;
      execution?: { success: boolean; data: { messages: unknown[] } };
    };
    expect(result.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);
    expect(result.execution?.data.messages).toHaveLength(3);
  });
});
