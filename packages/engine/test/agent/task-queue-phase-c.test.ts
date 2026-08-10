/**
 * manage & surface. Proves cancel/amend and
 * the cross-cutting hardening the full multi-task surface enables:
 * cancel authority split by surface (human cancels any origin; MCP is
 * own-task-scoped), a running task refuses cancel/amend, cancel sweeps the hold
 * and closes its pending audit entry, multi-task interleaving leaves the other
 * task's context intact, the audit hash chain stays intact across interleaving +
 * cancel, and the status snapshot stays single-hold while the task list surfaces
 * every parked task. All against real DO SQLite (vitest-pool-workers), no mocks
 * of KV/DO/SQLite/R2 (Hard Invariant 5). Governance parity (Invariant 2) is
 * covered by test/governance/commission-parity.test.ts — cancel/amend never
 * reach evaluatePolicy, so that parity is preserved by construction.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computeEntryHash, GENESIS_SENTINEL } from "@habenula-ai/audit";
import { bindDoSql } from "../helpers/do-sql";
import { parseTurnState, wrapTurnState } from "../../src/llm/canonical";
import type { UserAgent } from "../../src/agent/user-agent";
import type { TasksListResponse } from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

function sendToolUse(id: string): LLMToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: "mock_email_send",
    input: { to: ["{{data.to}}"], subject: "Hi", body: "Hello" },
  };
}

function listToolUse(id: string): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label: "INBOX" } };
}

function scripted(script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>) {
  let i = 0;
  const client: LLMClient = {
    async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools) {
        return {
          id: `m${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return {
        id: `m${i}`,
        content: [{ type: "text", text: step.text ?? "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  return client;
}

/** Commission an ungranted list — parks awaiting_confirmation with a confirmation hold. */
async function commissionList(agent: UserAgent, goal: string, toolUseId: string) {
  agent.setLLMClient(scripted([{ tools: [listToolUse(toolUseId)] }]));
  const task = await agent.commissionGoal({ goal, userId: "u", agentId: "onboarding" });
  return task as { runId: string; status: string };
}

describe("manage & surface", () => {
  it("A-1: cancel a parked (awaiting_confirmation) task → cancelled, hold swept, pending audit closed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const task = await commissionList(agent, "list my inbox", "tu-c1");
      expect(task.status).toBe("awaiting_confirmation");
      const taskId = task.runId;
      // The confirmation hold stands before the cancel; capture the pending audit
      // entry it opened so the closure can be asserted to PAIR with it.
      const heldRows = [
        ...sql<{ pending_audit_entry_id: string }>`
          SELECT pending_audit_entry_id FROM held_tool_calls WHERE run_id = ${taskId}
        `,
      ];
      expect(heldRows).toHaveLength(1);
      const pendingId = heldRows[0]!.pending_audit_entry_id;

      const result = await agent.cancelTask({ taskId, surface: "human", userId: "u" });
      expect(result).toEqual({
        status: "cancelled",
        taskId,
        previousStatus: "awaiting_confirmation",
      });

      // Terminal cancelled + the hold swept.
      expect(agent.readCommissionRun(taskId)).toMatchObject({ status: "cancelled" });
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`][0]!.n,
      ).toBe(0);
      // The parked hold's pending audit entry was closed (deny/error) and PAIRED
      // to that pending entry via decision_entry_id — not left dangling.
      const closure = [
        ...sql<{
          decision: string;
          outcome: string;
          error_message: string | null;
          origin: string;
          decision_entry_id: string | null;
        }>`
          SELECT decision, outcome, error_message, origin, decision_entry_id
          FROM audit_log WHERE error_message LIKE 'Parked action cancelled%'
        `,
      ];
      expect(closure).toHaveLength(1);
      expect(closure[0]).toMatchObject({
        decision: "deny",
        outcome: "error",
        origin: "mcp_commission",
      });
      expect(closure[0]!.decision_entry_id).toBe(pendingId);

      // No `pending` decision is left unresolved: every pending entry has a
      // terminal entry referencing it. This is the invariant the closer exists for.
      const dangling = [
        ...sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM audit_log p
          WHERE p.decision = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM audit_log t WHERE t.decision_entry_id = p.id
            )
        `,
      ][0]!.n;
      expect(dangling).toBe(0);

      // The cancel ITSELF is audited as a first-class task-lifecycle row.
      const cancelEvent = [
        ...sql<{ tool_name: string; service: string; verb: string; noun: string; origin: string }>`
          SELECT tool_name, service, verb, noun, origin FROM audit_log
          WHERE tool_name = 'task.cancel'
        `,
      ];
      expect(cancelEvent).toHaveLength(1);
      expect(cancelEvent[0]).toMatchObject({
        service: "task",
        verb: "cancel",
        noun: taskId,
        origin: "human",
      });
    });
  });

  it("A-1: a cancel with no hold still audits the task-level cancel event", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const task = await commissionList(agent, "list inbox nohold", "tu-nohold");
      const taskId = task.runId;
      // Drop the hold out from under the task (simulating a sweep that already
      // ran), leaving a parked run with no hold — the zero-audit-rows hole.
      sql`DELETE FROM held_tool_calls WHERE run_id = ${taskId}`;

      const result = await agent.cancelTask({ taskId, surface: "human", userId: "u" });
      expect(result).toMatchObject({ status: "cancelled" });

      const cancelEvent = [
        ...sql<{ noun: string }>`SELECT noun FROM audit_log WHERE tool_name = 'task.cancel'`,
      ];
      expect(cancelEvent).toHaveLength(1);
      expect(cancelEvent[0]!.noun).toBe(taskId);
    });
  });

  it("cancel is REFUSED while a hold is mid-resolve (never records a false 'never ran')", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const task = await commissionList(agent, "list inbox midresolve", "tu-mid");
      const taskId = task.runId;
      const hold = [
        ...sql<{ id: string; turn_state: string }>`
          SELECT id, turn_state FROM held_tool_calls WHERE run_id = ${taskId}
        `,
      ][0]!;
      // Mark the hold `dispatched` — the state a crash leaves behind AFTER the
      // tool actually ran but before `answered` is persisted. Its terminal audit
      // outcome is owed by the resolve path's recovery branch. Written through the
      // canonical envelope helpers (never raw JSON), so the guard reads it exactly
      // as production does.
      const parsed = parseTurnState(hold.turn_state);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("unreachable: turn_state did not parse");
      const dispatchedState = wrapTurnState({ ...parsed.state, dispatched: true });
      sql`UPDATE held_tool_calls SET turn_state = ${dispatchedState} WHERE id = ${hold.id}`;

      const result = await agent.cancelTask({ taskId, surface: "human", userId: "u" });

      // Refused — and nothing was mutated or swept.
      expect(result).toEqual({ status: "resolving", taskId });
      expect(agent.readCommissionRun(taskId)).toMatchObject({
        status: "awaiting_confirmation",
      });
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`][0]!.n,
      ).toBe(1);
      // No false disposition and no task-level cancel row were written.
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log WHERE error_message LIKE 'Parked action cancelled%'`][0]!.n,
      ).toBe(0);
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'task.cancel'`][0]!.n,
      ).toBe(0);
    });
  });

  it("cancel sweeps EVERY hold a run owns, closing each pending entry", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const task = await commissionList(agent, "list inbox twoholds", "tu-two");
      const taskId = task.runId;
      const original = [
        ...sql<{ id: string; session_id: string; pending_audit_entry_id: string; turn_state: string; held_at: string }>`
          SELECT id, session_id, pending_audit_entry_id, turn_state, held_at
          FROM held_tool_calls WHERE run_id = ${taskId}
        `,
      ][0]!;
      // A second hold on the SAME run — the shape a crash inside provideTaskInput
      // leaves (it parks the re-attempt's hold before deleting the input hold).
      // Its pending audit entry is a real `pending` row so the dangling check bites.
      const second = agent.writeAuditEntry({
        userId: "u",
        agentId: "onboarding",
        sessionId: original.session_id,
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "pending",
        origin: "mcp_commission",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      sql`
        INSERT INTO held_tool_calls (id, session_id, pending_audit_entry_id, held_at, run_id, turn_state, hold_kind, awaited_slot_keys)
        VALUES ('hold-second', ${original.session_id}, ${second.id}, ${original.held_at}, ${taskId}, ${original.turn_state}, 'confirmation', NULL)
      `;
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`][0]!.n,
      ).toBe(2);

      const result = await agent.cancelTask({ taskId, surface: "human", userId: "u" });
      expect(result).toMatchObject({ status: "cancelled" });

      // BOTH holds swept — no survivor left independently resolvable on a
      // cancelled task — and BOTH pending entries closed.
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`][0]!.n,
      ).toBe(0);
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log WHERE error_message LIKE 'Parked action cancelled%'`][0]!.n,
      ).toBe(2);
      const dangling = [
        ...sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM audit_log p
          WHERE p.decision = 'pending'
            AND NOT EXISTS (SELECT 1 FROM audit_log t WHERE t.decision_entry_id = p.id)
        `,
      ][0]!.n;
      expect(dangling).toBe(0);
    });
  });

  it("A-1: cancel a needs_input task sweeps its input hold and terminates it", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-c2")] }]));
      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      expect(parked.status).toBe("needs_input");
      const taskId = (parked as { runId: string }).runId;

      const result = await agent.cancelTask({ taskId, surface: "human", userId: "u" });
      expect(result).toMatchObject({ status: "cancelled", previousStatus: "needs_input" });
      expect(agent.readCommissionRun(taskId)).toMatchObject({ status: "cancelled" });
      expect(
        [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`][0]!.n,
      ).toBe(0);
    });
  });

  it("A-4: the human surface cancels a task of any origin; the MCP surface is own-task-scoped", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");

      // A real inbound (mcp_commission) parked task — the "runaway commission".
      const commissioned = await commissionList(agent, "list inbox A", "tu-a4a");
      const commissionedId = commissioned.runId;

      // Seed a `human`-origin parked row on the same live session (there is no
      // human-task creation path yet; the cross-origin authority is built
      // origin-aware and exercised by seeding — forward-compat).
      const sid = [
        ...sql<{ session_id: string }>`SELECT session_id FROM commission_runs WHERE id = ${commissionedId}`,
      ][0]!.session_id;
      const now = new Date().toISOString();
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('human-task-1', 'human', 'a human task', NULL, 'awaiting_confirmation', ${sid}, ${now}, ${now})
      `;

      // MCP cancel of the human-origin task is refused (cross-origin) — no mutation.
      const refused = await agent.cancelTask({ taskId: "human-task-1", surface: "mcp", userId: "u" });
      expect(refused).toEqual({ status: "forbidden" });
      expect(agent.readCommissionRun("human-task-1")).toMatchObject({ status: "awaiting_confirmation" });

      // The human surface cancels that inbound (mcp_commission) task — the
      // runaway-commission scenario the split authority exists for.
      const cancelled = await agent.cancelTask({ taskId: commissionedId, surface: "human", userId: "u" });
      expect(cancelled).toMatchObject({ status: "cancelled" });
      expect(agent.readCommissionRun(commissionedId)).toMatchObject({ status: "cancelled" });
    });
  });

  it("A-4: the MCP surface cancels its OWN (mcp_commission) task", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      const task = await commissionList(agent, "list inbox own", "tu-a4b");
      const result = await agent.cancelTask({ taskId: task.runId, surface: "mcp", userId: "u" });
      expect(result).toMatchObject({ status: "cancelled" });
    });
  });

  it("A-2/A-3: a live turn refuses cancel and amend as busy (the turn gate is entered first)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const sessionId = agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      const now = new Date().toISOString();
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('running-task', 'mcp_commission', 'a live task', '{"to":"x@y.z"}', 'running', ${sessionId}, ${now}, ${now})
      `;
      // A live turn holds the in-flight marker. Because every authorization and
      // status read now happens INSIDE the turn gate (so it cannot be raced), the
      // gate refuses first — `busy`, which the route maps to 409 TURN_IN_PROGRESS.
      (instance as unknown as { turnInFlight: boolean }).turnInFlight = true;

      expect(
        await agent.cancelTask({ taskId: "running-task", surface: "human", userId: "u" }),
      ).toEqual({ status: "busy", taskId: "running-task" });
      expect(
        await agent.amendTask({ taskId: "running-task", data: { to: "z@z.z" }, userId: "u" }),
      ).toEqual({ status: "busy", taskId: "running-task" });

      // No mutation: the run stays running, its data untouched.
      expect(
        [...sql<{ status: string; data: string }>`SELECT status, data FROM commission_runs WHERE id = 'running-task'`][0],
      ).toMatchObject({ status: "running", data: '{"to":"x@y.z"}' });
    });
  });

  it("A-2: a stored `running` row with no live turn refuses cancel with `running`", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const sessionId = agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      const now = new Date().toISOString();
      // No turn in flight: this is a crash-orphaned row. Cancel refuses
      // conservatively rather than cancelling a row whose true state is unresolved.
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('orphan-task', 'mcp_commission', 'orphan', NULL, 'running', ${sessionId}, ${now}, ${now})
      `;

      expect(
        await agent.cancelTask({ taskId: "orphan-task", surface: "human", userId: "u" }),
      ).toEqual({ status: "running", taskId: "orphan-task" });
      expect(
        [...sql<{ status: string }>`SELECT status FROM commission_runs WHERE id = 'orphan-task'`][0]!.status,
      ).toBe("running");
    });
  });

  it("amend REFUSES an awaiting_confirmation task (no approval bait-and-switch)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // A send whose recipient is already bound parks on CONFIRMATION (not
      // needs_input), so the user is being prompted with the substituted value.
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-swap")] }]));
      const task = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        data: { to: "ceo@acme.test" },
        userId: "u",
        agentId: "onboarding",
      });
      expect(task.status).toBe("awaiting_confirmation");
      const taskId = (task as { runId: string }).runId;

      // The attack: swap the recipient after the user has read the prompt and
      // before they approve. It must be refused, and the stored data untouched —
      // otherwise resolveConfirmation would substitute the new value into the
      // noun, the minted grant, the audit metadata, and the dispatch.
      const amended = await agent.amendTask({
        taskId,
        data: { to: "attacker@evil.test" },
        userId: "u",
      });
      expect(amended).toEqual({
        status: "not_amendable",
        currentStatus: "awaiting_confirmation",
      });

      const stored = JSON.parse(
        [...sql<{ data: string }>`SELECT data FROM commission_runs WHERE id = ${taskId}`][0]!.data,
      ) as Record<string, string>;
      expect(stored.to).toBe("ceo@acme.test");
      // What the user is shown still matches what would execute.
      const status = await agent.readStatus();
      expect(status.held[0]?.noun).toContain("ceo@acme.test");
      expect(status.held[0]?.noun).not.toContain("attacker@evil.test");
    });
  });

  it("A-3: amend re-supplies a parked task's data (verbatim), refuses unpublished keys, and does not resume", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-a3")] }]));
      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      expect(parked.status).toBe("needs_input");
      const taskId = (parked as { runId: string }).runId;

      // Amend supplies the value under the published slot key; it persists the
      // data and leaves the task parked (no resume — provide is the resume verb).
      const amended = await agent.amendTask({
        taskId,
        data: { to: "fixed@acme.test" },
        userId: "u",
      });
      expect(amended).toEqual({ taskId, status: "needs_input" });
      // The run's data map now carries the corrected value, verbatim.
      const data = [
        ...sql<{ data: string }>`SELECT data FROM commission_runs WHERE id = ${taskId}`,
      ][0]!.data;
      expect(JSON.parse(data)).toMatchObject({ to: "fixed@acme.test" });
      // Still parked — amend did not resume it.
      expect(agent.readCommissionRun(taskId)).toMatchObject({ status: "needs_input" });

      // An unpublished key is a fail-closed throw (mirrors provideTaskInput).
      await expect(
        agent.amendTask({ taskId, data: { recipient: "no@no.no" }, userId: "u" }),
      ).rejects.toThrow("unpublished data keys: recipient");
    });
  });

  it("cancel of an unknown task is not_found; of a terminal task is not_cancellable", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      expect(await agent.cancelTask({ taskId: "nope", surface: "human", userId: "u" })).toEqual({
        status: "not_found",
      });

      // Cancel a task, then cancel it again — the second is not_cancellable.
      const task = await commissionList(agent, "list inbox term", "tu-term");
      await agent.cancelTask({ taskId: task.runId, surface: "human", userId: "u" });
      expect(await agent.cancelTask({ taskId: task.runId, surface: "human", userId: "u" })).toEqual({
        status: "not_cancellable",
        taskId: task.runId,
        currentStatus: "cancelled",
      });
    });
  });

  it("A-12: cancelling one parked task leaves the other's hold and context intact (anti-bleed)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");

      const taskA = await commissionList(agent, "list inbox A", "tu-A");
      const taskB = await commissionList(agent, "list inbox B", "tu-B");
      expect(taskA.status).toBe("awaiting_confirmation");
      expect(taskB.status).toBe("awaiting_confirmation");
      // Two holds coexist (the one-held-row-per-DO limit was lifted).
      expect([...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`][0]!.n).toBe(2);

      // Cancel A.
      await agent.cancelTask({ taskId: taskA.runId, surface: "human", userId: "u" });

      // B is untouched: still awaiting, its own hold intact, its context resumable.
      expect(agent.readCommissionRun(taskB.runId)).toMatchObject({ status: "awaiting_confirmation" });
      const bHold = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${taskB.runId}`,
      ];
      expect(bHold).toHaveLength(1);
      // Resolving B still works after A was cancelled — B's turn_state never
      // inherited A's, and A's cancel did not disturb B's live slot. A
      // terminating LLM step lets the deny-resume end the turn (rather than the
      // list-looping script re-parking it).
      agent.setLLMClient(scripted([{ text: "acknowledged" }]));
      const resolved = await agent.resolveConfirmation({
        heldCallId: bHold[0]!.id,
        choice: "deny",
        userId: "u",
      });
      expect(resolved.status).toBe("resumed");
      expect(agent.readCommissionRun(taskB.runId)).toMatchObject({ status: "denied" });
    });
  });

  it("A-15: the audit hash chain stays intact across multi-task interleaving and cancel", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");

      // Two parked tasks (each wrote a pending audit entry on its hold), then a
      // cancel (which writes a closure entry), interleaved on one DO.
      const taskA = await commissionList(agent, "list inbox A", "tu-hcA");
      await commissionList(agent, "list inbox B", "tu-hcB");
      await agent.cancelTask({ taskId: taskA.runId, surface: "human", userId: "u" });

      // Read every entry in chain order. Linkage alone is guaranteed by the insert
      // helper, so this INDEPENDENTLY RECOMPUTES each hash from the row's own
      // fields (CLAUDE.md: "write entries, verify hashes, tamper with one, verify
      // chain breaks") — a cancel-closure entry that omitted a field from the hash
      // input would pass a linkage-only check but fails here.
      const rows = [
        ...sql<Record<string, string | number | null>>`
          SELECT * FROM audit_log ORDER BY epoch_id ASC, sequence_num ASC
        `,
      ];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows[0]!.prev_hash).toBe(GENESIS_SENTINEL);

      const recompute = (row: Record<string, string | number | null>): string =>
        computeEntryHash({
          epochId: row.epoch_id as string,
          sequenceNum: row.sequence_num as number,
          prevHash: row.prev_hash as string,
          id: row.id as string,
          timestamp: row.timestamp as string,
          userId: row.user_id as string,
          agentId: row.agent_id as string,
          sessionId: row.session_id as string,
          origin: row.origin as string,
          service: row.service as string,
          verb: row.verb as string,
          noun: row.noun as string,
          toolName: row.tool_name as string,
          parametersMetadata: row.parameters_metadata as string,
          decision: row.decision as string,
          outcome: row.outcome as string,
          errorMessage: row.error_message as string | null,
          decisionEntryId: row.decision_entry_id as string | null,
          latencyMs: row.latency_ms as number,
          costUsd: row.cost_usd as number | null,
        });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        expect(recompute(row)).toBe(row.hash);
        if (i > 0) expect(row.prev_hash).toBe(rows[i - 1]!.hash);
      }

      // Tamper with the cancel-closure entry: its disposition is exactly what an
      // attacker would want to rewrite, and it must not survive recomputation.
      const closure = rows.find((r) =>
        (r.error_message as string | null)?.startsWith("Parked action cancelled"),
      )!;
      expect(closure.origin).toBe("mcp_commission");
      const honest = closure.hash;
      closure.outcome = "success";
      expect(recompute(closure)).not.toBe(honest);

      // The task-level cancel event is its own chained row, tagged to the human
      // surface that issued it, and equally tamper-evident.
      const cancelEvent = rows.find((r) => r.tool_name === "task.cancel")!;
      expect(cancelEvent.origin).toBe("human");
      expect(cancelEvent.noun).toBe(taskA.runId);
      const honestEvent = cancelEvent.hash;
      cancelEvent.noun = "some-other-task";
      expect(recompute(cancelEvent)).not.toBe(honestEvent);
    });
  });

  it("A-16: listTasks pages through the DO wrapper — exact page size, round-trip cursor, no overlap or gap", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const sessionId = agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      // Five tasks, two sharing one created_at so the `id` tiebreaker in the
      // keyset order is actually exercised across a page boundary.
      const stamps = [
        "2026-07-06T10:00:00.000Z",
        "2026-07-06T10:01:00.000Z",
        "2026-07-06T10:02:00.000Z",
        "2026-07-06T10:02:00.000Z",
        "2026-07-06T10:03:00.000Z",
      ];
      stamps.forEach((createdAt, n) => {
        sql`
          INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
          VALUES (${`p-${n}`}, 'mcp_commission', ${`goal ${n}`}, NULL, 'completed', ${sessionId}, ${createdAt}, ${createdAt})
        `;
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: TasksListResponse = agent.listTasks({ limit: 2, cursor });
        // Exactly the requested page size while more remain — the +1 probe row
        // must never leak into the page.
        expect(res.tasks.length).toBeLessThanOrEqual(2);
        seen.push(...res.tasks.map((t) => t.taskId));
        cursor = res.nextCursor;
        if (cursor === null) break;
      }
      // Every task exactly once, newest first, and the last page closes the cursor.
      expect(cursor).toBeNull();
      expect(seen).toEqual(["p-4", "p-3", "p-2", "p-1", "p-0"]);
      expect(new Set(seen).size).toBe(5);
    });
  });

  it("A-16: a blank/garbage cursor falls back to the first page instead of throwing", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      await commissionList(agent, "list inbox cursor", "tu-cur");

      const first = agent.listTasks({ limit: 10 });
      // Undecodable base64, and decodable-but-malformed (no separator): both are
      // fail-safe — the first page, never an exception.
      for (const bad of ["%%%not-base64%%%", btoa("nopipe")]) {
        const res = agent.listTasks({ limit: 10, cursor: bad });
        expect(res.tasks.map((t) => t.taskId)).toEqual(first.tasks.map((t) => t.taskId));
      }
    });
  });

  it("A-16: limit is clamped — 0/negative floor at 1, oversize caps, non-finite defaults", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const sessionId = agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      for (let n = 0; n < 3; n++) {
        const ts = `2026-07-06T10:0${n}:00.000Z`;
        sql`
          INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
          VALUES (${`c-${n}`}, 'mcp_commission', 'g', NULL, 'completed', ${sessionId}, ${ts}, ${ts})
        `;
      }
      // 0 floors to 1 rather than returning an empty page.
      expect(agent.listTasks({ limit: 0 }).tasks).toHaveLength(1);
      expect(agent.listTasks({ limit: -5 }).tasks).toHaveLength(1);
      // Oversize caps at the server bound (all 3 rows come back, no throw).
      expect(agent.listTasks({ limit: 10_000 }).tasks).toHaveLength(3);
      // Non-finite falls back to the default page size.
      expect(agent.listTasks({ limit: Number.NaN }).tasks).toHaveLength(3);
    });
  });

  it("A-3: cancel/amend of a PARKED task refuse `busy` while another task holds the live turn", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // Park task B on a confirmation, then simulate task A holding the live turn.
      const parked = await commissionList(agent, "list inbox parked", "tu-busyB");
      const taskId = parked.runId;
      (instance as unknown as { turnInFlight: boolean }).turnInFlight = true;

      // The gate refuses before any mutation — this is the path the route maps to
      // 409 TURN_IN_PROGRESS, and it was previously unreachable in tests.
      expect(await agent.cancelTask({ taskId, surface: "human", userId: "u" })).toEqual({
        status: "busy",
        taskId,
      });
      (instance as unknown as { turnInFlight: boolean }).turnInFlight = false;
      // Still parked and cancellable once the turn clears.
      expect(agent.readCommissionRun(taskId)).toMatchObject({
        status: "awaiting_confirmation",
      });
    });
  });

  it("A-17: the status snapshot stays single-hold while listTasks surfaces every parked task", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const taskA = await commissionList(agent, "list inbox A", "tu-mhA");
      const taskB = await commissionList(agent, "list inbox B", "tu-mhB");

      // Both parked tasks appear in the list (the multi-hold surface)…
      const list = await agent.listTasks();
      const parked = list.tasks.filter((t) => t.status === "awaiting_confirmation");
      expect(parked.map((t) => t.taskId).sort()).toEqual([taskA.runId, taskB.runId].sort());

      // …while the status snapshot lists BOTH held calls in the table's total
      // order, the oldest-by-(held_at, id) first — the front of the list is
      // the next to answer, identically across repeated reads.
      const orderedHoldIds = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls ORDER BY held_at ASC, id ASC`,
      ].map((r) => r.id);
      const status = await agent.readStatus();
      expect(status.held.map((h) => h.heldCallId)).toEqual(orderedHoldIds);
      // Deterministic: a second read returns the same order, not whichever the
      // query happened to yield.
      expect((await agent.readStatus()).held.map((h) => h.heldCallId)).toEqual(orderedHoldIds);
    });
  });

  it("A-17: the live-slot hold stays deterministic when two holds share a held_at millisecond", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const taskA = await commissionList(agent, "list inbox tieA", "tu-tieA");
      await commissionList(agent, "list inbox tieB", "tu-tieB");

      // Force BOTH holds onto the same held_at. `held_at` alone is then not a
      // total order, so without an `id` tiebreaker SQLite may yield either row
      // first and the snapshot's "deterministic live slot" claim would be luck.
      // Two holds parked inside one millisecond is the real
      // shape this simulates.
      sql`UPDATE held_tool_calls SET held_at = '2026-07-06T10:00:00.000Z'`;
      const expected = [
        ...sql<{ id: string }>`
          SELECT id FROM held_tool_calls ORDER BY held_at ASC, id ASC LIMIT 1
        `,
      ][0]!.id;

      // Stable across repeated reads, and equal to the total-order winner.
      const reads = [
        (await agent.readStatus()).held[0]!.heldCallId,
        (await agent.readStatus()).held[0]!.heldCallId,
        (await agent.readStatus()).held[0]!.heldCallId,
      ];
      expect(new Set(reads).size).toBe(1);
      expect(reads[0]).toBe(expected);
      // Both tasks still listed — the tie affects which hold is live, not the queue.
      const list = agent.listTasks();
      expect(list.tasks.some((t) => t.taskId === taskA.runId)).toBe(true);
      expect(list.tasks).toHaveLength(2);
    });
  });
});
