import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";

/**
 * session.end audit event + lazy
 * expiry reaper.
 *
 * A held call has no clock of its own: it lives and dies with its session
 * (started_at + 90 min). There is no alarm — expiry is enforced at read time,
 * and the durable terminal records (the held call's denied outcome resolving
 * its `pending`, and the `session.end` event) are written lazily on the next
 * DO activity that observes the session expired, OR eagerly on kill. Both rows
 * are stamped with the EFFECTIVE expiry instant (started_at + 90 min), not the
 * wake time, and both carry the timed-out session's id.
 *
 * Real DO, no platform mocking (Hard Invariant #5).
 */

const SESSION_LIFETIME_MS = 90 * 60 * 1000;

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

type Stub = ReturnType<typeof getStub>;

// Only the tests that actually execute a tool (decision `allow`) seed a
// credential (seedCiphertext); held-only tests connect the service
// credential-less.

/**
 * Park a held call via the direct executeTool path and return its id.
 *
 * `credential` is the row ciphertext; pass it only when a LATER call on the same
 * stub will execute a granted tool and need to resolve the credential. The held
 * call parked here never executes, so for held-only tests it is left undefined.
 */
async function parkHeldCall(
  stub: Stub,
  userId: string,
  label = "INBOX",
  credential?: string,
): Promise<{ heldCallId: string; sessionId: string }> {
  return runInDurableObject(stub, async (instance) => {
    instance.connectService("mock_email", credential);
    const sessionId = instance.resolveActiveSession({ userId, agentId: "agent-1" });
    const result = await instance.executeTool({
      toolName: "mock_email_list",
      toolParams: { label },
      userId,
      agentId: "agent-1",
    });
    return { heldCallId: result.held!.heldCallId, sessionId };
  });
}

/** Backdate a session's started_at so it sits past the 90-min cap. */
async function expireSession(stub: Stub, sessionId: string) {
  await runInDurableObject(stub, (instance) => {
    const past = new Date(Date.now() - (SESSION_LIFETIME_MS + 60_000)).toISOString();
    instance.sql`UPDATE session_state SET started_at = ${past} WHERE session_id = ${sessionId}`;
  });
}

describe("session.end + lazy expiry reaper", () => {
  it("kill writes session.end (reason kill) and resolves the held call's pending entry", async () => {
    const userId = "kill-end-user";
    const stub = getStub();
    const { sessionId } = await parkHeldCall(stub, userId);

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    const rows = await runInDurableObject(stub, (instance) =>
      instance.sql<{
        tool_name: string;
        decision: string;
        outcome: string;
        error_message: string | null;
        decision_entry_id: string | null;
        session_id: string;
      }>`
        SELECT tool_name, decision, outcome, error_message, decision_entry_id, session_id
        FROM audit_log ORDER BY sequence_num
      `,
    );

    // session.end written, reason 'kill'.
    const end = rows.find((r) => r.tool_name === "session.end");
    expect(end).toBeDefined();
    expect(end!.outcome).toBe("timeout");
    expect(end!.error_message).toBe("kill");
    expect(end!.session_id).toBe(sessionId);

    // The held call's pending entry now has a terminal outcome resolving it.
    const pending = rows.find(
      (r) => r.tool_name === "mock_email_list" && r.decision === "pending",
    );
    expect(pending).toBeDefined();
    const terminal = rows.find(
      (r) => r.tool_name === "mock_email_list" && r.outcome === "timeout",
    );
    expect(terminal).toBeDefined();

    // Held call swept; only the deny floor remains in policy.
    const held = await runInDurableObject(stub, (instance) =>
      instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    );
    expect(held).toHaveLength(0);
  });

  it("lazy reaper stamps the effective expiry instant (not wake time), same session, one pass", async () => {
    const userId = "lazy-stamp-user";
    const stub = getStub();
    const { sessionId } = await parkHeldCall(stub, userId);

    // Capture started_at, then age the session past the cap.
    const startedAt = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ started_at: string }>`
        SELECT started_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.started_at,
    );
    await expireSession(stub, sessionId);
    const startedAtMs = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ started_at: string }>`
        SELECT started_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.started_at,
    );
    const effectiveExpiry = new Date(
      new Date(startedAtMs).getTime() + SESSION_LIFETIME_MS,
    ).toISOString();

    // Touch the DO well after the effective expiry → reaper fires.
    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());

    const rows = await runInDurableObject(stub, (instance) =>
      instance.sql<{
        tool_name: string;
        outcome: string;
        timestamp: string;
        session_id: string;
      }>`
        SELECT tool_name, outcome, timestamp, session_id FROM audit_log
        WHERE tool_name IN ('session.end', 'mock_email_list') AND outcome = 'timeout'
        ORDER BY sequence_num
      `,
    );

    const end = rows.find((r) => r.tool_name === "session.end");
    const heldTimeout = rows.find((r) => r.tool_name === "mock_email_list");
    expect(end).toBeDefined();
    expect(heldTimeout).toBeDefined();
    // Both stamped with the effective expiry instant, not the (later) wake time.
    expect(end!.timestamp).toBe(effectiveExpiry);
    expect(heldTimeout!.timestamp).toBe(effectiveExpiry);
    expect(end!.timestamp).not.toBe(startedAt); // sanity: not the start
    // Both carry the timed-out session id.
    expect(end!.session_id).toBe(sessionId);
    expect(heldTimeout!.session_id).toBe(sessionId);

    // The held row is gone after reaping.
    const held = await runInDurableObject(stub, (instance) =>
      instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    );
    expect(held).toHaveLength(0);
  });

  it("the reaper is idempotent — a second pass writes nothing new", async () => {
    const userId = "reaper-idem-user";
    const stub = getStub();
    const { sessionId } = await parkHeldCall(stub, userId);
    await expireSession(stub, sessionId);

    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());
    const countAfterFirst = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`][0]!.n,
    );
    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());
    const countAfterSecond = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`][0]!.n,
    );
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("a fresh sitting after a prior session expired reaps the old held row (Finding B sweep)", async () => {
    const userId = "fresh-sitting-user";
    const stub = getStub();
    // The s2 call below is granted and executes, so seed the row credential.
    const { sessionId: s1 } = await parkHeldCall(stub, userId, "INBOX", await seedCiphertext());
    await expireSession(stub, s1);

    // A new sitting: the reaper reaps the expired s1 first (sweeping its held
    // row and writing s1's session.end), then resolveActiveSession mints the
    // fresh session the granted call attaches to.
    await runInDurableObject(stub, async (instance) => {
      instance.reapExpiredSessions();
      const s2 = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", s2);
      await instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: "agent-1",
      });
    });

    // The stranded s1 held row was reaped (not left to leak), and s1 got a
    // session.end.
    const held = await runInDurableObject(stub, (instance) =>
      instance.sql<{ session_id: string }>`SELECT session_id FROM held_tool_calls`,
    );
    expect(held).toHaveLength(0);
    const s1End = await runInDurableObject(stub, (instance) =>
      instance.sql<{ id: string }>`
        SELECT id FROM audit_log WHERE tool_name = 'session.end' AND session_id = ${s1}
      `,
    );
    expect(s1End).toHaveLength(1);
  });

  it("the held call's expiry outcome is a fixed minimal string — no scopes/ids/internals", async () => {
    const userId = "sec2-expiry-user";
    const stub = getStub();
    const { heldCallId, sessionId } = await parkHeldCall(stub, userId);
    await expireSession(stub, sessionId);

    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());

    const terminal = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log
        WHERE tool_name = 'mock_email_list' AND outcome = 'timeout'
      `][0]!,
    );
    const msg = terminal.error_message ?? "";
    // Fixed minimal string — leaks no held-call id, session id, or grant scope.
    expect(msg).toBe("Held call expired with its session");
    expect(msg).not.toContain(heldCallId);
    expect(msg).not.toContain(sessionId);
    expect(msg).not.toContain("mock_email");
  });

  it("an idle session with no held call still gets exactly one session.end (every start ends once)", async () => {
    const userId = "idle-end-user";
    const stub = getStub();
    // Establish a session but never park a held call — the common idle case.
    const sessionId = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId, agentId: "agent-1" }),
    );
    const startedAt = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ started_at: string }>`
        SELECT started_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.started_at,
    );
    await expireSession(stub, sessionId);
    const newStarted = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ started_at: string }>`
        SELECT started_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.started_at,
    );
    const effectiveExpiry = new Date(
      new Date(newStarted).getTime() + SESSION_LIFETIME_MS,
    ).toISOString();

    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());

    // Symmetry: every session that the engine observes expired gets a
    // session.end, not just those that died holding a call. Exactly one, reason
    // timeout, stamped at the effective expiry instant.
    const ends = await runInDurableObject(stub, (instance) =>
      instance.sql<{ error_message: string | null; timestamp: string; session_id: string }>`
        SELECT error_message, timestamp, session_id FROM audit_log WHERE tool_name = 'session.end'
      `,
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!.error_message).toBe("timeout");
    expect(ends[0]!.timestamp).toBe(effectiveExpiry);
    expect(ends[0]!.timestamp).not.toBe(startedAt);
    expect(ends[0]!.session_id).toBe(sessionId);

    // ended_at is set as the once-only marker.
    const endedAt = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ ended_at: string | null }>`
        SELECT ended_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.ended_at,
    );
    expect(endedAt).toBe(effectiveExpiry);
  });

  it("the reaper writes session.end exactly once per session (ended_at idempotency, no held call)", async () => {
    const userId = "idle-idem-user";
    const stub = getStub();
    const sessionId = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId, agentId: "agent-1" }),
    );
    await expireSession(stub, sessionId);

    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());
    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());
    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());

    const ends = await runInDurableObject(stub, (instance) =>
      instance.sql<{ id: string }>`SELECT id FROM audit_log WHERE tool_name = 'session.end'`,
    );
    expect(ends).toHaveLength(1); // ended_at guard → never re-emitted
  });

  it("a malformed started_at does not throw or brick the DO", async () => {
    const userId = "poison-anchor-user";
    const stub = getStub();
    // The clean s2 executeTool below is granted and executes, so seed the row.
    const { sessionId: s1 } = await parkHeldCall(stub, userId, "INBOX", await seedCiphertext());

    // Poison the session anchor with an unparseable value. Without the
    // sessionStartedAt null-on-NaN guard, the reaper would compute
    // new Date(NaN).toISOString() and throw RangeError at the top of
    // chat()/executeTool(), permanently bricking the DO.
    await runInDurableObject(stub, (instance) => {
      instance.sql`UPDATE session_state SET started_at = 'not-a-date' WHERE session_id = ${s1}`;
    });

    // The reaper must not throw on a poisoned anchor.
    await runInDurableObject(stub, (instance) => instance.reapExpiredSessions());

    // The DO stays usable: a fresh executeTool in a clean session still works.
    const result = await runInDurableObject(stub, async (instance) => {
      const s2 = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", s2);
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("allow");

    // The poisoned session is ENDED at observation time (reason timeout), its
    // held row swept — not skipped. Under single-session a
    // skipped open row would be THE active session: immortal, never timing
    // out, its held call approvable forever. The no-throw guarantee (finding
    // A) is preserved; the skip became an end.
    const after = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ session_id: string }>`SELECT session_id FROM held_tool_calls`],
      endedAt: [...instance.sql<{ ended_at: string | null }>`
        SELECT ended_at FROM session_state WHERE session_id = ${s1}
      `][0]!.ended_at,
      end: [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE tool_name = 'session.end' AND session_id = ${s1}
      `],
    }));
    expect(after.held.map((h) => h.session_id)).not.toContain(s1);
    expect(after.endedAt).not.toBeNull();
    expect(after.end).toHaveLength(1);
    expect(after.end[0]!.error_message).toBe("timeout");
  });

  it("kill revokes grants first, independent of held-call audit bookkeeping", async () => {
    const userId = "kill-order-user";
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
      // Park a held call so the kill's audit-bookkeeping loop has work
      // (SENT is un-granted on a connected service → pending/held).
      await instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "SENT" },
        userId,
        agentId: "agent-1",
      });
    });

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    // Deny-all guarantee holds with the revoke-first ordering: only the deny
    // floor remains and held calls are swept — AND the session.end audit pair
    // was still written. Connections/credentials are intentionally left intact
    // — deny-all alone halts execution.
    const after = await runInDurableObject(stub, (instance) => ({
      policy: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map((r) => r.id),
      services: [...instance.sql<{ service: string }>`SELECT service FROM connected_services`].length,
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      sessionEnd: [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE tool_name = 'session.end'
      `],
    }));
    expect(after.policy).toEqual(["default-deny"]);
    expect(after.services).toBe(1); // connection persists through kill
    expect(after.held).toBe(0);
    expect(after.sessionEnd).toHaveLength(1);
    expect(after.sessionEnd[0]!.error_message).toBe("kill");
  });

  it("kill of a grants-only session (no held call) still writes session.end(kill)", async () => {
    const userId = "kill-grants-only-user";
    const stub = getStub();
    const sessionId = await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sid = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sid);
      // No held call parked.
      return sid;
    });

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    const after = await runInDurableObject(stub, (instance) => ({
      policy: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map((r) => r.id),
      sessionEnd: [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE tool_name = 'session.end'
      `],
      endedAt: [...instance.sql<{ ended_at: string | null }>`
        SELECT ended_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.ended_at,
    }));
    expect(after.policy).toEqual(["default-deny"]); // deny-all
    expect(after.sessionEnd).toHaveLength(1); // session.end written despite no held call
    expect(after.sessionEnd[0]!.error_message).toBe("kill");
    expect(after.endedAt).toBeTruthy(); // marked ended
  });

  it("kill's deny-all (TX1) commits independent of the audit pass", async () => {
    const userId = "kill-2a-user";
    const stub = getStub();
    const sessionId = await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sid = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sid);
      // Delete the session.start row so sessionIdentity() returns null and the
      // audit pass (TX2) can write no session.end for this session — a degraded
      // TX2. The deny-all (TX1) must still take effect regardless.
      instance.sql`DELETE FROM audit_log WHERE tool_name = 'session.start' AND session_id = ${sid}`;
      return sid;
    });

    // Kill must not throw and must take effect.
    await runInDurableObject(stub, (instance) => instance.killSwitch());

    const after = await runInDurableObject(stub, (instance) => ({
      policy: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map((r) => r.id),
      services: [...instance.sql<{ service: string }>`SELECT service FROM connected_services`].length,
      // TX2 couldn't recover identity → no session.end (the accepted gap), but
      // the session is still marked ended so it isn't re-processed.
      sessionEnd: [...instance.sql<{ id: string }>`SELECT id FROM audit_log WHERE tool_name = 'session.end'`].length,
      endedAt: [...instance.sql<{ ended_at: string | null }>`
        SELECT ended_at FROM session_state WHERE session_id = ${sessionId}
      `][0]!.ended_at,
    }));
    // Deny-all committed in TX1, independent of the degraded audit pass.
    expect(after.policy).toEqual(["default-deny"]);
    expect(after.services).toBe(1); // connection persists through kill
    // The audit gap is the accepted residual when identity can't be recovered.
    expect(after.sessionEnd).toBe(0);
    expect(after.endedAt).toBeTruthy(); // still marked ended (no re-processing)
  });
});
