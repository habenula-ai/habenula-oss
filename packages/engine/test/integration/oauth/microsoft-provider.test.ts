import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../../src/index";
import { MICROSOFT_TOKEN_URL } from "@habenula-ai/tools/services/microsoft/provider";
import { REFRESH_FNS } from "@habenula-ai/tools";
import {
  encryptCredentialForRow,
  makeExpiredCredential,
} from "../../helpers/seed-credential";

/**
 * This suite drives the worker end to end (connect → callback → DO), so it
 * needs the Entra token endpoint to return *a* structurally valid response —
 * not the real captured wire shape. The real captures and the exhaustive
 * mapping assertions (rotation, canonicalization, every failure leg) live with
 * the provider strategy in packages/tools/test/services/microsoft/. These two
 * inline bodies carry only what the flow reads: the tokens the assertions
 * reference and the fully-qualified mixed-case `scope` that pins the worker's
 * canonicalization to `mail.read` / `mail.send`. Keeping them inline (rather
 * than a second copy of the tools fixtures) means there is nothing to keep in
 * sync across the package boundary.
 */
const exchangeFixture = {
  token_type: "Bearer",
  scope: "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send",
  expires_in: 3599,
  access_token: "ms-access-token-exchange",
  refresh_token: "ms-refresh-token-exchange",
};

const refreshFixture = {
  token_type: "Bearer",
  scope: "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send",
  expires_in: 3599,
  access_token: "ms-access-token-rotated",
  refresh_token: "ms-refresh-token-rotated",
};


async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Intercept outbound fetches to Entra's token endpoint.
 * Callers restore globalThis.fetch in afterEach.
 */
function interceptMicrosoftToken(
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
    if (url === MICROSOFT_TOKEN_URL) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
}

/**
 * End-to-end connect → callback for the microsoft provider, driven through
 * the worker. The generic begin-flow contract is covered over the catalog in
 * integration/connect-dispatch; this bundle pins the microsoft-specific
 * details: the common-tenant authorize URL (PKCE challenge, offline_access,
 * select_account), the verifier reaching the exchange, the credential
 * landing encrypted with canonicalized scopes, the misconfigured-scope error
 * path, and single-use rotating-refresh persistence through the DO refresher.
 */
describe("Microsoft OAuth flow (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("/connect/outlook_mail returns a common-tenant authorize URL with PKCE and offline_access", async () => {
    const response = await workerFetch(
      new Request(
        "http://localhost/connect/outlook_mail?userId=microsoft-test-user",
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl?: string };
    expect(body.authorizeUrl).toBeDefined();

    const url = new URL(body.authorizeUrl!);
    expect(url.hostname).toBe("login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(env.MICROSOFT_CLIENT_ID);
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("response_type")).toBe("code");
    // PKCE on the URL, like google (S256).
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // The wire-form scope set: offline_access is provider-level (no refresh
    // token without it), Graph scopes fully qualified.
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("offline_access");
    expect(scope).toContain("https://graph.microsoft.com/Mail.Read");
    expect(scope).toContain("https://graph.microsoft.com/Mail.Send");
    // Account chooser under the common tenant.
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("state")).toContain("microsoft-test-user:");
    expect(url.searchParams.get("redirect_uri")).toContain(
      "/callback/microsoft",
    );
  });

  it("full happy path: connect → callback (mocked Entra) → token stored encrypted with canonical scopes", async () => {
    const userId = "microsoft-happy-path";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/outlook_mail?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    interceptMicrosoftToken(200, exchangeFixture);

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/microsoft?code=test-code&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(200);
    const body = (await callbackResponse.json()) as {
      success: boolean;
      service: string;
    };
    expect(body.success).toBe(true);
    expect(body.service).toBe("outlook_mail");

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "outlook_mail")).toBe(true);

    // Credential stored encrypted — no plaintext token on the row.
    const credential = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'outlook_mail'
      `][0]?.credential ?? null;
    });
    expect(credential).not.toBeNull();
    expect(credential).not.toContain(exchangeFixture.access_token);
    expect(credential).not.toContain(exchangeFixture.refresh_token);

    // The stored scopes are the canonical form — what the scope gate reads.
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "outlook_mail", async (c) => c),
    );
    expect(resolved.scopes).toEqual(["mail.read", "mail.send"]);
  });

  it("the exchange sends the code_verifier through the shared callback", async () => {
    const userId = "microsoft-verifier";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/outlook_mail?userId=${userId}`, {
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
      if (url === MICROSOFT_TOKEN_URL) {
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
        `http://localhost/callback/microsoft?code=verifier-check&state=${encodeURIComponent(fullState)}`,
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
      "/callback/microsoft",
    );
  });

  it("an exchange response without a refresh token fails the callback and stores nothing", async () => {
    const userId = "microsoft-no-offline-access";

    const connectResponse = await workerFetch(
      new Request(`http://localhost/connect/outlook_mail?userId=${userId}`, {
        method: "POST",
      }),
    );
    const connectBody = (await connectResponse.json()) as {
      authorizeUrl: string;
    };
    const fullState = new URL(connectBody.authorizeUrl).searchParams.get(
      "state",
    )!;

    // The signature of a scope set missing offline_access: a credential the
    // refresher could never maintain. Fail the callback, store nothing.
    const { refresh_token: _r, ...noRefresh } = exchangeFixture;
    interceptMicrosoftToken(200, noRefresh);

    const callbackResponse = await workerFetch(
      new Request(
        `http://localhost/callback/microsoft?code=bad-scopes&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(callbackResponse.status).toBe(400);
    const body = (await callbackResponse.json()) as { error: string };
    expect(body.error).toContain("offline_access");

    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "outlook_mail")).toBe(false);
  });

  it("single-use rotation: the new refresh token is persisted by the write-back", async () => {
    const userId = "microsoft-refresh-persistence";

    // An expired outlook_mail credential holding the soon-to-be-spent token.
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      makeExpiredCredential({
        access_token: "scrubbed-ms-access-token-exchange",
        refresh_token: "scrubbed-ms-refresh-token-exchange",
        scopes: ["mail.read", "mail.send"],
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
      if (url === MICROSOFT_TOKEN_URL) {
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
      instance.connectService("outlook_mail", ciphertext);
    });

    // Resolve through the DO's refresher with the catalog's outlook_mail
    // refresh mapping — the same path dispatch takes.
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "outlook_mail", (old) =>
        REFRESH_FNS.outlook_mail!(old, env),
      ),
    );

    expect(refreshBody).not.toBeNull();
    expect(refreshBody!.get("grant_type")).toBe("refresh_token");
    expect(refreshBody!.get("refresh_token")).toBe(
      "scrubbed-ms-refresh-token-exchange",
    );
    expect(resolved.access_token).toBe(refreshFixture.access_token);
    expect(resolved.refresh_token).toBe(refreshFixture.refresh_token);

    // Persistence: a second resolve (no refresh — the rotated credential is
    // fresh) reads the row back and must see the NEW refresh token. If the
    // write-back had dropped it, the next real refresh would present a spent
    // token and brick the connection.
    const persisted = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "outlook_mail", async (c) => c),
    );
    expect(persisted.access_token).toBe(refreshFixture.access_token);
    expect(persisted.refresh_token).toBe(refreshFixture.refresh_token);
  });
});
