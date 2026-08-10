import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as sl from "../../src/data/helpers/spend-ledger";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the spend_ledger data helpers.
 * Real DO SQLite via runInDurableObject, no mocks. The properties pinned here
 * are the ledger halves of the acceptance matrix: idempotent writes on the
 * (idempotency_key, quote_id) pair — replay drops, a reused key under a NEW
 * quote counts — and both windows summing one table.
 */
describe("spend_ledger helpers", () => {
  const row = (over: Partial<sl.SpendLedgerInsert> = {}): sl.SpendLedgerInsert => ({
    id: crypto.randomUUID(),
    sessionId: "s-1",
    createdAt: "2026-07-10T10:00:00.000Z",
    service: "mock_delivery",
    verb: "order",
    amountCents: 1500,
    quoteId: "q-1",
    idempotencyKey: "k-1",
    auditEntryId: "audit-1",
    ...over,
  });

  it("insert is idempotent on (key, quote): replay writes one row, sums unchanged", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      sl.insertSpendInTxn(sql, row());
      // A retried commit re-inserts with the same key and quote but a fresh id.
      sl.insertSpendInTxn(sql, row({ id: crypto.randomUUID() }));
      expect(sl.sumSessionSpendCents(sql, "s-1")).toBe(1500);
    });
  });

  it("a reused idempotency key under a DIFFERENT quote is a new spend and is counted", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      sl.insertSpendInTxn(sql, row());
      // Not a replay: an uncounted spend here would be a cap bypass
      // (the pair, not the key alone, is unique).
      sl.insertSpendInTxn(sql, row({ id: crypto.randomUUID(), quoteId: "q-2" }));
      expect(sl.sumSessionSpendCents(sql, "s-1")).toBe(3000);
    });
  });

  it("both windows read one ledger, consistently across a session boundary", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      sl.insertSpendInTxn(
        sql,
        row({ sessionId: "s-1", quoteId: "q-1", idempotencyKey: "k-1" }),
      );
      sl.insertSpendInTxn(
        sql,
        row({
          id: crypto.randomUUID(),
          sessionId: "s-2",
          quoteId: "q-2",
          idempotencyKey: "k-2",
          amountCents: 700,
          createdAt: "2026-07-11T10:00:00.000Z",
        }),
      );
      // Session windows see only their own rows; the month window sees both.
      expect(sl.sumSessionSpendCents(sql, "s-1")).toBe(1500);
      expect(sl.sumSessionSpendCents(sql, "s-2")).toBe(700);
      expect(sl.sumMonthSpendCents(sql, "2026-07-01T00:00:00.000Z")).toBe(2200);
    });
  });

  it("the month window starts at its boundary — earlier rows are excluded", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      sl.insertSpendInTxn(
        sql,
        row({ createdAt: "2026-06-30T23:59:59.000Z", quoteId: "q-june" }),
      );
      sl.insertSpendInTxn(
        sql,
        row({
          id: crypto.randomUUID(),
          createdAt: "2026-07-01T00:00:00.000Z",
          quoteId: "q-july",
          idempotencyKey: "k-2",
          amountCents: 800,
        }),
      );
      expect(sl.sumMonthSpendCents(sql, "2026-07-01T00:00:00.000Z")).toBe(800);
    });
  });

  it("empty windows sum to zero, not null", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(sl.sumSessionSpendCents(sql, "no-such-session")).toBe(0);
      expect(sl.sumMonthSpendCents(sql, "2026-07-01T00:00:00.000Z")).toBe(0);
    });
  });

  it("only the idempotency conflict is ignored — any other constraint violation throws", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      sl.insertSpendInTxn(sql, row({ id: "fixed-id" }));
      // Same id, different (key, quote): a genuinely new spend. INSERT OR
      // IGNORE would silently drop it (an uncounted spend is a cap bypass);
      // the scoped ON CONFLICT must throw instead.
      expect(() =>
        sl.insertSpendInTxn(
          sql,
          row({ id: "fixed-id", quoteId: "q-2", idempotencyKey: "k-2" }),
        ),
      ).toThrow();
      expect(sl.sumSessionSpendCents(sql, "s-1")).toBe(1500);
    });
  });

  it("rejects non-integer, negative, and unsafe amounts loudly — never a corrupting row", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (const bad of [-1, 12.5, NaN, Infinity, 2 ** 53]) {
        expect(() => sl.insertSpendInTxn(sql, row({ amountCents: bad }))).toThrow();
      }
      expect(sl.sumSessionSpendCents(sql, "s-1")).toBe(0);
    });
  });

  it("rejects a createdAt outside toISOString() form — the month window compares lexicographically", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (const bad of [
        "2026-07-10T10:00:00Z", // no millis
        "2026-07-10T10:00:00.000+02:00", // zone offset
        "1752141600000", // epoch millis
        "2026-07-10", // date only
      ]) {
        expect(() => sl.insertSpendInTxn(sql, row({ createdAt: bad }))).toThrow();
      }
      expect(sl.sumMonthSpendCents(sql, "2000-01-01T00:00:00.000Z")).toBe(0);
    });
  });

  it("sum helpers throw when the ledger is unreadable (the caller maps this to `unavailable`)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      // Force the failstate with real storage: drop the table.
      sql`DROP TABLE spend_ledger`;
      expect(() => sl.sumSessionSpendCents(sql, "s-1")).toThrow();
      expect(() => sl.sumMonthSpendCents(sql, "2026-07-01T00:00:00.000Z")).toThrow();
    });
  });
});
