import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as pe from "../../src/data/helpers/policy-entries";
import type { EngineSql } from "../../src/data/helpers/types";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";

/**
 * Behavior tests for the policy_entries data helpers.
 * Run against a real DO's SQLite via runInDurableObject — no mocks. These pin
 * the evaluator-facing semantics the inline call sites carried: the ISO
 * strftime expiry comparison, priority-DESC ordering, the consumed_at filter,
 * session scoping, the once-only task-grant consume, and the deny-floor-
 * preserving kill delete.
 *
 * Every DO boots with the seeded 'default-deny' floor row (priority 0,
 * wildcard scope) — assertions account for it rather than assuming an empty
 * table.
 */
describe("policy_entries helpers", () => {
  const FLOOR_ID = WILDCARD_DENY_ID;

  const grant = (over: Partial<Parameters<typeof pe.insertSessionGrant>[1]> = {}) => ({
    id: crypto.randomUUID(),
    sessionId: "s-1",
    service: "gmail",
    verb: "read",
    noun: "inbox",
    decision: "allow" as const,
    createdAt: "2026-07-01T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...over,
  });

  it("boots with the deny floor; readPolicyEntryScope reads it back", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const floor = pe.readPolicyEntryScope(sql, FLOOR_ID);
      expect(floor).toEqual({
        decision: "deny",
        service: "*",
        verb: "*",
        noun: "*",
        priority: 0,
      });
      expect(pe.readPolicyEntryScope(sql, "absent")).toBeNull();
    });
  });

  it("expiry uses the ISO comparison: expired grants drop, unexpired survive", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const live = grant();
      pe.insertSessionGrant(sql, live);
      pe.insertSessionGrant(
        sql,
        grant({ expiresAt: "2020-01-01T00:00:00.000Z" }),
      );
      const active = pe.selectActivePolicyEntries(sql, "s-1");
      // Floor (no expiry) + the live grant; the expired one is filtered out.
      expect(active.map((r) => r.id).sort()).toEqual(
        [FLOOR_ID, live.id].sort(),
      );
    });
  });

  it("orders by priority DESC so grants outrank the floor (first match wins)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const g = grant();
      pe.insertSessionGrant(sql, g);
      const active = pe.selectActivePolicyEntries(sql, "s-1");
      expect(active[0]!.id).toBe(g.id);
      expect(active[active.length - 1]!.id).toBe(FLOOR_ID);
    });
  });

  it("scopes to the session: another session's grants are invisible", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const mine = grant({ sessionId: "s-1" });
      pe.insertSessionGrant(sql, mine);
      pe.insertSessionGrant(sql, grant({ sessionId: "s-2" }));
      const active = pe.selectActivePolicyEntries(sql, "s-1");
      expect(active.map((r) => r.id).sort()).toEqual(
        [FLOOR_ID, mine.id].sort(),
      );
    });
  });

  it("task-grant consume is once-only and excludes the row from evaluation", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const id = crypto.randomUUID();
      pe.insertTaskGrant(sql, {
        id,
        sessionId: "s-1",
        service: "gmail",
        verb: "send",
        noun: "message",
        decision: "allow",
        createdAt: "2026-07-01T10:00:00.000Z",
      });
      expect(
        pe.selectActivePolicyEntries(sql, "s-1").map((r) => r.id),
      ).toContain(id);
      pe.consumeTaskGrant(sql, id, "2026-07-01T10:05:00.000Z");
      expect(
        pe.selectActivePolicyEntries(sql, "s-1").map((r) => r.id),
      ).not.toContain(id);
      // A second consume must not move the recorded instant.
      pe.consumeTaskGrant(sql, id, "2026-07-01T11:00:00.000Z");
      const stamped = [
        ...sql<{ consumed_at: string }>`
          SELECT consumed_at FROM policy_entries WHERE id = ${id}
        `,
      ];
      expect(stamped[0]!.consumed_at).toBe("2026-07-01T10:05:00.000Z");
    });
  });

 it("task grants are session-scoped: session A's grant never surfaces under session B", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const id = crypto.randomUUID();
      pe.insertTaskGrant(sql, {
        id,
        sessionId: "session-A",
        service: "gmail",
        verb: "send",
        noun: "message",
        decision: "allow",
        createdAt: "2026-07-01T10:00:00.000Z",
      });
      // Visible to its own session, in both the status view and the evaluator…
      expect(pe.selectActiveGrants(sql, "session-A").map((r) => r.id)).toContain(id);
      expect(pe.selectActivePolicyEntries(sql, "session-A").map((r) => r.id)).toContain(id);
      // …and never to another session (the cross-session leak this closes).
      expect(pe.selectActiveGrants(sql, "session-B").map((r) => r.id)).not.toContain(id);
      expect(pe.selectActivePolicyEntries(sql, "session-B").map((r) => r.id)).not.toContain(id);
    });
  });

  it("standing entries order priority DESC then created_at ASC", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const standing = pe.selectStandingEntries(sql);
      // The seeded floor is the only standing entry on a fresh DO.
      expect(standing.map((r) => r.id)).toEqual([FLOOR_ID]);
      expect(standing[0]!.source).toBe("standing");
    });
  });

  it("kill delete clears everything except the deny floor", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      pe.insertSessionGrant(sql, grant());
      pe.insertTaskGrant(sql, {
        id: crypto.randomUUID(),
        sessionId: "s-1",
        service: "gmail",
        verb: "send",
        noun: "message",
        decision: "allow",
        createdAt: "2026-07-01T10:00:00.000Z",
      });
      pe.deletePolicyEntriesExcept(sql, FLOOR_ID);
      const remaining = pe.selectActivePolicyEntries(sql, "s-1");
      expect(remaining.map((r) => r.id)).toEqual([FLOOR_ID]);
    });
  });
});
