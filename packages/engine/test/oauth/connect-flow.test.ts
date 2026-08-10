import type { HabenulaEnv } from "../../src/env";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";

import worker from "../../src/index";

/**
 * Connect-flow lifecycle integration suite:
 * full flows over the Worker's fetch handler against the real DO and
 * SQLite — deny stamping, cancel, supersede, the status derivation's
 * exchange-window ordering, and the mock consent page's deny affordance.
 * The approve path is asserted unchanged end-to-end.
 */

async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** As `workerFetch`, but with env overlaid — used to drive the OAuth redirect base. */
async function workerFetchWith(
  request: Request,
  envOverride: Partial<HabenulaEnv>,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...envOverride }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function stubFor(userId: string) {
  return env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
}

/** Begin a connect; return the authorizeUrl and the flow handle. */
async function beginConnect(
  userId: string,
  service = "mock_email",
): Promise<{ authorizeUrl: string; flow: string }> {
  const response = await workerFetch(
    new Request(`http://localhost/connect/${service}?userId=${userId}`, {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { authorizeUrl: string; flow: string };
}

/** The per-flow status read, as the CLI polls it. */
async function flowStatus(
  userId: string,
  service: string,
  flow: string,
): Promise<string> {
  const response = await workerFetch(
    new Request(
      `http://localhost/api/connect/status?userId=${encodeURIComponent(userId)}&service=${encodeURIComponent(service)}&flow=${encodeURIComponent(flow)}`,
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string };
  return body.status;
}

/** Cancel a flow; returns the `cancelled` observability signal. */
async function cancelFlow(userId: string, flow: string): Promise<boolean> {
  const response = await workerFetch(
    new Request("http://localhost/api/connect/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, flow }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { cancelled: boolean };
  return body.cancelled;
}

/** Fetch the mock consent page for a begun flow. */
async function consentPage(authorizeUrl: string): Promise<string> {
  const response = await workerFetch(
    new Request(authorizeUrl.replace(/^https?:\/\/[^/]+/, "http://localhost")),
  );
  expect(response.status).toBe(200);
  return response.text();
}

/**
 * Extract a link URL from the consent page. Hrefs are HTML-escaped by
 * `renderConsentPage`, so unescape `&amp;` before use.
 */
function extractLink(html: string, marker: string): string {
  const match = html.match(new RegExp(`href="([^"]*${marker}[^"]*)"`));
  expect(match).not.toBeNull();
  return match![1]!.replace(/&amp;/g, "&");
}

async function connectedServices(userId: string): Promise<string[]> {
  const services = await runInDurableObject(stubFor(userId), (instance) =>
    instance.listConnectedServices(),
  );
  return services.map((s) => s.service);
}

/** Count oauth_state rows for a service inside the user's DO. */
async function pendingRowsFor(
  userId: string,
  service: string,
): Promise<number> {
  const rows = await runInDurableObject(stubFor(userId), (instance) => [
    ...instance.sql<{ state_key: string }>`
      SELECT state_key FROM oauth_state WHERE service = ${service}
    `,
  ]);
  return rows.length;
}

describe("connect flow lifecycle", () => {
  it("connect returns the flow handle — the state key's randomPart", async () => {
    const userId = "flow-handle-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(state).toBe(`${userId}:${flow}`);
    // A live pending flow reads pending.
    expect(await flowStatus(userId, "mock_email", flow)).toBe("pending");
  });

  it("the mock consent page carries a Deny link echoing state", async () => {
    const userId = "deny-link-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const html = await consentPage(authorizeUrl);
    const denyUrl = extractLink(html, "error=access_denied");
    const url = new URL(denyUrl);
    expect(url.pathname).toBe("/callback/mock");
    expect(url.searchParams.get("state")).toBe(`${userId}:${flow}`);
  });

  it("a denied consent stamps the flow: status reads denied; cancel then cleans up", async () => {
    const userId = "deny-stamp-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const html = await consentPage(authorizeUrl);
    const denyUrl = extractLink(html, "error=access_denied");

    // Following the deny link keeps the browser-facing 400 but stamps the row.
    const denied = await workerFetch(new Request(denyUrl));
    expect(denied.status).toBe(400);
    expect(await flowStatus(userId, "mock_email", flow)).toBe("denied");

    // The observing CLI deletes via cancel; nothing was ever connected.
    expect(await cancelFlow(userId, flow)).toBe(true);
    expect(await pendingRowsFor(userId, "mock_email")).toBe(0);
    expect(await connectedServices(userId)).not.toContain("mock_email");
  });

  it("a foreign-provider state is not stamped (cross-provider guard)", async () => {
    // A gmail flow's state delivered to /callback/mock?error= must not open a
    // denial channel: gmail's provider strategy is not the mock's, so the
    // stamp is refused and the flow stays pending.
    const userId = "deny-foreign-user";
    const { flow } = await beginConnect(userId, "gmail");
    const response = await workerFetch(
      new Request(
        `http://localhost/callback/mock?error=access_denied&state=${encodeURIComponent(`${userId}:${flow}`)}`,
      ),
    );
    expect(response.status).toBe(400);
    expect(await flowStatus(userId, "gmail", flow)).toBe("pending");
  });

  it("a callback ?error= with an unparseable state 400s without stamping any row", async () => {
    const userId = "deny-unparseable-user";
    const { flow } = await beginConnect(userId);
    const response = await workerFetch(
      new Request(
        "http://localhost/callback/mock?error=access_denied&state=nocolonhere",
      ),
    );
    expect(response.status).toBe(400);
    // The in-flight flow is untouched — no denial channel from garbage state.
    expect(await flowStatus(userId, "mock_email", flow)).toBe("pending");
  });

  it("cancel deletes the row; re-cancel is idempotent; connected_services untouched", async () => {
    const userId = "cancel-user";
    // A pre-existing connection proves cancel never reaches connected_services.
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("slack", "cipher");
    });
    const { flow } = await beginConnect(userId);
    expect(await pendingRowsFor(userId, "mock_email")).toBe(1);

    expect(await cancelFlow(userId, flow)).toBe(true);
    expect(await pendingRowsFor(userId, "mock_email")).toBe(0);
    // Idempotent: a second cancel finds no row and reports false, still 200.
    expect(await cancelFlow(userId, flow)).toBe(false);
    expect(await connectedServices(userId)).toContain("slack");
  });

  it("a cancel racing a genuine consent forfeits the connect (hard abandon)", async () => {
    const userId = "cancel-race-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const html = await consentPage(authorizeUrl);
    const approveUrl = extractLink(html, "code=");

    await cancelFlow(userId, flow);

    // The approve callback finds no state: the existing invalid-state 400,
    // and no connection appears — the user asked to cancel.
    const response = await workerFetch(new Request(approveUrl));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Invalid or expired");
    expect(await connectedServices(userId)).not.toContain("mock_email");
  });

  it("a fresh connect supersedes the same service's pending row", async () => {
    const userId = "supersede-user";
    const first = await beginConnect(userId);
    const second = await beginConnect(userId);
    expect(second.flow).not.toBe(first.flow);

    // Exactly one pending row survives — the new flow's.
    expect(await pendingRowsFor(userId, "mock_email")).toBe(1);
    expect(await flowStatus(userId, "mock_email", second.flow)).toBe("pending");
    // The superseded flow's row is gone; absence + not-connected reads
    // pending (the CLI it belonged to polls to its own timeout — the
    // pre-existing floor).
    expect(await flowStatus(userId, "mock_email", first.flow)).toBe("pending");
  });

  it("supersede spares a denied row: the denied flow stays observable", async () => {
    // Supersede deletes pending rows only (status IS NULL). A flow the user
    // denied is a terminal observation the polling client has not seen yet, so
    // a fresh same-service connect must not erase it — else that client's read
    // silently degrades from denied back to pending (finding #1).
    const userId = "supersede-spares-denied-user";
    const first = await beginConnect(userId);
    const html = await consentPage(first.authorizeUrl);
    const denyUrl = extractLink(html, "error=access_denied");
    expect((await workerFetch(new Request(denyUrl))).status).toBe(400);
    expect(await flowStatus(userId, "mock_email", first.flow)).toBe("denied");

    // A retry begins a new flow for the same service.
    const second = await beginConnect(userId);
    expect(second.flow).not.toBe(first.flow);
    expect(await flowStatus(userId, "mock_email", second.flow)).toBe("pending");
    // The denied flow survived supersede and still reads denied — two rows now
    // coexist (the denied one and the new pending one).
    expect(await flowStatus(userId, "mock_email", first.flow)).toBe("denied");
    expect(await pendingRowsFor(userId, "mock_email")).toBe(2);
  });

  it("a pending row wins over an existing connection (reconnect case)", async () => {
    const userId = "reconnect-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", "cipher");
    });
    const { flow } = await beginConnect(userId);
    // main's list-based poll would report connected on the first poll of any
    // reconnect; the pending row must win until the callback consumes it.
    expect(await flowStatus(userId, "mock_email", flow)).toBe("pending");
  });

  it("KNOWN FLOOR: a superseded reconnect flow reads a false connected", async () => {
    // Pins the reconnect false-`connected` limitation (see the
    // readConnectFlowStatus docstring + oauth-credentials.md Open Questions).
    // Success is a row deletion, so absence + service-connected cannot tell a
    // completed flow from one whose row was dropped without completing. When
    // the service was already connected, a superseded reconnect flow's own
    // handle therefore reports `connected` though it never re-consented. Not
    // the desired answer — locked in until the follow-up tracks per-flow
    // completion; a regression that *fixes* it should update this test.
    const userId = "reconnect-supersede-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", "cipher");
    });
    const first = await beginConnect(userId);
    // While the first flow's row lives, the pending row still wins.
    expect(await flowStatus(userId, "mock_email", first.flow)).toBe("pending");
    // A second connect supersedes it — the first flow's row is now gone.
    const second = await beginConnect(userId);
    expect(second.flow).not.toBe(first.flow);
    // The superseded flow reads the false `connected` (absence + connected),
    // even though it was abandoned; the live flow still reads pending.
    expect(await flowStatus(userId, "mock_email", first.flow)).toBe("connected");
    expect(await flowStatus(userId, "mock_email", second.flow)).toBe("pending");
  });

  it("KNOWN FLOOR: a cancelled reconnect flow reads a false connected", async () => {
    // Same floor via the cancel path: cancelling a reconnect flow drops its
    // row, and the handle then reads the false `connected` because the service
    // was already connected. Cancel never touches connected_services, so the
    // pre-existing connection is (correctly) still present — the falseness is
    // only in attributing it to this abandoned flow.
    const userId = "reconnect-cancel-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", "cipher");
    });
    const { flow } = await beginConnect(userId);
    expect(await cancelFlow(userId, flow)).toBe(true);
    expect(await flowStatus(userId, "mock_email", flow)).toBe("connected");
    expect(await connectedServices(userId)).toContain("mock_email");
  });

  it("row absent + service connected reads connected", async () => {
    const userId = "absent-connected-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", "cipher");
    });
    // No row was ever stored for this handle — the post-consume shape.
    expect(await flowStatus(userId, "mock_email", "no-such-flow")).toBe(
      "connected",
    );
  });

  it("an expired row reads expired", async () => {
    const userId = "expired-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.storeOAuthState("expired-flow", {
        code_verifier: "v",
        code_challenge: "c",
        service: "mock_email",
        auth_code: null,
        created_at: new Date(Date.now() - 700_000).toISOString(),
        expires_at: new Date(Date.now() - 100_000).toISOString(),
        status: null,
      });
    });
    expect(await flowStatus(userId, "mock_email", "expired-flow")).toBe(
      "expired",
    );
  });

  it("a denied stamp outlives expiry (denied wins over expired)", async () => {
    // A flow that lapsed after the user denied must still read denied —
    // the callback stamped it raw, and the derivation checks status first.
    const userId = "denied-expired-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.storeOAuthState("lapsed-denied-flow", {
        code_verifier: "v",
        code_challenge: "c",
        service: "mock_email",
        auth_code: null,
        created_at: new Date(Date.now() - 700_000).toISOString(),
        expires_at: new Date(Date.now() - 100_000).toISOString(),
        status: "denied",
      });
    });
    expect(await flowStatus(userId, "mock_email", "lapsed-denied-flow")).toBe(
      "denied",
    );
  });

  it("a (service, flow) pair whose row is for a different service reads row-absent", async () => {
    // The mismatch guard: a gmail flow's denied row queried under
    // mock_email must not answer with gmail's status — the mismatch is
    // treated as row-absent (pending here, since mock_email isn't connected).
    const userId = "mismatch-user";
    const { flow } = await beginConnect(userId, "gmail");
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.markOAuthFlowDenied(flow);
    });
    expect(await flowStatus(userId, "gmail", flow)).toBe("denied");
    expect(await flowStatus(userId, "mock_email", flow)).toBe("pending");
  });

  it("the approve path is unchanged end-to-end and status flips to connected", async () => {
    const userId = "approve-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const html = await consentPage(authorizeUrl);
    const approveUrl = extractLink(html, "code=");

    const response = await workerFetch(new Request(approveUrl));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; service: string };
    expect(body).toEqual({ success: true, service: "mock_email" });

    expect(await connectedServices(userId)).toContain("mock_email");
    // Row consumed + service connected → the poll's success exit.
    expect(await flowStatus(userId, "mock_email", flow)).toBe("connected");
    expect(await pendingRowsFor(userId, "mock_email")).toBe(0);
  });

  it("deny is reversible: an approve on the same state after a denial still connects", async () => {
    // `denied` is an observation for the status poll, not a lock —
    // `consumeOAuthState` never inspects `status`, so a user who denies, goes
    // back, and approves the same consent re-consents successfully (as long as
    // the observing client has not yet dropped the row via cancel).
    const userId = "deny-then-approve-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const html = await consentPage(authorizeUrl);
    const denyUrl = extractLink(html, "error=access_denied");
    const approveUrl = extractLink(html, "code=");

    const denied = await workerFetch(new Request(denyUrl));
    expect(denied.status).toBe(400);
    expect(await flowStatus(userId, "mock_email", flow)).toBe("denied");

    // Same state, now approved — the stamped row is still consumable.
    const approved = await workerFetch(new Request(approveUrl));
    expect(approved.status).toBe(200);
    expect(await connectedServices(userId)).toContain("mock_email");
    expect(await flowStatus(userId, "mock_email", flow)).toBe("connected");
  });

  it("cancel with a non-JSON body is a 400, not a 500", async () => {
    const response = await workerFetch(
      new Request("http://localhost/api/connect/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all",
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("valid JSON");
  });

  it("a full connect completes with OAUTH_REDIRECT_BASE_URL set — the callback leg honors the base", async () => {
    // The tunnel case end-to-end over the mock provider: the base steers the
    // begin-flow's redirect and the callback recomputes the same base, so the
    // connect completes though no request physically arrives on that origin.
    const userId = "base-e2e-user";
    const baseEnv = { OAUTH_REDIRECT_BASE_URL: "https://tunnel.example.test" };

    const beginRes = await workerFetchWith(
      new Request(`http://localhost/connect/mock_email?userId=${userId}`, {
        method: "POST",
      }),
      baseEnv,
    );
    expect(beginRes.status).toBe(200);
    const { authorizeUrl } = (await beginRes.json()) as { authorizeUrl: string };
    // The base propagated into the begin-flow's derived origin.
    expect(new URL(authorizeUrl).origin).toBe("https://tunnel.example.test");

    // The consent page is served by this Worker; fetch it on localhost (the
    // physical origin) while the base stays the tunnel.
    const consentRes = await workerFetchWith(
      new Request(authorizeUrl.replace(/^https?:\/\/[^/]+/, "http://localhost")),
      baseEnv,
    );
    expect(consentRes.status).toBe(200);
    const approveUrl = extractLink(await consentRes.text(), "code=");

    const approveRes = await workerFetchWith(new Request(approveUrl), baseEnv);
    expect(approveRes.status).toBe(200);
    expect(await connectedServices(userId)).toContain("mock_email");
  });

  it("a malformed base at the callback 500s without consuming the state (resolve precedes consume)", async () => {
    // Regression guard for the resolve-before-consume ordering: a base
    // misconfigured between begin and callback must fail loud yet leave the
    // one-time state intact, so the very same callback completes once fixed.
    const userId = "base-callback-misconfig-user";
    const { authorizeUrl, flow } = await beginConnect(userId);
    const approveUrl = extractLink(await consentPage(authorizeUrl), "code=");

    const bad = await workerFetchWith(new Request(approveUrl), {
      OAUTH_REDIRECT_BASE_URL: "not a url",
    });
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as { error: string }).error).toContain(
      "OAUTH_REDIRECT_BASE_URL is not a valid absolute URL",
    );
    // The state survived — nothing connected, the pending row is intact.
    expect(await connectedServices(userId)).not.toContain("mock_email");
    expect(await pendingRowsFor(userId, "mock_email")).toBe(1);

    // With the misconfig cleared, the same callback now completes.
    const good = await workerFetch(new Request(approveUrl));
    expect(good.status).toBe(200);
    expect(await connectedServices(userId)).toContain("mock_email");
    expect(await flowStatus(userId, "mock_email", flow)).toBe("connected");
  });
});
