import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as htc from "../../src/data/helpers/held-tool-calls";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the held_tool_calls data helpers.
 * They run against a real DO's SQLite via runInDurableObject —
 * no mocks — pinning the park/fill/read/resolve lifecycle, the per-session
 * reaper read, and the killSwitch snapshot + clear-all pair.
 */
describe("held_tool_calls helpers", () => {
  it("parks a call with empty turn_state, fills it in, reads it back", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      htc.insertHeldToolCall(sql, "h-1", "s-1", "audit-1", "2026-07-01T10:00:00.000Z");
      const parked = htc.readHeldCall(sql, "h-1");
      expect(parked).toEqual({
        id: "h-1",
        session_id: "s-1",
        pending_audit_entry_id: "audit-1",
        turn_state: "",
        held_at: "2026-07-01T10:00:00.000Z",
        run_id: null,
        // Additive columns: default hold kind, no awaited slots.
        hold_kind: "confirmation",
        awaited_slot_keys: null,
        // Additive column: only money-verb holds carry spend context.
        spend_context: null,
      });
      htc.updateHeldTurnState(sql, "h-1", '{"answered":true}');
      expect(htc.readHeldCall(sql, "h-1")!.turn_state).toBe('{"answered":true}');
      expect(htc.readHeldCall(sql, "absent")).toBeNull();
    });
  });

  it("selectHeldCalls scans all rows for the one-held-per-DO guard", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(htc.selectHeldCalls(sql)).toHaveLength(0);
      htc.insertHeldToolCall(sql, "h-1", "s-1", "audit-1", "2026-07-01T10:00:00.000Z");
      htc.insertHeldToolCall(sql, "h-2", "s-2", "audit-2", "2026-07-01T10:01:00.000Z");
      const rows = htc.selectHeldCalls(sql);
      expect(rows.map((r) => r.id).sort()).toEqual(["h-1", "h-2"]);
      expect(rows.every((r) => typeof r.turn_state === "string")).toBe(true);
    });
  });

  it("per-session read returns only that session's holds; delete resolves one", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      htc.insertHeldToolCall(sql, "h-1", "s-1", "audit-1", "2026-07-01T10:00:00.000Z");
      htc.insertHeldToolCall(sql, "h-2", "s-2", "audit-2", "2026-07-01T10:01:00.000Z");
      const forS1 = htc.selectHeldCallsForSession(sql, "s-1");
      // turn_state rides along so session-end sweeps can tell a parked call
      // ('' — the insert default) from one mid-resolve (dispatched/answered).
      expect(forS1).toEqual([
        { id: "h-1", pending_audit_entry_id: "audit-1", turn_state: "" },
      ]);
      htc.deleteHeldToolCall(sql, "h-1");
      expect(htc.readHeldCall(sql, "h-1")).toBeNull();
      expect(htc.readHeldCall(sql, "h-2")).not.toBeNull();
    });
  });

  it("kill pair: audit-ref snapshot (with turn_state) survives the clear-all that follows it", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      htc.insertHeldToolCall(sql, "h-1", "s-1", "audit-1", "2026-07-01T10:00:00.000Z");
      // h-2 is mid-resolve: turn_state must ride along in the snapshot so
      // killSwitch TX2 can skip it and not falsify a call the resolve path owns.
      // `dispatched: true` is the production marker resolveConfirmation commits
      // before awaiting the tool dispatch.
      htc.insertHeldToolCall(
        sql,
        "h-2",
        "s-2",
        "audit-2",
        "2026-07-01T10:01:00.000Z",
        null,
        '{"dispatched":true}',
      );
      const snapshot = htc.selectHeldCallAuditRefs(sql);
      htc.deleteAllHeldToolCalls(sql);
      expect(htc.selectHeldCalls(sql)).toHaveLength(0);
      // The pre-delete snapshot still carries the refs + turn_state TX2 needs.
      expect(
        snapshot
          .map((r) => ({ ref: r.pending_audit_entry_id, ts: r.turn_state }))
          .sort((a, b) => a.ref.localeCompare(b.ref)),
      ).toEqual([
        { ref: "audit-1", ts: "" },
        { ref: "audit-2", ts: '{"dispatched":true}' },
      ]);
    });
  });
});
