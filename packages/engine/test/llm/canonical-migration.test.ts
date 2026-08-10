import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  CANONICAL_SHAPE_VERSION,
  wrapTurnState,
  parseTurnState,
  migrateHeldTurn,
} from "../../src/llm/canonical";
import {
  readHeldCall,
  updateHeldTurnState,
  insertHeldToolCall,
} from "../../src/data/helpers/held-tool-calls";
import { insertSessionState } from "../../src/data/helpers/session-state";
import {
  insertCommissionRun,
  readCommissionRun,
  updateCommissionStatus,
} from "../../src/data/helpers/commission-runs";
import { bindDoSql } from "../helpers/do-sql";
import { asTurn } from "../helpers/turn";
import type { HeldTurnState } from "../../src/llm/conversation";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

/**
 * The versioned turn_state envelope: every persist writes
 * `{ v: CANONICAL_SHAPE_VERSION, state }`; resume reads a bare legacy blob as
 * v0 (identity migration — in-flight holds parked across the introducing
 * deploy resume without loss); a version stamped by newer code fails safe.
 */

function turnState(overrides: Partial<HeldTurnState> = {}): HeldTurnState {
  return {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "mock_email_list", input: { label: "INBOX" } },
        ],
      },
    ],
    heldCall: { type: "tool_use", id: "tu_1", name: "mock_email_list", input: { label: "INBOX" } },
    parkedCalls: [],
    producedResults: [],
    iterationsUsed: 1,
    toolCalls: [{ name: "mock_email_list", id: "tu_1", outcome: "held" }],
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

describe("turn_state envelope (unit)", () => {
  it("wrap → parse round-trips at the current version", () => {
    const state = turnState();
    const raw = wrapTurnState(state);
    expect(JSON.parse(raw)).toEqual({ v: CANONICAL_SHAPE_VERSION, state });
    expect(parseTurnState(raw)).toEqual({ ok: true, state });
  });

  it("a bare legacy blob (no v) parses as v0 via the identity migration", () => {
    const state = turnState();
    expect(parseTurnState(JSON.stringify(state))).toEqual({ ok: true, state });
  });

  it("a future version fails safe as future_version, never a mis-parse", () => {
    const raw = JSON.stringify({ v: CANONICAL_SHAPE_VERSION + 1, state: turnState() });
    expect(parseTurnState(raw)).toEqual({ ok: false, reason: "future_version" });
  });

  it.each([
    ["empty string", ""],
    ["not JSON", "{nope"],
    ["a JSON scalar", "42"],
    ["an envelope with non-numeric v", '{"v":"one","state":{}}'],
    ["an envelope with no state object", '{"v":1}'],
    // Corrupt stamps must be unparseable, NEVER a throw: every read site
    // dropped its try/catch on parseTurnState's no-throw contract, and a
    // poison row reaching migrateHeldTurn's assertion would wedge the chat
    // guard and abort the reap transaction.
    ["an envelope with a fractional v", '{"v":0.5,"state":{}}'],
    ["an envelope with a negative v", '{"v":-1,"state":{}}'],
  ])("%s is unparseable", (_label, raw) => {
    expect(parseTurnState(raw)).toEqual({ ok: false, reason: "unparseable" });
  });

  it("migrateHeldTurn is identity for v0 and the current version, loud for a missed arm", () => {
    const state = turnState();
    expect(migrateHeldTurn(0, state)).toBe(state);
    expect(migrateHeldTurn(CANONICAL_SHAPE_VERSION, state)).toBe(state);
    expect(() => migrateHeldTurn(-1, state)).toThrow(/No migration path/);
  });
});

// --- DO-level (real SQLite, Hard Invariant #5) ---

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

/** LLM scripted to hold once (tool_use) then finish with text on resume. */
function holdThenDoneLLM(): LLMClient {
  let call = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      call++;
      if (call === 1) {
        return {
          id: "msg_1",
          content: [
            { type: "tool_use", id: "tu_1", name: "mock_email_list", input: { label: "INBOX" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${call}`,
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

describe("turn_state envelope (DO)", () => {
  it("a parked hold persists the versioned envelope", async () => {
    const stub = getStub();
    const held = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(holdThenDoneLLM());
      instance.connectService("mock_email");
      const turn = await instance
        .chat({ message: "list inbox", userId: "envelope-write-user" })
        .then(asTurn);
      return readHeldCall(bindDoSql(instance), turn.held!.heldCallId);
    });
    const persisted = JSON.parse(held!.turn_state) as { v: number; state: HeldTurnState };
    expect(persisted.v).toBe(CANONICAL_SHAPE_VERSION);
    expect(persisted.state.heldCall.name).toBe("mock_email_list");
  });

  it("a legacy unversioned row (parked before the envelope) still resolves", async () => {
    const stub = getStub();
    const heldCallId = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(holdThenDoneLLM());
      instance.connectService("mock_email");
      const turn = await instance
        .chat({ message: "list inbox", userId: "legacy-resume-user" })
        .then(asTurn);
      const id = turn.held!.heldCallId;
      // Rewrite the row to the pre-envelope format: the bare HeldTurnState the
      // pre-0291A engine persisted.
      const sql = bindDoSql(instance);
      const row = readHeldCall(sql, id)!;
      const envelope = JSON.parse(row.turn_state) as { v: number; state: HeldTurnState };
      updateHeldTurnState(sql, id, JSON.stringify(envelope.state));
      return id;
    });

    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId,
        choice: "deny",
        userId: "legacy-resume-user",
      }),
    );
    expect(resolved.status).toBe("resumed");
  });

  it("a future-version row is unresumable: denied + audited, row deleted", async () => {
    const stub = getStub();
    const heldCallId = "held-future";
    const pendingEntryId = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-future", new Date().toISOString(), "default");
      // A pending decision entry the fail-safe must close. Seeded directly —
      // the envelope version, not the governance path, is under test.
      const pending = instance.writeAuditEntry({
        userId: "future-user",
        agentId: "default",
        sessionId: "sess-future",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "read",
        noun: "INBOX",
        decision: "pending",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      insertHeldToolCall(
        sql,
        heldCallId,
        "sess-future",
        pending.id,
        new Date().toISOString(),
        null,
        JSON.stringify({ v: CANONICAL_SHAPE_VERSION + 1, state: turnState() }),
      );
      return pending.id;
    });

    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId,
        choice: "session",
        userId: "future-user",
      }),
    );
    expect(resolved.status).toBe("not_found");

    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      // Row swept — the unresumable hold cannot wedge the session.
      expect(readHeldCall(sql, heldCallId)).toBeNull();
      // Terminal deny audited against the pending decision entry; nothing ran.
      const entries = [
        ...instance.sql<{ decision: string; outcome: string | null; error_message: string | null }>`
          SELECT decision, outcome, error_message FROM audit_log
          WHERE decision_entry_id = ${pendingEntryId}
        `,
      ];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.decision).toBe("deny");
      expect(entries[0]!.outcome).toBe("error");
      expect(entries[0]!.error_message).toMatch(/unresumable/);
      // No grant was minted.
      const grants = [
        ...instance.sql<{ id: string }>`
          SELECT id FROM policy_entries WHERE source IN ('session','task')
        `,
      ];
      expect(grants).toHaveLength(0);
    });
  });

  it("a commission-parked future-version row audits mcp_commission and resolves its run as denied", async () => {
    const stub = getStub();
    const heldCallId = "held-future-commission";
    const runId = "run-future-1";
    const pendingEntryId = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-future-c", new Date().toISOString(), "default");
      insertCommissionRun(sql, {
        id: runId,
        goal: "list mail",
        data: null,
        sessionId: "sess-future-c",
        createdAt: new Date().toISOString(),
      });
      updateCommissionStatus(sql, runId, "awaiting_confirmation", new Date().toISOString());
      const pending = instance.writeAuditEntry({
        userId: "future-c-user",
        agentId: "default",
        sessionId: "sess-future-c",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "read",
        noun: "INBOX",
        decision: "pending",
        origin: "mcp_commission",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      insertHeldToolCall(
        sql,
        heldCallId,
        "sess-future-c",
        pending.id,
        new Date().toISOString(),
        runId,
        JSON.stringify({ v: CANONICAL_SHAPE_VERSION + 1, state: turnState() }),
      );
      return pending.id;
    });

    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId,
        choice: "session",
        userId: "future-c-user",
      }),
    );
    expect(resolved.status).toBe("not_found");

    await runInDurableObject(stub, (instance) => {
      const entries = [
        ...instance.sql<{ decision: string; origin: string }>`
          SELECT decision, origin FROM audit_log
          WHERE decision_entry_id = ${pendingEntryId}
        `,
      ];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.decision).toBe("deny");
      expect(entries[0]!.origin).toBe("mcp_commission");
      // The linked run must not be left awaiting_confirmation against a hold
      // that no longer exists — the fail-safe resolves it terminally.
      const run = readCommissionRun(bindDoSql(instance), runId);
      expect(run?.status).toBe("denied");
    });
  });

  it("tell_more keeps its no-mutation contract on a future-version hold", async () => {
    const stub = getStub();
    const heldCallId = "held-future-tellmore";
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-future-t", new Date().toISOString(), "default");
      const pending = instance.writeAuditEntry({
        userId: "future-t-user",
        agentId: "default",
        sessionId: "sess-future-t",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "read",
        noun: "INBOX",
        decision: "pending",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      insertHeldToolCall(
        sql,
        heldCallId,
        "sess-future-t",
        pending.id,
        new Date().toISOString(),
        null,
        JSON.stringify({ v: CANONICAL_SHAPE_VERSION + 1, state: turnState() }),
      );
    });

    const probed = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId,
        choice: "tell_more",
        userId: "future-t-user",
      }),
    );
    expect(probed.status).toBe("not_found");

    // The read-only probe destroyed nothing: the row survives and a real
    // decision choice can still hit the deny fail-safe afterwards.
    await runInDurableObject(stub, (instance) => {
      expect(readHeldCall(bindDoSql(instance), heldCallId)).not.toBeNull();
    });
  });
});
