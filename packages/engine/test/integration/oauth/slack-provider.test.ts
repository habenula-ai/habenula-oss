import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../../src/index";
import { SLACK_TOKEN_URL } from "@habenula-ai/tools/services/slack/provider";
import { SLACK_USER_SCOPES } from "@habenula-ai/tools/services/slack/slack";
import { REFRESH_FNS } from "@habenula-ai/tools";
import {
  encryptCredentialForRow,
  makeExpiredCredential,
} from "../../helpers/seed-credential";

/**
 * This suite drives the worker end to end (connect → callback → DO), so it
 * needs Slack's token endpoint to return *a* structurally valid response — not
 * the real captured wire shape. The real captures and the exhaustive mapping
 * assertions (the nested-vs-flat parse hazard, every failure leg) live with the
 * provider strategy in packages/tools/test/services/slack/. These two inline
 * bodies carry only what the flow reads, and they preserve the one shape
 * detail this end-to-end path still exercises: the exchange nests the user
 * token under `authed_user`, the refresh returns it flat. Keeping them inline
 * (rather than a second copy of the tools fixtures) means there is nothing to
 * keep in sync across the package boundary.
 */
const exchangeFixture = {
  ok: true,
  authed_user: {
    id: "U0000000000",
    scope: "channels:read,chat:write",
    access_token: "slack-user-access-token-exchange",
    token_type: "user",
    refresh_token: "slack-user-refresh-token-exchange",
    expires_in: 43200,
  },
  access_token: "",
};

const refreshFixture = {
  ok: true,
  access_token: "slack-user-access-token-rotated",
  token_type: "user",
  scope: "channels:read,chat:write",
  expires_in: 43200,
  refresh_token: "slack-user-refresh-token-rotated",
};

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Intercept outbound fetches to Slack's token endpoint.
 * Callers restore globalThis.fetch in afterEach.
 */
function interceptSlackToken(
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
    if (url === SLACK_TOKEN_URL) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

/**
 * End-to-end connect → callback for the slack provider, driven through the
 * worker. The generic begin-flow contract is covered over the catalog in
 * integration/connect-dispatch; this bundle pins the slack-specific details:
 * the authorize URL Slack expects (user_scope, no PKCE, no bot scope), the
 * nested-exchange credential landing encrypted on the row, the ok:false
 * error path, and single-use refresh persistence through the DO refresher.
 */
describe("Slack OAuth flow (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("/connect/slack returns a slack.com authorize URL with user_scope and no PKCE challenge", async () => {
    const response = await workerFetch(
      new Request("http://localhost/connect/slack?userId=slack-test-user", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl?: string };
    expect(body.authorizeUrl).toBeDefined();

    const url = new URL(body.authorizeUrl!);
    expect(url.hostname).toBe("slack.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe(env.SLACK_CLIENT_ID);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    // Comma-joined user scopes; the bot `scope` param is absent entirely.
    expect(url.searchParams.get("user_scope")).toBe(
      SLACK_USER_SCOPES.join(","),
    );
    expect(url.searchParams.get("scope")).toBeNull();
    // Deliberately no PKCE on the URL.
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("code_challenge_method")).toBeNull();

    expect(url.searchParams.get("state")).toContain("slack-test-user:");
    expect(url.searchParams.get("redirect_uri")).toContain("/callback/slack");
  });

  it("full happy path: connect → callback (mocked Slack) → user token stored encrypted", async () => {
    const userId = "slack-happy-path";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/slack?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    interceptSlackToken(200, exchangeFixture);

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/slack?code=test-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const body = (await callbackResponse.json()) as {
      success: boolean;
      service: string;
    };
    expect(body.success).toBe(true);
    expect(body.service).toBe("slack");

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "slack")).toBe(true);

    // Credential stored encrypted — no plaintext token on the row.
    const credential = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'slack'
      `][0]?.credential ?? null;
    });
    expect(credential).not.toBeNull();
    expect(credential).not.toContain(
      exchangeFixture.authed_user.access_token,
    );
    expect(credential).not.toContain(
      exchangeFixture.authed_user.refresh_token,
    );
  });

  it("exchange does not send a code_verifier through the shared callback", async () => {
    // The shared connect entry always generates PKCE and stores the verifier
    // in DO state; the slack strategy must ignore it end to end — a verifier
    // sent without an authorize-time challenge risks an invalid_grant.
    const userId = "slack-no-verifier";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/slack?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

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
      if (url === SLACK_TOKEN_URL) {
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
        `http://localhost/callback/slack?code=verifier-guard&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);

    expect(tokenRequestBody).not.toBeNull();
    expect(tokenRequestBody!.get("code_verifier")).toBeNull();
    expect(tokenRequestBody!.get("redirect_uri")).toContain("/callback/slack");
  });

  it("Slack ok:false on the exchange returns 400", async () => {
    const userId = "slack-exchange-error";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/slack?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    // HTTP 200 + ok:false — the shape Slack actually fails with.
    interceptSlackToken(200, { ok: false, error: "invalid_code" });

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/slack?code=bad-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(400);
    const body = (await callbackResponse.json()) as { error: string };
    expect(body.error).toContain("invalid_code");
  });

  it("single-use refresh: the new refresh token is persisted by the write-back", async () => {
    const userId = "slack-refresh-persistence";

    // An expired slack credential holding the soon-to-be-spent refresh token.
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      makeExpiredCredential({
        access_token: "scrubbed-user-access-token-exchange",
        refresh_token: "scrubbed-user-refresh-token-exchange",
        scopes: SLACK_USER_SCOPES,
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
      if (url === SLACK_TOKEN_URL) {
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
      instance.connectService("slack", ciphertext);
    });

    // Resolve through the DO's refresher with the catalog's slack refresh
    // mapping — the same path dispatch takes.
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "slack", (old) =>
        REFRESH_FNS.slack!(old, env),
      ),
    );

    expect(refreshBody).not.toBeNull();
    expect(refreshBody!.get("grant_type")).toBe("refresh_token");
    expect(refreshBody!.get("refresh_token")).toBe(
      "scrubbed-user-refresh-token-exchange",
    );
    expect(resolved.access_token).toBe(refreshFixture.access_token);
    expect(resolved.refresh_token).toBe(refreshFixture.refresh_token);

    // Persistence: a second resolve (no refresh — the rotated credential is
    // fresh) reads the row back and must see the NEW refresh token. If the
    // write-back had dropped it, the next real refresh would present a spent
    // token and brick the connection.
    const persisted = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "slack", async (c) => c),
    );
    expect(persisted.access_token).toBe(refreshFixture.access_token);
    expect(persisted.refresh_token).toBe(refreshFixture.refresh_token);
  });
});
