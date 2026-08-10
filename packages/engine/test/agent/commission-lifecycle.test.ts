/**
 * The commission core: commissionGoal's admission
 * order and hold cycle, the pinned terminal mapping over run-cumulative
 * outcomes, the one-unresolved-commission cap, read-time + sweep expiry, the
 * mcp_commission session genesis, and verbatim {{data.<key>}} binding on both
 * the loop and resolve paths.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bindDoSql } from "../helpers/do-sql";
import { seedCiphertext } from "../helpers/seed-credential";
import { insertSessionState, markSessionEnded } from "../../src/data/helpers/session-state";
import { composeCommissionMessage, type UserAgent } from "../../src/agent/user-agent";
import * as runsData from "../../src/data/helpers/commission-runs";
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

function toolUse(input: Record<string, unknown>): LLMToolUseBlock {
  return { type: "tool_use", id: "tu-1", name: "mock_email_list", input };
}

function scripted(
  script: Array<{ tools?: LLMToolUseBlock[]; text?: string; throw?: boolean }>,
): LLMClient {
  let i = 0;
  return {
    async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.throw) throw new Error("scripted LLM failure");
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
}

function controllable(script: Array<LLMToolUseBlock[] | string | null>) {
  let i = 0;
  let release: ((r: LLMResponse) => void) | null = null;
  const client: LLMClient = {
    createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step === null) {
        return new Promise<LLMResponse>((resolve) => {
          release = resolve;
        });
      }
      if (typeof step === "string") {
        return Promise.resolve({
          id: `m${i}`,
          content: [{ type: "text", text: step }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      return Promise.resolve({
        id: `m${i}`,
        content: step,
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  };
  return {
    client,
    release: (text: string) =>
      release!({
        id: "mr",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  };
}

const GOAL = "list the inbox and summarize";

describe("commissionGoal lifecycle", () => {
  it("the confirmation record shows substituted values, never the placeholder (C1)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      agent.setLLMClient(
        scripted([{ tools: [toolUse({ label: "{{data.mailbox}}" })] }]),
      );
      await agent.commissionGoal({
        goal: "list the mailbox I named",
        data: { mailbox: "INBOX" },
        userId: "u",
        agentId: "onboarding",
      });
      const held = agent.readStatus().held[0]!;
      // the approval surface sees the real client-supplied value — the same
      // binding the grant, audit, and dispatch see
      expect(held.noun).toBe("INBOX");
      expect(held.params).toEqual({ label: "INBOX" });
    });
  });

  it("crash repair reports awaiting, not failed, when the run's hold survived (C2)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const sessionId = agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      // isolate died between the held-park and the awaiting write:
      runsData.insertCommissionRun(sql, {
        id: "run-parked",
        goal: "g",
        data: null,
        sessionId,
        createdAt: new Date().toISOString(),
      });
      const pending = agent.writeAuditEntry({
        userId: "u", agentId: "onboarding", sessionId,
        toolName: "mock_email_list", service: "mock_email", verb: "list",
        noun: "INBOX", decision: "pending", origin: "mcp_commission",
        parametersMetadata: {}, outcome: "success", latencyMs: 0,
      });
      const { insertHeldToolCall } = await import("../../src/data/helpers/held-tool-calls");
      insertHeldToolCall(sql, "h-parked", sessionId, pending.id, new Date().toISOString(), "run-parked");

      expect(agent.readCommissionRun("run-parked")).toMatchObject({
        runId: "run-parked",
        status: "awaiting_confirmation",
      });
    });
  });

  it("the cap applies the ended-session belt and admits a fresh commission", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // a stranded awaiting run on an ended session (lost sweep)
      insertSessionState(sql, "s-lost", new Date().toISOString(), "onboarding");
      runsData.insertCommissionRun(sql, {
        id: "run-stranded", goal: "g", data: null,
        sessionId: "s-lost", createdAt: new Date().toISOString(),
      });
      runsData.updateCommissionStatus(sql, "run-stranded", "awaiting_confirmation", new Date().toISOString());
      markSessionEnded(sql, "s-lost", new Date().toISOString());

      agent.setLLMClient(scripted([{ text: "done" }]));
      const out = await agent.commissionGoal({
        goal: "fresh", userId: "u", agentId: "onboarding",
      });
      expect(out.status).toBe("completed");
      expect(runsData.readCommissionRun(sql, "run-stranded")!.status).toBe("expired");
    });
  });

  it("a parked commission no longer blocks a second (one-at-a-time lifted)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // First commission parks on an un-granted action.
      agent.setLLMClient(
        scripted([{ tools: [toolUse({ label: "INBOX" })] }, { text: "done" }]),
      );
      const first = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      expect(first.status).toBe("awaiting_confirmation");
      // This second commission was previously refused (held_call_pending / one-at-a-time).
      // It is now admitted: a parked hold no longer blocks, and 1 pending is far
      // under MAX_PENDING_COMMISSIONS.
      const second = await agent.commissionGoal({
        goal: "another",
        userId: "u",
        agentId: "onboarding",
      });
      expect(second.status).toBe("completed");
      const runs = [
        ...sql<{ n: number }>`SELECT COUNT(*) AS n FROM commission_runs`,
      ];
      expect(runs[0]!.n).toBe(2);
    });
  });

  it("DO-side caps reject oversized goal and data fail-closed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      await expect(
        agent.commissionGoal({ goal: "g".repeat(4001), userId: "u", agentId: "onboarding" }),
      ).rejects.toThrow("goal length out of bounds");
      await expect(
        agent.commissionGoal({
          goal: "g",
          data: { mailbox: "x".repeat(16001) },
          userId: "u",
          agentId: "onboarding",
        }),
      ).rejects.toThrow("data values exceed");
    });
  });

  it("mid-turn session resurrection under a commission tags session.start mcp_commission", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // call 1 hangs, then releases WITH a tool_use so the turn's next
      // executeTool runs after the quit; call 2 ends the turn
      let release: ((r: LLMResponse) => void) | null = null;
      let call = 0;
      agent.setLLMClient({
        createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
          call++;
          if (call === 1) {
            return new Promise<LLMResponse>((res) => {
              release = res;
            });
          }
          return Promise.resolve({
            id: "m2",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });

      const pending = agent.commissionGoal({ goal: GOAL, userId: "u", agentId: "onboarding" });
      // quit lands mid-turn; the turn's next executeTool resurrects a session
      agent.endSession("quit");
      release!({
        id: "m1",
        content: [toolUse({ label: "INBOX" })],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const out = await pending;
      // the run was expired by the quit sweep; the reported status is the row
      expect((out as { status: string }).status).toBe("expired");
      const starts = [
        ...sql<{ origin: string }>`
          SELECT origin FROM audit_log WHERE tool_name = 'session.start'
          ORDER BY sequence_num ASC
        `,
      ];
      expect(starts.length).toBe(2);
      expect(starts[1]!.origin).toBe("mcp_commission");
    });
  });

  it("rejects unpublished data keys at the DO, fail-closed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      await expect(
        agent.commissionGoal({
          goal: "g",
          data: { recipient: "a@b.c" },
          userId: "u",
          agentId: "onboarding",
        }),
      ).rejects.toThrow("unpublished data keys: recipient");
    });
  });

  it("expires runs on the kill, timeout-reap, and superseded end paths", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");

      // kill: an awaiting commission's run expires with the session
      agent.setLLMClient(scripted([{ tools: [toolUse({ label: "INBOX" })] }]));
      const killHeld = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      const killRun = (killHeld as { runId: string }).runId;
      agent.killSwitch();
      expect(runsData.readCommissionRun(sql, killRun)!.status).toBe("expired");

      // timeout reap: a run on a past-cap session expires at the next reap
      const oldStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      insertSessionState(sql, "s-capped", oldStart, "onboarding");
      runsData.insertCommissionRun(sql, {
        id: "run-capped",
        goal: "g",
        data: null,
        sessionId: "s-capped",
        createdAt: oldStart,
      });
      runsData.updateCommissionStatus(sql, "run-capped", "awaiting_confirmation", oldStart);
      agent.reapExpiredSessions();
      expect(runsData.readCommissionRun(sql, "run-capped")!.status).toBe("expired");

      // superseded: the tie-break reap ends a stale open session's runs
      insertSessionState(sql, "s-stale", new Date(Date.now() - 1000).toISOString(), "onboarding");
      insertSessionState(sql, "s-newer", new Date().toISOString(), "onboarding");
      runsData.insertCommissionRun(sql, {
        id: "run-stale",
        goal: "g",
        data: null,
        sessionId: "s-stale",
        createdAt: new Date().toISOString(),
      });
      agent.resolveActiveSession({ userId: "u", agentId: "onboarding" });
      expect(runsData.readCommissionRun(sql, "run-stale")!.status).toBe("expired");
    });
  });

  it("read-time belt: a lost sweep still reports expired against an ended session", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [toolUse({ label: "INBOX" })] }]));
      const held = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      const runId = (held as { runId: string }).runId;
      const run = runsData.readCommissionRun(sql, runId)!;
      // simulate a LOST sweep (kill TX2 swallowed): the session is marked
      // ended, but the run sweep never happened
      markSessionEnded(sql, run.session_id, new Date().toISOString());
      expect(runsData.readCommissionRun(sql, runId)!.status).toBe(
        "awaiting_confirmation",
      );
      // the belt fires at read time
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "expired" });
    });
  });

  it("absorbing terminals through the DO: quit mid-turn beats the turn's later completed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      const llm = controllable([null]);
      agent.setLLMClient(llm.client);

      const pending = agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      // quit lands mid-turn (endSession is ungated by design)
      const ended = agent.endSession("quit");
      expect(ended).toEqual({ ended: true });
      llm.release("finished anyway");
      const out = await pending;
      const runId = (out as { runId: string }).runId;
      // the straddling turn tried to write completed; expired absorbed it —
      // and the RETURNED status reports the row, not the intent
      expect(out).toEqual({ runId, status: "expired" });
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "expired" });
    });
  });

  it("busy turn_in_flight creates no run row", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      const llm = controllable([null]);
      agent.setLLMClient(llm.client);

      const chatTurn = agent.chat({ message: "hi", userId: "u" });
      const refused = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      expect(refused).toEqual({ status: "busy", reason: "turn_in_flight" });
      const rows = [...sql<{ n: number }>`SELECT COUNT(*) AS n FROM commission_runs`];
      expect(rows[0]!.n).toBe(0);
      llm.release("done");
      await chatTurn;
    });
  });

  it("resume rebinding: a post-resolve LLM call's placeholder substitutes from the persisted map", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email", await seedCiphertext());
      // call 1 holds on INBOX; the RESUME's next call emits a placeholder,
      // which must substitute via the loop closure's persisted-map rebind
      agent.setLLMClient(
        scripted([
          { tools: [toolUse({ label: "INBOX" })] },
          { tools: [{ type: "tool_use", id: "tu-2", name: "mock_email_list", input: { label: "{{data.mailbox}}" } }] },
          { text: "both listed" },
        ]),
      );
      const held = await agent.commissionGoal({
        goal: "list twice",
        data: { mailbox: "INBOX" },
        userId: "u",
        agentId: "onboarding",
      });
      const runId = (held as { runId: string }).runId;
      const resolved = await agent.resolveConfirmation({
        heldCallId: agent.heldCallId()!,
        choice: "session",
        userId: "u",
      });
      expect(resolved.status).toBe("resumed");
      // the second call's audit rows carry the substituted noun and succeeded
      // under the session grant minted for INBOX
      const allows = [
        ...sql<{ noun: string; outcome: string }>`
          SELECT noun, outcome FROM audit_log
          WHERE decision = 'allow' AND tool_name = 'mock_email_list' AND decision_entry_id IS NOT NULL
          ORDER BY sequence_num ASC
        `,
      ];
      expect(allows.length).toBe(2);
      expect(allows.every((r) => r.noun === "INBOX" && r.outcome === "success")).toBe(true);
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "completed" });
    });
  });

  it("leaves prototype-member placeholders verbatim — own keys only", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // model emits an inherited-member placeholder; it must NOT substitute
      agent.setLLMClient(
        scripted([{ tools: [toolUse({ label: "{{data.constructor}}" })] }]),
      );
      const out = await agent.commissionGoal({
        goal: "g",
        data: { mailbox: "INBOX" },
        userId: "u",
        agentId: "onboarding",
      });
      expect(out.status).toBe("awaiting_confirmation");
      const [pendingRow] = [
        ...sql<{ noun: string }>`
          SELECT noun FROM audit_log WHERE decision = 'pending'
          ORDER BY sequence_num DESC LIMIT 1
        `,
      ];
      // the placeholder stayed verbatim (a garbage noun, denied by policy) —
      // never the inherited Object constructor
      expect(pendingRow!.noun).toBe("{{data.constructor}}");
    });
  });

  it("repairs a crash-orphaned running run at read time and at the cap", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      // simulate an isolate death mid-turn: a `running` row with no turn in
      // flight (the marker died with the isolate)
      const sessionId = agent.resolveActiveSession({
        userId: "u",
        agentId: "onboarding",
      });
      runsData.insertCommissionRun(sql, {
        id: "orphan-run",
        goal: "g",
        data: null,
        sessionId,
        createdAt: new Date().toISOString(),
      });

      // read-time repair: running + no marker can only mean a crash
      expect(agent.readCommissionRun("orphan-run")).toMatchObject({
        runId: "orphan-run",
        status: "failed",
      });

      // and the cap does not stay blocked by a dead run either
      runsData.insertCommissionRun(sql, {
        id: "orphan-run-2",
        goal: "g",
        data: null,
        sessionId,
        createdAt: new Date().toISOString(),
      });
      agent.setLLMClient(scripted([{ text: "done" }]));
      const out = await agent.commissionGoal({
        goal: "fresh goal",
        userId: "u",
        agentId: "onboarding",
      });
      expect(out.status).toBe("completed");
      expect(runsData.readCommissionRun(sql, "orphan-run-2")!.status).toBe(
        "failed",
      );
    });
  });

  it("holds an un-granted action: run linked, session genesis tagged", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [toolUse({ label: "INBOX" })] }]));

      const out = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      expect(out.status).toBe("awaiting_confirmation");
      const runId = (out as { runId: string }).runId;

      // run record: origin + goal + session-linked
      const run = runsData.readCommissionRun(sql, runId)!;
      expect(run.origin).toBe("mcp_commission");
      expect(run.goal).toBe(GOAL);
      expect(run.status).toBe("awaiting_confirmation");

      // held row carries the run link
      const [heldRow] = [
        ...sql<{ run_id: string | null }>`SELECT run_id FROM held_tool_calls`,
      ];
      expect(heldRow!.run_id).toBe(runId);

      // commission-genesis session.start is tagged mcp_commission
      const [start] = [
        ...sql<{ origin: string }>`
          SELECT origin FROM audit_log WHERE tool_name = 'session.start' LIMIT 1
        `,
      ];
      expect(start!.origin).toBe("mcp_commission");

      expect(agent.readCommissionRun(runId)).toMatchObject({
        runId,
        status: "awaiting_confirmation",
      });
      expect(agent.readCommissionRun("absent")).toBeNull();
    });
  });

  it("maps terminals: text-only → completed, denied resolve → denied, thrown turn → failed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");

      // zero-action completion
      agent.setLLMClient(scripted([{ text: "nothing to do" }]));
      const done = await agent.commissionGoal({
        goal: "just answer",
        userId: "u",
        agentId: "onboarding",
      });
      expect(done.status).toBe("completed");

      // deny-resolve → denied (cumulative outcomes: one attempted, refused)
      agent.setLLMClient(
        scripted([{ tools: [toolUse({ label: "INBOX" })] }, { text: "understood" }]),
      );
      const held = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      const runId = (held as { runId: string }).runId;
      const heldId = agent.heldCallId()!;
      const resolved = await agent.resolveConfirmation({
        heldCallId: heldId,
        choice: "deny",
        userId: "u",
      });
      expect(resolved.status).toBe("resumed");
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "denied" });

      // thrown fresh turn → failed
      agent.setLLMClient(scripted([{ throw: true }]));
      const failed = await agent.commissionGoal({
        goal: "boom",
        userId: "u",
        agentId: "onboarding",
      });
      expect(failed.status).toBe("failed");
    });
  });

  it("expires via quit sweep and via the read-time belt", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      agent.setLLMClient(scripted([{ tools: [toolUse({ label: "INBOX" })] }]));

      const held = await agent.commissionGoal({
        goal: GOAL,
        userId: "u",
        agentId: "onboarding",
      });
      const runId = (held as { runId: string }).runId;

      const ended = agent.endSession("quit");
      expect(ended).toEqual({ ended: true });
      // the quit sweep marked the run expired; read reports it
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "expired" });
      // absorbing: nothing overwrites a terminal
      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "expired" });
    });
  });

  it("binds {{data.<key>}} verbatim on hold, grant, audit, and dispatch", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      agent.connectService("mock_email", await seedCiphertext());
      // the model emits the PLACEHOLDER, never the value
      agent.setLLMClient(
        scripted([
          { tools: [toolUse({ label: "{{data.mailbox}}" })] },
          { text: "listed" },
        ]),
      );

      const held = await agent.commissionGoal({
        goal: "list the mailbox I named",
        data: { mailbox: "INBOX" },
        userId: "u",
        agentId: "onboarding",
      });
      expect(held.status).toBe("awaiting_confirmation");
      const runId = (held as { runId: string }).runId;

      // the pending decision entry already saw the substituted noun
      const [pendingRow] = [
        ...sql<{ noun: string; origin: string }>`
          SELECT noun, origin FROM audit_log
          WHERE decision = 'pending' ORDER BY sequence_num DESC LIMIT 1
        `,
      ];
      expect(pendingRow!.noun).toBe("INBOX");
      expect(pendingRow!.origin).toBe("mcp_commission");

      // resolving with a session grant mints the grant for the REAL noun and
      // dispatches the tool with the REAL value
      const resolution = await agent.resolveConfirmation({
        heldCallId: agent.heldCallId()!,
        choice: "session",
        userId: "u",
      });
      expect(resolution.status).toBe("resumed");

      const [grant] = [
        ...sql<{ noun: string }>`
          SELECT noun FROM policy_entries WHERE source = 'session' LIMIT 1
        `,
      ];
      expect(grant!.noun).toBe("INBOX");

      const [outcome] = [
        ...sql<{ noun: string; outcome: string; origin: string }>`
          SELECT noun, outcome, origin FROM audit_log
          WHERE decision = 'allow' AND tool_name = 'mock_email_list'
          ORDER BY sequence_num DESC LIMIT 1
        `,
      ];
      expect(outcome!.noun).toBe("INBOX");
      expect(outcome!.outcome).toBe("success");
      expect(outcome!.origin).toBe("mcp_commission");

      expect(agent.readCommissionRun(runId)).toMatchObject({ runId, status: "completed" });
    });
  });

  it("composeCommissionMessage fences data VALUES only — labels and goal stay plain", () => {
    const msg = composeCommissionMessage("list the mailbox I named", {
      mailbox: "INBOX",
    });
    const lines = msg.split("\n");
    // Frame, goal label, and goal are engine/inbound-notice territory — not
    // fenced (the goal is the turn's user message, guarded by the origin
    // notice).
    expect(lines[0]).toBe(
      "[Relayed from an external client via Habenula's commission surface — not typed by your user]",
    );
    expect(lines[1]).toBe("Goal (client-authored):");
    expect(lines[2]).toBe("list the mailbox I named");
    // The label line stays plain; the client-authored VALUE is wrapped in the
    // nonce fence, open and close carrying the same nonce.
    expect(lines[3]).toBe(
      "data.mailbox (client-supplied verbatim value; pass unchanged with {{data.mailbox}}):",
    );
    const valueBlock = lines.slice(4).join("\n");
    const m =
      /^<<habenula-untrusted-output ([0-9a-f-]{36})>>\n([\s\S]*)\n<<end-habenula-untrusted-output \1>>$/.exec(
        valueBlock,
      );
    expect(m).not.toBeNull();
    expect(m![2]).toBe("INBOX");
  });
});
