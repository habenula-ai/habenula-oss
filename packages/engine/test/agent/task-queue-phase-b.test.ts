/**
 * read & iterate. Proves the finer per-action task
 * status + read/list and the needs_input → habenula_provide structured-
 * iteration protocol: a commission missing a required slot parks
 * needs_input naming the published slot (closed vocabulary); habenula_provide
 * binds the value and resumes; a provided-but-un-granted action still routes to
 * confirmation; a human turn never parks needs_input; readTaskDetail/listTasks
 * expose the per-action breakdown. All against real DO SQLite
 * (vitest-pool-workers), no mocks of KV/DO/SQLite/R2 (Hard Invariant 5).
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bindDoSql } from "../helpers/do-sql";
import { seedCiphertext } from "../helpers/seed-credential";
import { MAX_PENDING_COMMISSIONS } from "../../src/agent/user-agent";
import type { UserAgent } from "../../src/agent/user-agent";
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
  // The recipient is bound verbatim from the commission's `to` data slot; the
  // model references it by placeholder rather than composing an address.
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

/** An LLM client that replays a scripted sequence of tool-use / text turns. */
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

describe("read & iterate", () => {
  it("a commission missing a required slot parks needs_input naming the slot; provide binds it and routes to confirmation", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // The commission never runs the LLM a second time: the send parks on
      // needs_input before any resume, and provide re-attempts without the loop.
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-send")] }]));

      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      // parks needs_input rather than awaiting_confirmation.
      expect(parked.status).toBe("needs_input");
      const taskId = (parked as { runId: string }).runId;

      // the awaited key is the published slot `to`, nothing else.
      const detail = await agent.readTaskDetail(taskId);
      expect(detail?.awaitedSlotKeys).toEqual(["to"]);
      expect(detail?.task.status).toBe("needs_input");

      // provide binds the value and resumes the task.
      const provided = await agent.provideTaskInput({
        taskId,
        data: { to: "ceo@acme.test" },
        userId: "u",
        agentId: "onboarding",
      });
      // the bound value still needs a grant, so it routes to confirmation
      // (bind ≠ grant) rather than executing unattended.
      expect(provided).toEqual({ taskId, status: "awaiting_confirmation" });

      // The task no longer awaits input, and exactly one hold stands (the
      // confirmation hold the resume created; the input hold was swept).
      const after = await agent.readTaskDetail(taskId);
      expect(after?.task.status).toBe("awaiting_confirmation");
      expect(after?.awaitedSlotKeys).toBeNull();
    });
  });

  it("a human chat turn invoking a required-slot tool never parks needs_input", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(
        scripted([{ tools: [sendToolUse("tu-h")] }, { text: "ok" }]),
      );

      const result = await agent.chat({ message: "send an email", userId: "u" });

      // The human turn parked on a confirmation hold, not needs_input.
      expect("busy" in result).toBe(false);
      if (!("busy" in result)) {
        expect(result.held?.heldCallId).toBeTruthy();
      }
      // No task was moved to needs_input — the gate is runId-scoped.
      const needsInput = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM commission_runs WHERE status = 'needs_input'`,
      ][0]!.n;
      expect(needsInput).toBe(0);
      // A human turn creates no task record and no input hold at all.
      const inputHolds = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE hold_kind = 'input'`,
      ][0]!.n;
      expect(inputHolds).toBe(0);
    });
  });

  it("readTaskDetail reports the per-action breakdown and listTasks lists the task", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      // A real credential so the approved list actually dispatches (executed),
      // exercising the per-action detail's success path.
      agent.connectService("mock_email", await seedCiphertext());
      agent.setLLMClient(
        scripted([{ tools: [listToolUse("tu-l")] }, { text: "done" }]),
      );

      const task = await agent.commissionGoal({
        goal: "list my inbox",
        userId: "u",
        agentId: "onboarding",
      });
      expect(task.status).toBe("awaiting_confirmation");
      const taskId = (task as { runId: string }).runId;

      // Approve the held list (session grant) so it dispatches; the per-action
      // detail records the executed action.
      const heldId = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${taskId}`,
      ][0]!.id;
      await agent.resolveConfirmation({
        heldCallId: heldId,
        choice: "session",
        userId: "u",
      });

      const detail = await agent.readTaskDetail(taskId);
      expect(detail).not.toBeNull();
      expect(detail!.task.status).toBe("completed");
      expect(detail!.statusDetail).toEqual([
        { service: "mock_email", verb: "list", noun: "INBOX", outcome: "executed" },
      ]);

      const list = await agent.listTasks();
      const listed = list.tasks.find((t) => t.taskId === taskId);
      expect(listed).toBeDefined();
      expect(listed!.origin).toBe("mcp_commission");
      expect(listed!.status).toBe("completed");
    });
  });

  it("provideTaskInput refuses an unpublished data key (closed vocabulary)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      await expect(
        agent.provideTaskInput({
          taskId: "any",
          data: { recipient: "a@b.c" },
          userId: "u",
        }),
      ).rejects.toThrow("unpublished data keys: recipient");
    });
  });

  it("provideTaskInput on a task that is not awaiting input reports its current status", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      agent.setLLMClient(
        scripted([{ tools: [listToolUse("tu-x")] }]),
      );
      // A list commission parks on confirmation (awaiting_confirmation), not
      // needs_input — providing input is not applicable.
      const task = await agent.commissionGoal({
        goal: "list inbox",
        userId: "u",
        agentId: "onboarding",
      });
      const taskId = (task as { runId: string }).runId;

      const out = await agent.provideTaskInput({
        taskId,
        data: { to: "a@b.c" },
        userId: "u",
      });
      expect(out).toEqual({
        status: "not_awaiting_input",
        currentStatus: "awaiting_confirmation",
      });
    });
  });

  it("needs_input tasks count toward MAX_PENDING_COMMISSIONS (no cap bypass)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // Every underspecified send parks needs_input before any resume, so one
      // scripted send step suffices for all of them.
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-cap")] }]));

      // Fill the pending-commission queue with needs_input tasks.
      for (let n = 0; n < MAX_PENDING_COMMISSIONS; n++) {
        const r = await agent.commissionGoal({
          goal: `email ${n} to {{data.to}}`,
          userId: "u",
          agentId: "onboarding",
        });
        expect(r.status).toBe("needs_input");
      }
      // The next commission is backpressured — needs_input tasks are pending
      // and count toward the cap (DoS bound).
      const overflow = await agent.commissionGoal({
        goal: "email overflow to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      expect(overflow.status).toBe("busy");
    });
  });

  it("a needs_input run expires with its session (hold swept, run not left stuck)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-exp")] }]));

      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      expect(parked.status).toBe("needs_input");
      const taskId = (parked as { runId: string }).runId;

      // Age the run's session past the 90-min cap and reap.
      const sid = [
        ...sql<{ session_id: string }>`SELECT session_id FROM commission_runs WHERE id = ${taskId}`,
      ][0]!.session_id;
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      sql`UPDATE session_state SET started_at = ${old} WHERE session_id = ${sid}`;
      agent.reapExpiredSessions();

      // The input hold is swept AND the run resolves to expired — never left
      // stuck at needs_input against a dead session.
      const holds = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls WHERE run_id = ${taskId}`,
      ][0]!.n;
      expect(holds).toBe(0);
      expect(agent.readCommissionRun(taskId)).toMatchObject({
        runId: taskId,
        status: "expired",
      });
      const detail = await agent.readTaskDetail(taskId);
      expect(detail!.task.status).toBe("expired");
    });
  });

  it("habenula_provide closes the input hold's pending audit entry (no dangling pending)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-audit")] }]));

      const parked = await agent.commissionGoal({
        goal: "email to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      const taskId = (parked as { runId: string }).runId;
      const parkPendingId = [
        ...sql<{ pending_audit_entry_id: string }>`SELECT pending_audit_entry_id FROM held_tool_calls WHERE run_id = ${taskId} AND hold_kind = 'input'`,
      ][0]!.pending_audit_entry_id;

      await agent.provideTaskInput({
        taskId,
        data: { to: "ceo@acme.test" },
        userId: "u",
        agentId: "onboarding",
      });

      // The park's `pending` entry is now closed by a terminal that references
      // it via decision_entry_id — no dangling pending survives the resume.
      const park = [
        ...sql<{ decision: string }>`SELECT decision FROM audit_log WHERE id = ${parkPendingId}`,
      ][0]!;
      expect(park.decision).toBe("pending");
      const closers = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log WHERE decision_entry_id = ${parkPendingId}`,
      ][0]!.n;
      expect(closers).toBe(1);
    });
  });

  it("a provide arriving after the session lapse refuses instead of resurrecting the task", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-lapse")] }]));

      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      const taskId = (parked as { runId: string }).runId;

      // Age the session past the 90-min cap — but do NOT reap explicitly. The
      // provide must reap-first internally and refuse the lapsed task.
      const sid = [
        ...sql<{ session_id: string }>`SELECT session_id FROM commission_runs WHERE id = ${taskId}`,
      ][0]!.session_id;
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      sql`UPDATE session_state SET started_at = ${old} WHERE session_id = ${sid}`;

      const out = await agent.provideTaskInput({
        taskId,
        data: { to: "ceo@acme.test" },
        userId: "u",
        agentId: "onboarding",
      });
      // Refused as expired — no resurrection.
      expect(out).toEqual({ status: "not_awaiting_input", currentStatus: "expired" });
      // No confirmation hold left approvable against the expired run, and no
      // fresh session was minted as a side effect.
      const holds = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`,
      ][0]!.n;
      expect(holds).toBe(0);
      const openSessions = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_state WHERE ended_at IS NULL`,
      ][0]!.n;
      expect(openSessions).toBe(0);
    });
  });

  it("provide → approve resumes the conversation to a clean terminal (single dispatch, graft fidelity)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      // A credential WITH email.send scope so the approved send dispatches clean.
      agent.connectService(
        "mock_email",
        await seedCiphertext({ scopes: ["email.read", "email.send"] }),
      );
      let calls = 0;
      const client: LLMClient = {
        async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
          calls++;
          if (calls === 1) {
            return {
              id: "m1",
              content: [sendToolUse("tu-f2")],
              stop_reason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          return {
            id: `m${calls}`,
            content: [{ type: "text", text: "sent" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      };
      agent.setLLMClient(client);

      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      const taskId = (parked as { runId: string }).runId;
      expect(calls).toBe(1);

      const provided = await agent.provideTaskInput({
        taskId,
        data: { to: "ceo@acme.test" },
        userId: "u",
        agentId: "onboarding",
      });
      expect(provided).toEqual({ taskId, status: "awaiting_confirmation" });
      expect(calls).toBe(1); // provide re-attempts without the LLM

      const heldId = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${taskId} AND hold_kind = 'confirmation'`,
      ][0]!.id;
      const res = await agent.resolveConfirmation({
        heldCallId: heldId,
        choice: "session",
        userId: "u",
      });
      // Graft fidelity: the resume re-entered the conversation loop (calls→2),
      // not directExecute isolation.
      expect(calls).toBe(2);
      expect(res.status).toBe("resumed");

      const detail = await agent.readTaskDetail(taskId);
      expect(detail!.task.status).toBe("completed");
      // The send dispatched exactly ONCE (substituted recipient), no double-exec.
      // The send noun is the full lower-cased recipient address.
      expect(detail!.statusDetail).toEqual([
        { service: "mock_email", verb: "send", noun: "ceo@acme.test", outcome: "executed" },
      ]);
      const holds = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`,
      ][0]!.n;
      expect(holds).toBe(0);
    });
  });

  it("provide with only unawaited (but published) keys is refused, without churning the task", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [sendToolUse("tu-f3")] }]));

      const parked = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId: "u",
        agentId: "onboarding",
      });
      const taskId = (parked as { runId: string }).runId;
      const auditBefore = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`,
      ][0]!.n;

      // `mailbox` is published but not what this task awaits (`to`).
      const out = await agent.provideTaskInput({
        taskId,
        data: { mailbox: "INBOX" },
        userId: "u",
        agentId: "onboarding",
      });
      expect(out).toEqual({ status: "no_matching_slot", awaitedSlotKeys: ["to"] });

      // The task stayed parked on needs_input and nothing was written — no churn.
      expect(agent.readCommissionRun(taskId)).toMatchObject({
        runId: taskId,
        status: "needs_input",
      });
      const auditAfter = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`,
      ][0]!.n;
      expect(auditAfter).toBe(auditBefore);
    });
  });
});
