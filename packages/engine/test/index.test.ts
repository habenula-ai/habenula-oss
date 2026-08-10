import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { SERVICES } from "@habenula-ai/tools";

describe("Worker", () => {
  it("returns ok", async () => {
    const request = new Request("http://localhost");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

 it("GET /api/health returns 200 with the health shape, not the /api/* 404", async () => {
    const request = new Request("http://localhost/api/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The status and engine literals are the discriminant the CLI's probe
    // hand-checks by value; the route deliberately carries nothing else — it
    // is unauthenticated, so no build version is disclosed.
    expect(body.status).toBe("ok");
    expect(body.engine).toBe("habenula-engine");
    expect(Object.keys(body).sort()).toEqual(["engine", "status"]);
  });

  it("GET /api/services/catalog enumerates the connectable set (no userId needed)", async () => {
    const request = new Request("http://localhost/api/services/catalog");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    // Exactly the catalog's service ids, in catalog order — the { service }
    // shape is forward-compatible with a future display-label field.
    expect(await response.json()).toEqual({
      services: SERVICES.map((s) => ({ service: s.service })),
    });
  });

  it("POST /api/tools/execute with no toolName → 400 (no silent default)", async () => {
    // Concrete-service routing removed the old `email_list_messages` default;
    // a missing toolName is now a hard 400, never a silently-chosen tool.
    const request = new Request("http://localhost/api/tools/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "demo-user", params: {} }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "toolName is required" });
  });

  it("POST /api/policy is removed (allow-all surface gone)", async () => {
    const request = new Request("http://localhost/api/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "demo-user", decision: "allow" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("GET /api/policy is retained as the read-only query", async () => {
    const request = new Request("http://localhost/api/policy?userId=demo-user");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { effectiveDecision: string };
    // With the standing-allow surface removed, the standing decision is deny.
    expect(body.effectiveDecision).toBe("deny");
  });

  it("POST /api/resolve validates the choice", async () => {
    const request = new Request("http://localhost/api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "demo-user", heldCallId: "x", choice: "bogus" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });

  it("POST /api/resolve with an unknown held call → 404", async () => {
    const request = new Request("http://localhost/api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "demo-user", heldCallId: "nope", choice: "session" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("POST /api/kill returns { killed: true } with no `disconnected` field", async () => {
    // Kill is deny-all only: it clears governance state but preserves
    // connections and credentials, so the response carries no disconnected
    // list. This pins the real worker contract the CLI's KillResult expects.
    const request = new Request("http://localhost/api/kill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "kill-shape-user" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ killed: true });
    expect("disconnected" in body).toBe(false);
  });

  it("POST /api/services/disconnect clears the connection and reports removed:true", async () => {
    const userId = "disconnect-route-user";
    // This is the only worker-level coverage of the /api/services/disconnect
    // route. Connect the service directly on the DO, then disconnect through
    // the route: it deletes the row (credential and all) and reports that a
    // row was actually removed.
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", "cipher");
    });

    const disconnect = (service: string) =>
      workerFetch(
        new Request("http://localhost/api/services/disconnect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, service }),
        }),
      );

    const response = await disconnect("mock_email");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      disconnected: "mock_email",
      removed: true,
    });

    // The service is absent from the live connection list afterward.
    const listResponse = await workerFetch(
      new Request(`http://localhost/api/services?userId=${userId}`),
    );
    const { services } = (await listResponse.json()) as {
      services: { service: string }[];
    };
    expect(services.some((s) => s.service === "mock_email")).toBe(false);

    // A second disconnect is an idempotent no-op and reports removed:false, so
    // the CLI can tell a real disconnect from a typo/never-connected name.
    const repeat = await disconnect("mock_email");
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({
      disconnected: "mock_email",
      removed: false,
    });
  });

  it("POST /api/services/disconnect with no service → 400", async () => {
    const request = new Request("http://localhost/api/services/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "disconnect-route-user" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });
});

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Begin a mock connect and return the full OAuth state carried in the URL. */
async function initiateMockFlow(userId: string): Promise<string> {
  const response = await workerFetch(
    new Request(`http://localhost/connect/mock_email?userId=${userId}`, {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizeUrl?: string };
  return new URL(body.authorizeUrl!).searchParams.get("state")!;
}

/** Load the minted auth_code from the DO state for a given random part. */
async function getAuthCode(userId: string, randomPart: string): Promise<string> {
  const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
  const stateData = await runInDurableObject(stub, (instance) => {
    return instance.loadOAuthState(randomPart);
  });
  expect(stateData).not.toBeNull();
  return stateData!.auth_code!;
}

/**
 * Cross-provider routing guards on the shared connect/callback/authorize
 * dispatcher in index.ts. These are not any single provider's behavior — one
 * handler now serves every provider, so they verify the router rejects
 * mismatched or unmatched deliveries rather than the per-route structure that
 * used to make such deliveries impossible.
 */
describe("cross-provider OAuth routing guards", () => {
  it("mock authorizer rejects a foreign (gmail) state", async () => {
    // The mock authorize server must only render for a mock-provider service.
    // A gmail state (auth_code null) rendered here would produce an approve
    // link with `code=null` that, once clicked, consumes and strands the
    // pending gmail connect. Reject it before that can happen.
    const userId = "mock-authorizer-foreign-state";
    const gmailConnect = await workerFetch(
      new Request(`http://localhost/connect/gmail?userId=${userId}`, {
        method: "POST",
      }),
    );
    const gmailBody = (await gmailConnect.json()) as { authorizeUrl: string };
    const gmailState = new URL(gmailBody.authorizeUrl).searchParams.get("state")!;

    const response = await workerFetch(
      new Request(
        `http://localhost/oauth/mock/authorize?state=${encodeURIComponent(gmailState)}`,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("does not match this authorizer");
  });

  it("google callback rejects a mock state (provider mismatch), leaving the connect recoverable", async () => {
    // The shared callback picks the strategy by which callbackPath matched,
    // but the credential is stored against the state's service. A mock_email
    // state delivered to /callback/google must be rejected before exchange —
    // otherwise a foreign state would run the wrong provider's exchange. The
    // per-route handlers made this structurally impossible; the guard restores
    // it now that one handler serves every provider.
    const userId = "cross-provider-callback";
    const fullState = await initiateMockFlow(userId);

    const colonIdx = fullState.indexOf(":");
    const randomPart = fullState.slice(colonIdx + 1);
    const code = await getAuthCode(userId, randomPart);

    const response = await workerFetch(
      new Request(
        `http://localhost/callback/google?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("does not match this callback");

    // The mock service must not have been connected via the wrong callback.
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services.some((s) => s.service === "mock_email")).toBe(false);

    // The mismatched callback must not have consumed the state: the real
    // /callback/mock still completes the in-flight connect. This is the guard
    // ordering (agreement check before the one-time consume) — a wrong-provider
    // delivery no longer strands the pending connect.
    const recovery = await workerFetch(
      new Request(
        `http://localhost/callback/mock?code=${code}&state=${encodeURIComponent(fullState)}`,
      ),
    );
    expect(recovery.status).toBe(200);
    const recovered = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(recovered.some((s) => s.service === "mock_email")).toBe(true);
  });

  it("an unmatched /callback/* path returns 404, not a silent ok", async () => {
    // A provider redirecting to a removed callback (e.g. an old /callback/gmail
    // still registered in a console) must get a diagnostic, not the fall-through
    // 200 that would leave the CLI polling to timeout with no signal.
    const response = await workerFetch(
      new Request("http://localhost/callback/gmail?code=x&state=y%3Az"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("restart connect");
  });
});
