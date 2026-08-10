import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import { insertSessionState } from "../../src/data/helpers/session-state";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * DO-method tests for the single-active-session primitives, exercised in isolation on a real UserAgent DO — no mocks
 * (Hard Invariant #5). These pin the derive-or-create path, the refuse-guarded
 * launch, the tie-break reap, and the explicit `quit`. Full-HTTP wiring is
 * covered separately by the continuity/route suites.
 */

const SESSION_LIFETIME_MS = 90 * 60 * 1000;
const USER = "session-lifecycle-user";
const AGENT = "agent-1";

type Stub = ReturnType<typeof getUserAgentStub>;

/**
 * Park a held call (no grant → pending) on the DO's active session — the DO
 * derives the session, so the held call binds to whatever `resolveActiveSession`
 * resolves. Returns the held-call id and the session it landed in.
 */
async function parkHeld(stub: Stub): Promise<{ heldCallId: string; sessionId: string }> {
  return runInDurableObject(stub, async (instance) => {
    instance.connectService("mock_email");
    const result = await instance.executeTool({
      toolName: "mock_email_list",
      toolParams: { label: "INBOX" },
      userId: USER,
      agentId: AGENT,
    });
    return {
      heldCallId: result.held!.heldCallId,
      sessionId: instance.getActiveSession()!.sessionId,
    };
  });
}

/** Rewrite a session's started_at to a fixed instant (controls newest / expiry). */
async function setStartedAt(stub: Stub, sessionId: string, iso: string) {
  await runInDurableObject(stub, (instance) => {
    instance.sql`UPDATE session_state SET started_at = ${iso} WHERE session_id = ${sessionId}`;
  });
}

function auditRows(stub: Stub) {
  return runInDurableObject(stub, (instance) => [
    ...instance.sql<{
      tool_name: string;
      outcome: string;
      error_message: string | null;
      session_id: string;
    }>`
      SELECT tool_name, outcome, error_message, session_id
      FROM audit_log ORDER BY sequence_num
    `,
  ]);
}

function openSessionIds(stub: Stub) {
  return runInDurableObject(stub, (instance) =>
    [
      ...instance.sql<{ session_id: string }>`
        SELECT session_id FROM session_state WHERE ended_at IS NULL
      `,
    ].map((r) => r.session_id),
  );
}

describe("single active session (DO methods)", () => {
  it("resolveActiveSession creates on first call, attaches on the next (same id, one row)", async () => {
    const stub = getUserAgentStub();
    const first = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId: USER, agentId: AGENT }),
    );
    const second = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId: USER, agentId: AGENT }),
    );
    expect(first).toMatch(/^session-/);
    expect(second).toBe(first); // attach, not a new session
    expect(await openSessionIds(stub)).toEqual([first]);

    // Exactly one session.start was written (no re-emit on attach).
    const starts = (await auditRows(stub)).filter(
      (r) => r.tool_name === "session.start",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]!.session_id).toBe(first);
  });

  it("resolveActiveSession tie-break: newest wins, older open rows are reaped (session.end superseded) with held calls swept", async () => {
    const stub = getUserAgentStub();
    // Park a held call → creates + attaches session A (has a session.start).
    const { sessionId: idA } = await parkHeld(stub);
    // Inject a NEWER open row directly — the single-active invariant-break case.
    const now = Date.now();
    await setStartedAt(stub, idA, new Date(now - 5 * 60_000).toISOString());
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      insertSessionState(sql, "s-newer", new Date(now - 1 * 60_000).toISOString(), AGENT);
    });

    const kept = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId: USER, agentId: AGENT }),
    );
    expect(kept).toBe("s-newer");
    expect(await openSessionIds(stub)).toEqual(["s-newer"]); // idA reaped

    const rows = await auditRows(stub);
    const superseded = rows.find(
      (r) => r.tool_name === "session.end" && r.error_message === "superseded",
    );
    expect(superseded?.session_id).toBe(idA);

    // idA's held call was swept (deleted + resolved to a terminal outcome).
    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(held).toHaveLength(0);
    expect(
      rows.some((r) => r.tool_name === "mock_email_list" && r.outcome === "timeout"),
    ).toBe(true);
  });

  it("startSession starts once, then refuses without creating a second row", async () => {
    const stub = getUserAgentStub();
    const started = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    expect(started.status).toBe("started");
    expect(started.activeSession.sessionId).toMatch(/^session-/);

    const refused = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    expect(refused.status).toBe("refused");
    expect(refused.activeSession.sessionId).toBe(started.activeSession.sessionId);
    expect(await openSessionIds(stub)).toHaveLength(1); // no second session
  });

  it("startSession reaps an expired session first, so a fresh launch is not refused against it", async () => {
    const stub = getUserAgentStub();
    const first = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    const staleId = first.activeSession.sessionId;
    // Age it past the 90-minute cap.
    await setStartedAt(
      stub,
      staleId,
      new Date(Date.now() - (SESSION_LIFETIME_MS + 60_000)).toISOString(),
    );

    const result = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    expect(result.status).toBe("started"); // reaped, not refused
    expect(result.activeSession.sessionId).not.toBe(staleId);

    const timedOut = (await auditRows(stub)).find(
      (r) => r.tool_name === "session.end" && r.error_message === "timeout",
    );
    expect(timedOut?.session_id).toBe(staleId);
  });

  it("endSession('quit') ends the active session, sweeps its held call, and is idempotent", async () => {
    const stub = getUserAgentStub();
    const { sessionId } = await parkHeld(stub);

    const ended = await runInDurableObject(stub, (instance) =>
      instance.endSession("quit"),
    );
    expect(ended.ended).toBe(true);

    const end = (await auditRows(stub)).find((r) => r.tool_name === "session.end");
    expect(end!.error_message).toBe("quit");
    expect(end!.session_id).toBe(sessionId);

    // Held call swept, session closed.
    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(held).toHaveLength(0);
    expect(await openSessionIds(stub)).toHaveLength(0);

    // Idempotent: nothing left to end.
    const again = await runInDurableObject(stub, (instance) =>
      instance.endSession("quit"),
    );
    expect(again.ended).toBe(false);
  });

  it("getActiveSession returns the view with computed expiry, null when none, reaps expired first", async () => {
    const stub = getUserAgentStub();
    expect(
      await runInDurableObject(stub, (instance) => instance.getActiveSession()),
    ).toBeNull();

    const sessionId = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId: USER, agentId: AGENT }),
    );
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await setStartedAt(stub, sessionId, startedAt);

    const view = await runInDurableObject(stub, (instance) =>
      instance.getActiveSession(),
    );
    expect(view).toEqual({
      sessionId,
      startedAt,
      expiry: new Date(new Date(startedAt).getTime() + SESSION_LIFETIME_MS).toISOString(),
    });

    // Age past the cap → getActiveSession reaps and reports none.
    await setStartedAt(
      stub,
      sessionId,
      new Date(Date.now() - (SESSION_LIFETIME_MS + 60_000)).toISOString(),
    );
    expect(
      await runInDurableObject(stub, (instance) => instance.getActiveSession()),
    ).toBeNull();
  });

  it("a poisoned started_at is reaped at observation time — never an immortal active session", async () => {
    // An unparseable anchor has no computable expiry. Skipping it would
    // make the poisoned row THE active session
    // under single-session — immortal, never timing out — so the reaper ends
    // it at observation time instead (reason timeout), without throwing.
    const stub = getUserAgentStub();
    const sessionId = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId: USER, agentId: AGENT }),
    );
    await setStartedAt(stub, sessionId, "not-a-date");

    // getActiveSession reaps first: the poisoned session is ended, not shown.
    expect(
      await runInDurableObject(stub, (instance) => instance.getActiveSession()),
    ).toBeNull();

    const end = (await auditRows(stub)).find((r) => r.tool_name === "session.end");
    expect(end!.session_id).toBe(sessionId);
    expect(end!.error_message).toBe("timeout");

    // The slot is free: a fresh launch starts, it is not refused forever.
    const started = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    expect(started.status).toBe("started");
    expect(started.activeSession.sessionId).not.toBe(sessionId);
  });

  it("quit after the 90-minute cap records timeout at the effective expiry, not quit at wall-clock", async () => {
    // endSession reaps first, like every session entry point: a `habenula
    // quit` hours after the dead-man's-switch already ended the session must
    // not stamp `quit` at now() over the reaper's documented invariant
    // (session.end reason timeout at started_at + 90min).
    const stub = getUserAgentStub();
    const started = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId: USER, agentId: AGENT }),
    );
    const sessionId = started.activeSession.sessionId;
    const startedAt = new Date(
      Date.now() - (SESSION_LIFETIME_MS + 60 * 60_000),
    ).toISOString();
    await setStartedAt(stub, sessionId, startedAt);

    const ended = await runInDurableObject(stub, (instance) =>
      instance.endSession("quit"),
    );
    expect(ended.ended).toBe(false); // already dead — nothing for quit to end

    const ends = (await auditRows(stub)).filter(
      (r) => r.tool_name === "session.end",
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!.error_message).toBe("timeout"); // not "quit"
  });

  it("a session-end sweep skips the outcome write for a dispatched held call (resolve path owns it)", async () => {
    // A dispatched row is mid-resolve, not parked awaiting approval: quit's
    // sweep writing the timeout outcome would record a false denial for a
    // call that executed, contradicting the resolve path's real allow/success
    // against the same pending entry. The row is still deleted.
    const stub = getUserAgentStub();
    const { heldCallId } = await parkHeld(stub);
    await runInDurableObject(stub, (instance) => {
      instance.sql`UPDATE held_tool_calls SET turn_state = ${JSON.stringify({ dispatched: true })} WHERE id = ${heldCallId}`;
    });

    const ended = await runInDurableObject(stub, (instance) =>
      instance.endSession("quit"),
    );
    expect(ended.ended).toBe(true);

    // Row swept — nothing survives session end.
    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(held).toHaveLength(0);

    // But NO timeout outcome was written for the dispatched call: the only
    // terminal rows are session.end(quit); the held tool's pending entry has
    // no deny/timeout closure from the sweep.
    const rows = await auditRows(stub);
    expect(
      rows.some((r) => r.tool_name === "mock_email_list" && r.outcome === "timeout"),
    ).toBe(false);
    expect(
      rows.find((r) => r.tool_name === "session.end")!.error_message,
    ).toBe("quit");
  });

  it("the timeout reaper skips the outcome write for a mid-resolve held call (resolve path owns it)", async () => {
    // The lazy reaper closing an expired session must honor the same invariant
    // as the quit/superseded sweep: an `answered` row is mid-resolve (result
    // produced, resume pending), so writing the timeout outcome would fabricate
    // a second, contradictory terminal outcome (a false denial) over the real
    // allow/success the resolve path already owns. This pins the `answered` arm
    // of turnStateHasResolution (the kill test pins the `dispatched` arm). The
    // row is still swept — nothing survives the reap.
    const stub = getUserAgentStub();
    const { heldCallId, sessionId } = await parkHeld(stub);
    // Production shape: resolveConfirmation persists `answered` as the produced
    // tool result + outcome (an object, never a bare boolean) before the resume
    // round-trip — see the answeredState write in resolveConfirmation.
    const answeredTurnState = JSON.stringify({
      answered: {
        resolvedResult: {
          type: "tool_result",
          tool_use_id: heldCallId,
          content: '{"messages":[]}',
          is_error: false,
        },
        resolvedOutcome: "success",
      },
    });
    await runInDurableObject(stub, (instance) => {
      instance.sql`UPDATE held_tool_calls SET turn_state = ${answeredTurnState} WHERE id = ${heldCallId}`;
    });

    // Age the session past the 90-minute cap so the next DO touch reaps it.
    await setStartedAt(
      stub,
      sessionId,
      new Date(Date.now() - (SESSION_LIFETIME_MS + 60_000)).toISOString(),
    );

    // Any session entry point reaps first; getActiveSession is the cheapest.
    expect(
      await runInDurableObject(stub, (instance) => instance.getActiveSession()),
    ).toBeNull(); // reaped

    // Row swept — nothing survives the reap.
    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(held).toHaveLength(0);

    // But NO timeout outcome was fabricated for the mid-resolve call: the only
    // terminal record the reap wrote is session.end(timeout).
    const rows = await auditRows(stub);
    expect(
      rows.some((r) => r.tool_name === "mock_email_list" && r.outcome === "timeout"),
    ).toBe(false);
    expect(
      rows.some((r) => r.tool_name === "session.end" && r.error_message === "timeout"),
    ).toBe(true);
  });
});
