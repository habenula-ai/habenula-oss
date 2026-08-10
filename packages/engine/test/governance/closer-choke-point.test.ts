import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { verifyChainRange } from "@habenula-ai/audit";
import type { UserAgent } from "../../src/agent/user-agent";
import { insertSessionState } from "../../src/data/helpers/session-state";
import {
  insertCommissionRun,
  updateCommissionStatus,
} from "../../src/data/helpers/commission-runs";
import {
  insertHeldToolCall,
  readHeldCall,
  updateHeldTurnState,
} from "../../src/data/helpers/held-tool-calls";
import { bindDoSql } from "../helpers/do-sql";
import { seedCloser, inTxn } from "../helpers/audit-closer";
import { parseTurnState, wrapTurnState } from "../../src/llm/canonical";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * The closer write rule, driven end to end through the teardown paths that
 * exercise it. Every audit write that names a decision entry passes through
 * `closeDecisionEntryInTxn`, and the rule there is asymmetric on the writer's
 * basis. An INFERRED writer (the expiry and cancel sweeps) skips when a closer
 * already exists, which is the fabricated-denial sequence these cases pin. An
 * OBSERVED writer always writes — a second closer on an observed basis is a
 * correction, and the log keeps both.
 *
 * All cases drive real `UserAgent` state in the Workers runtime (Hard
 * Invariant #5 — nothing mocks SQLite). Forcing the sequence needs no
 * test-only hook: a held row with an empty `turn_state` makes
 * `turnStateHasResolution` answer false by its own documented rule, so the
 * sweep reaches the write exactly as a sweep missing that check would.
 * Conflicts are seeded through `test/helpers/audit-closer.ts`.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const AGENT_ID = "agent-1";
const NINETY_ONE_MIN_MS = 91 * 60 * 1000;

type Sweep = "reap" | "kill" | "quit";

/** Seed a session holding one parked call whose `pending` entry is already
 * closed by a real allow/success closer, run the sweep, and return the rows
 * naming the pending entry. The session is expired for the reaper and active
 * for kill/quit — the three teardowns that sweep held calls.
 *
 * A `session.start` row is seeded so `sessionIdentity` resolves and each sweep
 * reaches its paired `session.end` write. That pairing is what makes a case
 * sensitive to a THROW rather than only to a skip: `killSwitch` runs its audit
 * pass in a TX2 whose every error it deliberately swallows, and TX1 already
 * deleted the held row, so `closers` and `heldRow` alone read identically
 * whether the write rule skipped or the whole transaction rolled back.
 * `sessionEnd` and `endedAt` are written by that transaction and nothing else,
 * so asserting them fails the case if it never committed. */
async function sweepWithRealCloser(sweep: Sweep) {
  const stub = getStub();
  const userId = `user-${sweep}`;
  const sessionId = `sess-${sweep}`;
  return runInDurableObject(stub, (instance) => {
    const agent = instance as unknown as UserAgent;
    const sql = bindDoSql(instance as unknown as { sql: EngineSql });
    const startedAt =
      sweep === "reap"
        ? new Date(Date.now() - NINETY_ONE_MIN_MS).toISOString()
        : new Date().toISOString();
    insertSessionState(sql, sessionId, startedAt, AGENT_ID);
    const scope = {
      userId,
      agentId: AGENT_ID,
      sessionId,
      parametersMetadata: {},
      latencyMs: 0,
    };
    agent.writeAuditEntry({
      ...scope,
      toolName: "session.start",
      service: "session",
      verb: "start",
      noun: "-",
      decision: "allow",
      outcome: "success",
    });
    const pending = agent.writeAuditEntry({
      ...scope,
      toolName: "mock_email_list",
      service: "mock_email",
      verb: "list",
      noun: "INBOX",
      decision: "pending",
      outcome: "success",
    });
    // The real disposition, recorded before the crash left the row parked.
    seedCloser(instance, {
      ...scope,
      toolName: "mock_email_list",
      service: "mock_email",
      verb: "list",
      noun: "INBOX",
      decision: "allow",
      outcome: "success",
      decisionEntryId: pending.id,
    });
    // Empty turn_state: `turnStateHasResolution` answers false by its own
    // documented rule, so the sweep reaches the closer write exactly as a
    // sweep missing that check would — no concurrency required.
    insertHeldToolCall(sql, `held-${sweep}`, sessionId, pending.id, startedAt);

    if (sweep === "reap") agent.reapExpiredSessions();
    else if (sweep === "kill") agent.killSwitch();
    else agent.endSession("quit");

    return {
      closers: [
        ...sql<{ decision: string; outcome: string }>`
          SELECT decision, outcome FROM audit_log
          WHERE decision_entry_id = ${pending.id} ORDER BY sequence_num ASC
        `,
      ],
      heldRow: readHeldCall(sql, `held-${sweep}`),
      sessionEnd: [
        ...sql<{ error_message: string | null }>`
          SELECT error_message FROM audit_log
          WHERE session_id = ${sessionId} AND tool_name = 'session.end'
        `,
      ].map((r) => r.error_message),
      endedAt: [
        ...sql<{ ended_at: string | null }>`
          SELECT ended_at FROM session_state WHERE session_id = ${sessionId}
        `,
      ][0]?.ended_at,
    };
  });
}

/** The sweep suppressed its fabricated closer, swept the hold, and still
 * committed the rest of its teardown. */
function expectSkippedButCommitted(
  result: Awaited<ReturnType<typeof sweepWithRealCloser>>,
  reason: string,
) {
  expect(result.closers).toEqual([{ decision: "allow", outcome: "success" }]);
  expect(result.heldRow).toBeNull(); // still swept — only the write is suppressed
  expect(result.sessionEnd).toEqual([reason]);
  expect(result.endedAt).not.toBeNull();
}

describe("closer choke point", () => {
  it("the expiry sweep never fabricates a deny/timeout over a real closer", async () => {
    expectSkippedButCommitted(await sweepWithRealCloser("reap"), "timeout");
  });

  it("killSwitch TX2 skips the same way", async () => {
    expectSkippedButCommitted(await sweepWithRealCloser("kill"), "kill");
  });

  it("session quit (endSessionRowInTxn) skips the same way", async () => {
    expectSkippedButCommitted(await sweepWithRealCloser("quit"), "quit");
  });

  it("the cancel sweep skips the same way, and the task still moves terminal", async () => {
    const stub = getStub();
    const userId = "user-cancel";
    const sessionId = "sess-cancel";
    const taskId = "task-cancel";
    const now = new Date().toISOString();

    const pendingId = await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      insertSessionState(sql, sessionId, now, AGENT_ID);
      insertCommissionRun(sql, {
        id: taskId,
        goal: "list my inbox",
        data: null,
        sessionId,
        createdAt: now,
      });
      // Parked awaiting the user, which is the only state cancel accepts.
      updateCommissionStatus(sql, taskId, "awaiting_confirmation", now);
      const pending = agent.writeAuditEntry({
        userId,
        agentId: AGENT_ID,
        sessionId,
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "pending",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      // The user's own denial, recorded before the crash left the row parked.
      seedCloser(instance, {
        userId,
        agentId: AGENT_ID,
        sessionId,
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "deny",
        parametersMetadata: {},
        outcome: "error",
        errorMessage: "Denied by user",
        decisionEntryId: pending.id,
        latencyMs: 0,
      });
      insertHeldToolCall(sql, "held-cancel", sessionId, pending.id, now, taskId);
      return pending.id;
    });

    const result = await runInDurableObject(stub, (instance) =>
      (instance as unknown as UserAgent).cancelTask({
        taskId,
        surface: "human",
        userId,
      }),
    );
    expect(result).toMatchObject({ status: "cancelled" });

    const after = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      return {
        closers: [
          ...sql<{ decision: string; error_message: string | null }>`
            SELECT decision, error_message FROM audit_log
            WHERE decision_entry_id = ${pendingId} ORDER BY sequence_num ASC
          `,
        ],
        heldRow: readHeldCall(sql, "held-cancel"),
        // The cancel's own lifecycle row is written unconditionally and names
        // no decision, so the skip must not have suppressed it too.
        cancelRows: [
          ...sql<{ noun: string }>`
            SELECT noun FROM audit_log WHERE tool_name = 'task.cancel'
          `,
        ].map((r) => r.noun),
      };
    });
    // "Parked action cancelled with its task" would contradict the recorded
    // denial, so the cancel sweep writes nothing here.
    expect(after.closers).toEqual([
      { decision: "deny", error_message: "Denied by user" },
    ]);
    expect(after.heldRow).toBeNull();
    expect(after.cancelRows).toEqual([taskId]);
  });

  it("a genuinely parked hold still gets its truthful deny/timeout closer", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const startedAt = new Date(Date.now() - NINETY_ONE_MIN_MS).toISOString();
      insertSessionState(sql, "sess-parked", startedAt, AGENT_ID);
      const pending = agent.writeAuditEntry({
        userId: "user-parked",
        agentId: AGENT_ID,
        sessionId: "sess-parked",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "pending",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      insertHeldToolCall(sql, "held-parked", "sess-parked", pending.id, startedAt);
      agent.reapExpiredSessions();
      const closers = [
        ...sql<{ decision: string; outcome: string; error_message: string | null }>`
          SELECT decision, outcome, error_message FROM audit_log
          WHERE decision_entry_id = ${pending.id}
        `,
      ];
      expect(closers).toEqual([
        {
          decision: "deny",
          outcome: "timeout",
          error_message: "Held call expired with its session",
        },
      ]);
    });
  });

  it("the observed branch never skips: dispatch recovery corrects a fabricated closer and the chain verifies", async () => {
    const userId = "user-observed";
    const stub = getStub();

    // Park a direct-execute hold (no grant → held). No credential is needed:
    // the recovery path returns before any dispatch.
    const held = await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      const result = await agent.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: AGENT_ID,
      });
      return result.held!;
    });

    // Crash after dispatch: mark the turn_state `dispatched`, then plant the
    // fabricated deny/timeout a guard-less sweep would have written.
    const pendingId = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const row = readHeldCall(sql, held.heldCallId)!;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) throw new Error("seeded turn_state must parse");
      updateHeldTurnState(
        sql,
        held.heldCallId,
        wrapTurnState({ ...parsed.state, dispatched: true }),
      );
      seedCloser(instance, {
        userId,
        agentId: AGENT_ID,
        sessionId: row.session_id,
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "deny",
        parametersMetadata: {},
        outcome: "timeout",
        errorMessage: "Held call expired with its session",
        decisionEntryId: row.pending_audit_entry_id,
        latencyMs: 0,
      });
      return row.pending_audit_entry_id;
    });

    const resolved = await runInDurableObject(stub, (instance) =>
      (instance as unknown as UserAgent).resolveConfirmation({
        heldCallId: held.heldCallId,
        choice: "session",
        userId,
      }),
    );
    expect(resolved.status).toBe("resumed");

    // Both rows stand: the fabricated deny/timeout AND the recovery's
    // allow/error correction — the second closer is the point.
    const rows = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      return [
        ...sql<{ decision: string; outcome: string }>`
          SELECT decision, outcome FROM audit_log
          WHERE decision_entry_id = ${pendingId} ORDER BY sequence_num ASC
        `,
      ];
    });
    expect(rows).toEqual([
      { decision: "deny", outcome: "timeout" },
      { decision: "allow", outcome: "error" },
    ]);

    // Two closers on one decision entry break nothing: the chain verifies.
    const page = await runInDurableObject(stub, (instance) =>
      (instance as unknown as UserAgent).listAuditEntries({ limit: 100 }),
    );
    const verdict = verifyChainRange([...page.entries].reverse());
    expect(verdict.entriesChecked).toBeGreaterThan(0);
    expect(verdict.breaks).toHaveLength(0);
  });

  it("writeHeldTimeoutOutcome returns the recovered identity on a skip", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const pending = agent.writeAuditEntry({
        userId: "user-skip",
        agentId: AGENT_ID,
        sessionId: "sess-skip",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "pending",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      seedCloser(instance, {
        userId: "user-skip",
        agentId: AGENT_ID,
        sessionId: "sess-skip",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "allow",
        parametersMetadata: {},
        outcome: "success",
        decisionEntryId: pending.id,
        latencyMs: 0,
      });
      // The sweep's contract: a skip changes what is written and nothing
      // else — the paired session.end still needs the identity.
      const identity = inTxn(instance, () =>
        (
          instance as unknown as {
            writeHeldTimeoutOutcome(
              id: string,
              ts: string,
            ): { userId: string; agentId: string; sessionId: string } | null;
          }
        ).writeHeldTimeoutOutcome(pending.id, new Date().toISOString()),
      );
      expect(identity).toEqual({
        userId: "user-skip",
        agentId: AGENT_ID,
        sessionId: "sess-skip",
      });
      const closers = [
        ...sql<{ decision: string }>`
          SELECT decision FROM audit_log WHERE decision_entry_id = ${pending.id}
        `,
      ];
      expect(closers).toHaveLength(1); // still just the real closer
    });
  });
});
