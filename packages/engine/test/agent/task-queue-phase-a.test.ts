/**
 * safe multi-task core. Proves the DO is safe for
 * several tasks before queue depth rises above one: per-task conversation
 * isolation (anti-bleed), the per-task chat guard, the bounded commission cap
 * (human never capped, crash-orphans never consume a slot), and additive-schema
 * migration idempotency. All against real DO SQLite (vitest-pool-workers).
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bindDoSql } from "../helpers/do-sql";
import { insertSessionState } from "../../src/data/helpers/session-state";
import * as runsData from "../../src/data/helpers/commission-runs";
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

function toolUse(id: string, input: Record<string, unknown>): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input };
}

/** An LLM client that snapshots the messages it sees per call, then replays a script. */
function capturing(script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>) {
  const snapshots: string[] = [];
  let i = 0;
  const client: LLMClient = {
    async createMessage(p: LLMCreateParams): Promise<LLMResponse> {
      snapshots.push(JSON.stringify(p.messages));
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
  return { client, snapshots };
}

const MAX = 8; // MAX_PENDING_COMMISSIONS

describe("safe multi-task core", () => {
  it("migrate() is idempotent: additive columns exist exactly once, re-run never throws", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as { migrate(): void };
      const sql = bindDoSql(instance as never);
      // The constructor already ran migrate() once; running it again must be a
      // no-op (guarded PRAGMA), not a duplicate-column throw.
      expect(() => agent.migrate()).not.toThrow();
      expect(() => agent.migrate()).not.toThrow();

      const runCols = [
        ...sql<{ name: string }>`PRAGMA table_info(commission_runs)`,
      ].map((c) => c.name);
      expect(runCols.filter((n) => n === "label")).toHaveLength(1);
      expect(runCols).toContain("status_detail");
      expect(runCols).toContain("awaited_slot_keys");

      const heldCols = [
        ...sql<{ name: string }>`PRAGMA table_info(held_tool_calls)`,
      ].map((c) => c.name);
      expect(heldCols.filter((n) => n === "hold_kind")).toHaveLength(1);
      expect(heldCols).toContain("awaited_slot_keys");
      // Additive column, same exactly-once assertion as the original set.
      expect(heldCols.filter((n) => n === "spend_context")).toHaveLength(1);
    });
  });

  it("anti-bleed: a fresh human chat turn never sees a parked commission's content", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      const { client, snapshots } = capturing([
        { tools: [toolUse("tu-a", { label: "INBOX" })] }, // commission parks
        { text: "human reply" }, // human chat turn
      ]);
      agent.setLLMClient(client);

      const parked = await agent.commissionGoal({
        goal: "COMMISSION_MARKER read my private inbox",
        userId: "u",
        agentId: "onboarding",
      });
      expect(parked.status).toBe("awaiting_confirmation");

      await agent.chat({ message: "HUMAN_MARKER what is the weather", userId: "u" });

      // snapshots[0] is the commission turn; snapshots[1] is the human turn.
      expect(snapshots[0]).toContain("COMMISSION_MARKER");
      expect(snapshots[1]).toContain("HUMAN_MARKER");
      // The human turn must not carry any of the commission's conversation.
      expect(snapshots[1]).not.toContain("COMMISSION_MARKER");
    });
  });

  it("isolation: resuming one parked commission restores its own context, never the other's", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const { client, snapshots } = capturing([
        { tools: [toolUse("tu-alpha", { label: "ALPHA_MARKER" })] }, // A parks
        { tools: [toolUse("tu-beta", { label: "BETA_MARKER" })] }, // B parks
        { text: "alpha resumed" }, // resume of A re-enters the loop
      ]);
      agent.setLLMClient(client);

      const a = await agent.commissionGoal({
        goal: "ALPHA_MARKER goal",
        userId: "u",
        agentId: "onboarding",
      });
      const b = await agent.commissionGoal({
        goal: "BETA_MARKER goal",
        userId: "u",
        agentId: "onboarding",
      });
      expect(a.status).toBe("awaiting_confirmation");
      expect(b.status).toBe("awaiting_confirmation");

      // Two commissions parked at once — the one-held-row lift.
      const heldCount = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`,
      ][0]!.n;
      expect(heldCount).toBe(2);

      // Resolve A (deny) → resume re-enters the loop for A only.
      const aRunId = (a as { runId: string }).runId;
      const aHeld = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${aRunId}`,
      ][0]!.id;
      await agent.resolveConfirmation({ heldCallId: aHeld, choice: "deny", userId: "u" });

      // snapshots[2] is A's resume: it must carry A's conversation, not B's.
      expect(snapshots[2]).toContain("ALPHA_MARKER");
      expect(snapshots[2]).not.toContain("BETA_MARKER");
    });
  });

  it("status is single-valued across concurrent holds: one surfaces at a time, resolving it reveals the next (no data loss)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // Two commissions park two holds; the 3rd script step lets the resumed one
      // complete with text (deny re-enters the loop).
      agent.setLLMClient(
        capturing([
          { tools: [toolUse("tu-alpha", { label: "ALPHA" })] },
          { tools: [toolUse("tu-beta", { label: "BETA" })] },
          { text: "resumed" },
        ]).client,
      );

      const a = await agent.commissionGoal({ goal: "alpha", userId: "u", agentId: "onboarding" });
      const b = await agent.commissionGoal({ goal: "beta", userId: "u", agentId: "onboarding" });
      expect(a.status).toBe("awaiting_confirmation");
      expect(b.status).toBe("awaiting_confirmation");

      const aHeld = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${(a as { runId: string }).runId}`,
      ][0]!.id;
      const bHeld = [
        ...sql<{ id: string }>`SELECT id FROM held_tool_calls WHERE run_id = ${(b as { runId: string }).runId}`,
      ][0]!.id;
      expect(aHeld).not.toBe(bHeld);

      // The status snapshot lists BOTH parked holds — every question awaiting
      // an answer is visible at once, none hidden behind the other. (The two
      // park inside the same millisecond here, so their relative order falls
      // to the id tiebreak; assert membership, not order.)
      const listed = agent.readStatus().held;
      expect(listed.map((h) => h.heldCallId).sort()).toEqual([aHeld, bHeld].sort());

      // Resolving the front of the list leaves the other one, alone.
      const first = listed[0]!;
      await agent.resolveConfirmation({ heldCallId: first.heldCallId, choice: "deny", userId: "u" });
      const remaining = first.heldCallId === aHeld ? bHeld : aHeld;
      expect(agent.readStatus().held.map((h) => h.heldCallId)).toEqual([remaining]);
    });
  });

  it("chat guard is per-task: a human turn proceeds while a commission hold is parked", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      agent.setLLMClient(
        capturing([
          { tools: [toolUse("tu-c", { label: "INBOX" })] },
          { text: "proceeded" },
        ]).client,
      );

      await agent.commissionGoal({ goal: "g", userId: "u", agentId: "onboarding" });
      const result = await agent.chat({ message: "hello", userId: "u" });

      // Not the held-refusal shape (iterations 0 + held set): the turn ran.
      expect("busy" in result).toBe(false);
      if (!("busy" in result)) {
        expect(result.held).toBeUndefined();
        expect(result.iterations).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("chat guard is per-task: a human turn is still refused when the HUMAN task has a parked hold", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // A direct executeTool hold has no runId → it is the human task's hold.
      const held = await agent.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "u",
        agentId: "agent-1",
      });
      expect(held.held?.heldCallId).toBeTruthy();

      const result = await agent.chat({ message: "hello", userId: "u" });
      expect("busy" in result).toBe(false);
      if (!("busy" in result)) {
        expect(result.iterations).toBe(0);
        expect(result.held?.heldCallId).toBe(held.held!.heldCallId);
      }
    });
  });

  it("bounded cap: the (MAX+1)-th pending commission is refused busy; earlier ones admit", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const now = new Date().toISOString();
      // Seed one active (not-ended) session and MAX pending commission runs on
      // it — the queue at capacity.
      insertSessionState(sql, "s-active", now, "onboarding");
      for (let n = 0; n < MAX; n++) {
        runsData.insertCommissionRun(sql, {
          id: `run-${n}`,
          goal: `goal ${n}`,
          data: null,
          sessionId: "s-active",
          createdAt: now,
        });
        runsData.updateCommissionStatus(sql, `run-${n}`, "awaiting_confirmation", now);
      }

      const refused = await agent.commissionGoal({
        goal: "one too many",
        userId: "u",
        agentId: "onboarding",
      });
      expect(refused).toEqual({ status: "busy", reason: "commission_pending" });
    });
  });

  it("bounded cap boundary: the MAX-th pending commission still admits (seam is MAX-1 admit / MAX refuse)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const now = new Date().toISOString();
      agent.connectService("mock_email");
      // Seed exactly MAX-1 pending commissions: one slot remains, so the next
      // one must admit. Paired with the MAX+1 refusal test above, this pins the
      // cap precisely at the seam rather than only somewhere past it.
      insertSessionState(sql, "s-active", now, "onboarding");
      for (let n = 0; n < MAX - 1; n++) {
        runsData.insertCommissionRun(sql, {
          id: `run-${n}`,
          goal: `goal ${n}`,
          data: null,
          sessionId: "s-active",
          createdAt: now,
        });
        runsData.updateCommissionStatus(sql, `run-${n}`, "awaiting_confirmation", now);
      }
      agent.setLLMClient(capturing([{ text: "done, nothing to do" }]).client);

      const out = await agent.commissionGoal({
        goal: "the MAX-th",
        userId: "u",
        agentId: "onboarding",
      });
      // Admitted, not refused: it ran to completion rather than returning busy.
      expect(out.status).toBe("completed");
    });
  });

  it("human is never capped: a chat turn is admitted while the commission queue is full", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const now = new Date().toISOString();
      agent.connectService("mock_email");
      insertSessionState(sql, "s-active", now, "onboarding");
      for (let n = 0; n < MAX; n++) {
        runsData.insertCommissionRun(sql, {
          id: `run-${n}`,
          goal: `goal ${n}`,
          data: null,
          sessionId: "s-active",
          createdAt: now,
        });
        runsData.updateCommissionStatus(sql, `run-${n}`, "awaiting_confirmation", now);
      }
      agent.setLLMClient(capturing([{ text: "hi there" }]).client);

      const result = await agent.chat({ message: "hello", userId: "u" });
      expect("busy" in result).toBe(false);
      if (!("busy" in result)) {
        expect(result.iterations).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("crash-orphaned running rows are reconciled and never consume a cap slot", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const now = new Date().toISOString();
      agent.connectService("mock_email");
      insertSessionState(sql, "s-active", now, "onboarding");
      // MAX runs left `running` with NO live hold: each is crash-orphaned and
      // reconciles to `failed`, so none counts toward the cap.
      for (let n = 0; n < MAX; n++) {
        runsData.insertCommissionRun(sql, {
          id: `orphan-${n}`,
          goal: `goal ${n}`,
          data: null,
          sessionId: "s-active",
          createdAt: now,
        });
      }
      agent.setLLMClient(capturing([{ text: "done, nothing to do" }]).client);

      // Despite MAX running rows, a new commission is admitted (they were fake).
      const out = await agent.commissionGoal({
        goal: "real work",
        userId: "u",
        agentId: "onboarding",
      });
      expect(out.status).toBe("completed");

      const failed = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM commission_runs WHERE status = 'failed'`,
      ][0]!.n;
      expect(failed).toBe(MAX);
    });
  });
});
