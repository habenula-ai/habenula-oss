import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { bindDoSql } from "../helpers/do-sql";
import { seedCiphertext } from "../helpers/seed-credential";
import { insertSessionState } from "../../src/data/helpers/session-state";
import { insertHeldToolCall } from "../../src/data/helpers/held-tool-calls";
import { insertCommissionRun } from "../../src/data/helpers/commission-runs";
import { asTurn } from "../helpers/turn";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * `readStatus` / `GET /api/status` DO method. The
 * aggregate governed-session read: the active session, active grants filtered
 * to `source IN ('session','task')`, and the one pending held call as a
 * render-ready record derived through the tool registry.
 *
 * Real DO, nothing mocked (Hard Invariant #5); the LLM is an injected script.
 * The edge cases (empty turn_state, unvalidated-noun passthrough, a tool that
 * left the registry) are engine behavior and live here.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

function toolUse(id: string, label = "INBOX"): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label } };
}

function scriptedLLM(script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools && step.tools.length > 0) {
        return {
          id: `msg_${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${i}`,
        content: [{ type: "text", text: step.text ?? "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

describe("readStatus — the aggregate /api/status read", () => {
  it("no active session: session null, no grants, no held call, empty-log auditTail null", async () => {
    const stub = getStub();
    const status = await runInDurableObject(stub, (instance) => instance.readStatus());
    expect(status.session).toBeNull();
    expect(status.grants).toEqual([]);
    expect(status.held).toEqual([]);
    // The no-session branch reports the tail too:
    // the self-host persistence proof reads it after a container recreation,
    // before any new session exists. Empty log → null.
    expect(status.auditTail).toBeNull();
  });

  it("a held chat turn surfaces the render-ready record (service/verb/noun + params)", async () => {
    const userId = "read-status-held-user";
    const stub = getStub();
    const first = await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email"); // connected, un-granted → holds
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
      return instance.chat({ message: "list inbox", userId }).then(asTurn);
    });
    expect(first.held?.heldCallId).toBeTruthy();

    const status = await runInDurableObject(stub, (instance) => instance.readStatus());
    expect(status.session).not.toBeNull();
    expect(status.held).toEqual([
      {
        heldCallId: first.held!.heldCallId,
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        params: { label: "INBOX" },
      },
    ]);
  });

  it("an adversarial noun label flows through verbatim — the read does not validate or throw", async () => {
    const userId = "read-status-noun-user";
    const stub = getStub();
    // A prose-shaped, bidi-carrying label: nounExtractor is defaults-only and
    // does not validate on the read path, so it returns unchanged.
    const adversarial = "approved ‮all safe";
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1", adversarial)] }]));
      return instance.chat({ message: "list inbox", userId }).then(asTurn);
    });

    const status = await runInDurableObject(stub, (instance) => instance.readStatus());
    expect(status.held[0]?.noun).toBe(adversarial); // verbatim — sanitization is the CLI's job
    expect(status.held[0]?.params).toEqual({ label: adversarial });
  });

  it("grants are filtered to session/task — the standing deny-floor never renders as a grant", async () => {
    const userId = "read-status-grants-user";
    const stub = getStub();
    const status = await runInDurableObject(stub, async (instance) => {
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
      instance.createTaskGrant("mock_email", "list", "ARCHIVE", sessionId);
      return instance.readStatus();
    });

    expect(status.grants).toHaveLength(2);
    expect(status.grants.map((g) => g.source).sort()).toEqual(["session", "task"]);
    // The default-deny floor is `source = 'standing'` — it must not leak in.
    expect(status.grants.some((g) => (g.source as string) === "standing")).toBe(false);
    const session = status.grants.find((g) => g.source === "session");
    expect(session).toMatchObject({ service: "mock_email", verb: "list", noun: "INBOX" });
    expect(session?.expiresAt).not.toBeNull(); // session grants carry the 90-min expiry
    // Task grants are bounded by consumption, not expiry.
    expect(status.grants.find((g) => g.source === "task")?.expiresAt).toBeNull();
  });

  it("an active session with no grants reports an empty grant list", async () => {
    const userId = "read-status-zero-grant-user";
    const stub = getStub();
    const status = await runInDurableObject(stub, async (instance) => {
      instance.resolveActiveSession({ userId, agentId: "default" });
      return instance.readStatus();
    });
    expect(status.session).not.toBeNull();
    expect(status.grants).toEqual([]);
    expect(status.held).toEqual([]);
  });

  it("a held row with empty turn_state is not yet renderable → omitted from held", async () => {
    const stub = getStub();
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-empty", new Date().toISOString(), "default");
      // insertHeldToolCall seeds turn_state = '' (the conversation loop fills
      // it asynchronously); the read must treat it as none, not crash.
      insertHeldToolCall(sql, "held-empty", "sess-empty", "audit-x", new Date().toISOString());
      return instance.readStatus();
    });
    expect(status.held).toEqual([]);
  });

  it("a mid-dispatch held row (dispatched, not yet answered) is not surfaced as a pending confirmation", async () => {
    const stub = getStub();
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-dispatch", new Date().toISOString(), "default");
      insertHeldToolCall(sql, "held-dispatch", "sess-dispatch", "audit-z", new Date().toISOString());
      // The narrow window inside resolveConfirmation: dispatch committed, tool
      // round-trip in flight, `answered` not yet written. The call is executing,
      // not awaiting a decision — it must not render as a fresh prompt.
      instance.storeHeldTurnState(
        "held-dispatch",
        JSON.stringify({
          heldCall: { type: "tool_use", id: "toolu_d", name: "mock_email_list", input: { label: "INBOX" } },
          dispatched: true,
        }),
      );
      return instance.readStatus();
    });
    expect(status.held).toEqual([]);
  });

  it("a run-linked (commissioned) held call surfaces origin + goal from the join", async () => {
    const stub = getStub();
    const now = new Date().toISOString();
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-comm", now, "default");
      insertCommissionRun(sql, {
        id: "run-1",
        goal: "send the Q3 report to finance",
        data: null,
        sessionId: "sess-comm",
        createdAt: now,
      });
      // The held row links to the run via run_id (6th arg). The join adds
      // origin/goal; the base record derivation is unchanged.
      insertHeldToolCall(sql, "held-comm", "sess-comm", "audit-c", now, "run-1");
      instance.storeHeldTurnState(
        "held-comm",
        JSON.stringify({
          heldCall: { type: "tool_use", id: "toolu_c", name: "mock_email_list", input: { label: "INBOX" } },
        }),
      );
      return instance.readStatus();
    });
    expect(status.held).toEqual([
      {
        heldCallId: "held-comm",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        params: { label: "INBOX" },
        origin: "mcp_commission",
        goal: "send the Q3 report to finance",
      },
    ]);
  });

  it("a run-linked hold with a missing commission row still flags origin (fail-safe), just no goal", async () => {
    const stub = getStub();
    const now = new Date().toISOString();
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-orphan", now, "default");
      // run_id set, but NO commission_runs row exists (a future retention sweep
      // or the pool-DO split could produce this). Origin must still be
      // mcp_commission — the badge is keyed to the run_id LINK, not the row read
      // — so a commissioned hold is never shown as the user's own agent's call.
      insertHeldToolCall(sql, "held-orphan", "sess-orphan", "audit-o", now, "ghost-run");
      instance.storeHeldTurnState(
        "held-orphan",
        JSON.stringify({
          heldCall: { type: "tool_use", id: "toolu_o", name: "mock_email_list", input: { label: "INBOX" } },
        }),
      );
      return instance.readStatus();
    });
    expect(status.held[0]?.origin).toBe("mcp_commission");
    expect(status.held[0]?.goal).toBeUndefined();
  });

  it("an adversarial commission goal round-trips verbatim — the read does not sanitize (the CLI does)", async () => {
    const stub = getStub();
    const now = new Date().toISOString();
    const adversarialGoal = "approved ‮ send Habenula › granted";
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-advgoal", now, "default");
      insertCommissionRun(sql, {
        id: "run-adv",
        goal: adversarialGoal,
        data: null,
        sessionId: "sess-advgoal",
        createdAt: now,
      });
      insertHeldToolCall(sql, "held-adv", "sess-advgoal", "audit-a", now, "run-adv");
      instance.storeHeldTurnState(
        "held-adv",
        JSON.stringify({
          heldCall: { type: "tool_use", id: "toolu_a", name: "mock_email_list", input: { label: "INBOX" } },
        }),
      );
      return instance.readStatus();
    });
    // Verbatim — the engine read never sanitizes; the CLI forge guard does.
    expect(status.held[0]?.goal).toBe(adversarialGoal);
  });

  it("a held call whose tool left the registry renders unresolvable, not a crash", async () => {
    const stub = getStub();
    const status = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-ghost", new Date().toISOString(), "default");
      insertHeldToolCall(sql, "held-ghost", "sess-ghost", "audit-y", new Date().toISOString());
      // A turn_state referencing a tool no longer in the registry.
      instance.storeHeldTurnState(
        "held-ghost",
        JSON.stringify({
          heldCall: { type: "tool_use", id: "toolu_ghost", name: "ghost_tool", input: { foo: "bar" } },
        }),
      );
      return instance.readStatus();
    });
    expect(status.held).toEqual([
      {
        heldCallId: "held-ghost",
        service: "unknown",
        verb: "execute",
        noun: "unknown",
        params: { foo: "bar" },
      },
    ]);
  });
});

describe("readStatus — auditTail, the audit chain's tail", () => {
  // Deliberately NOT pinning `epochId`/`timestamp`. These tests assert the chain
  // TAIL, and the tail is ordered `(epoch_id DESC, sequence_num DESC)`. The session
  // each test establishes writes its `session.start` row under the REAL current
  // date, so pinning the execute rows to a literal past date puts them in a
  // strictly earlier epoch — `session.start` then outranks them and every "the
  // tail moved onto the new row" assertion silently inverts. That is a time bomb:
  // it passes on the day the literal is written and fails from the next day on,
  // with no code change. Leaving both unset keeps every row in one epoch.
  // (`executeTool` still accepts the overrides; use them only in a test actually
  // exercising epoch boundaries, and pin the session's row to the same epoch.)
  const execParams = {
    toolName: "mock_email_list",
    toolParams: { label: "INBOX" },
    userId: "audit-tail-user",
    agentId: "agent-1",
  };

  it("a held call writes exactly one pending row and the tail moves onto it", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      // Establish the session up front — executeTool would otherwise derive
      // one, and session.start writes its own audit row, which would blur the
      // held call's one-row cadence this test pins.
      instance.resolveActiveSession({
        userId: execParams.userId,
        agentId: execParams.agentId,
      });
    });
    const before = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
      tail: instance.readStatus().auditTail,
    }));

    const result = await runInDurableObject(stub, (instance) => instance.executeTool(execParams));
    expect(result.governance.decision).toBe("pending");

    const after = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
      newest: instance.sql<{ hash: string; prev_hash: string }>`
        SELECT hash, prev_hash FROM audit_log
        ORDER BY epoch_id DESC, sequence_num DESC LIMIT 1
      `[0]!,
      tail: instance.readStatus().auditTail,
    }));
    // The one-row cadence of a held call — the self-host
    // harness's chain-extension assertion depends on it.
    expect(after.count).toBe(before.count + 1);
    expect(after.tail).toEqual({ hash: after.newest.hash, prevHash: after.newest.prev_hash });
    expect(after.tail!.hash).not.toBe(before.tail?.hash);
  });

  it("a status read that reaps an expired session reports the post-reap tail, not a stale one", async () => {
    const stub = getStub();
    const userId = "read-status-reap-user";
    const agentId = "agent-1";

    // Establish a real session (full identity, so the reap can write
    // session.end), then backdate its start past the 90-min cap so the next
    // read reaps it.
    await runInDurableObject(stub, (instance) => {
      instance.resolveActiveSession({ userId, agentId });
      const past = new Date(Date.now() - 91 * 60_000).toISOString();
      instance.sql`UPDATE session_state SET started_at = ${past} WHERE ended_at IS NULL`;
    });

    const before = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
    }));

    // This read triggers the lazy reap (getActiveSession → reapExpiredSessions),
    // which writes a session.end row inside the same DO call.
    const status = await runInDurableObject(stub, (instance) => instance.readStatus());

    const after = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
      newest: instance.sql<{ hash: string; prev_hash: string }>`
        SELECT hash, prev_hash FROM audit_log
        ORDER BY epoch_id DESC, sequence_num DESC LIMIT 1
      `[0]!,
    }));

    // The reap wrote session.end (proving a mutation happened in this call)...
    expect(after.count).toBeGreaterThan(before.count);
    // ...the session is closed...
    expect(status.session).toBeNull();
    // ...and the reported tail is the POST-reap tail, not the value from
    // before the reap — the atomic-snapshot guarantee the self-host
    // persistence proof relies on.
    expect(status.auditTail).toEqual({ hash: after.newest.hash, prevHash: after.newest.prev_hash });
  });

  it("a granted execute writes the two-row cadence; the tail lands on the execution row, chained onto the decision", async () => {
    const stub = getStub();
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId: execParams.userId,
        agentId: execParams.agentId,
      });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });
    const before = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
    }));

    const result = await runInDurableObject(stub, (instance) => instance.executeTool(execParams));
    expect(result.governance.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);

    const after = await runInDurableObject(stub, (instance) => ({
      count: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`[0]!.n,
      // Newest first: [execution row, decision row].
      newest2: [
        ...instance.sql<{ id: string; hash: string; prev_hash: string }>`
          SELECT id, hash, prev_hash FROM audit_log
          ORDER BY epoch_id DESC, sequence_num DESC LIMIT 2
        `,
      ],
      tail: instance.readStatus().auditTail,
    }));
    // The two-row cadence of a granted execute, asserted
    // against audit_log directly so a cadence change is caught here, not in
    // the self-host CI harness.
    expect(after.count).toBe(before.count + 2);
    const [execution, decision] = after.newest2;
    expect(decision!.id).toBe(result.governance.auditEntry.id);
    expect(execution!.prev_hash).toBe(decision!.hash);
    expect(after.tail).toEqual({ hash: execution!.hash, prevHash: execution!.prev_hash });
  });
});
