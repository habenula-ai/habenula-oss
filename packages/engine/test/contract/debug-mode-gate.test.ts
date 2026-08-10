import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import { stubFor } from "../helpers/http";

/**
 * The DEBUG_MODE gate on `POST /api/tools/execute`. The route drives a
 * governed tool call with no conversation behind it — a debugging surface,
 * never an intended feature — so it ships off. The gate is
 * fail-closed: only exactly "true" enables, and a gated-off route is
 * indistinguishable from an absent one (404). The suite turns the gate on via
 * the vitest bindings injection (which is why every other test can drive the
 * route); these tests exercise the off states by overriding the env object
 * passed to the fetch handler — the same pattern as the visual-model gate.
 */

async function executeWith(
  debugMode: string | undefined,
  userId: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, DEBUG_MODE: debugMode };
  const response = await worker.fetch(
    new Request("http://localhost/api/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        toolName: "mock_email_list",
        params: { label: "INBOX" },
      }),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("debug-mode gating", () => {
  it("unset: the route 404s (fail-closed), and nothing is parked or audited", async () => {
    const userId = "debug-mode-gate-unset-user";
    const res = await executeWith(undefined, userId);
    expect(res.status).toBe(404);
    // A refused request must leave no trace: no session minted, no held call
    // parked, no audit row — the gate sits ahead of every DO effect.
    const status = await runInDurableObject(stubFor(userId), (instance) =>
      instance.readStatus(),
    );
    expect(status.session).toBeNull();
    expect(status.held).toEqual([]);
    expect(status.auditTail).toBeNull();
  });

  it('"false" and non-"true" junk values stay closed', async () => {
    for (const value of ["false", "TRUE", "1", "yes", ""]) {
      const res = await executeWith(value, "debug-mode-gate-junk-user");
      expect(res.status, `DEBUG_MODE=${value}`).toBe(404);
    }
  });

  it('"true": the route answers with a governance decision', async () => {
    const res = await executeWith("true", "debug-mode-gate-open-user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { decision: string };
    // Un-connected service → the pipeline denies; the point here is the gate
    // admitted the request and governance answered, not what it answered.
    expect(["allow", "deny", "pending"]).toContain(body.decision);
  });
});
