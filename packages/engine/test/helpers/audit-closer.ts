import type { EngineSql } from "../../src/data/helpers/types";
import {
  closeDecisionEntryInTxn,
  type AuditEntryResult,
  type ReferencingAuditEntryParams,
} from "../../src/data/helpers/audit-log";
import { bindDoSql } from "./do-sql";

/**
 * The DO surface a test needs to seed a referencing audit row: the bound sql
 * tag plus the storage transaction. `runInDurableObject` types the instance
 * as the class's public surface, which exposes neither — this is the one cast,
 * held here so no test repeats it (the same shape `do-sql.ts` uses for `sql`).
 */
type DoWithStorage = {
  sql: EngineSql;
  ctx: { storage: { transactionSync<T>(closure: () => T): T } };
};

/**
 * Seed a closer (a referencing audit row) unconditionally, so a test can plant
 * a conflict on purpose. `observed` is what makes that possible: it is the
 * branch that never skips, so a seeded row lands even when the decision
 * already carries one. Production reaches the same write with its own basis.
 */
export function seedCloser(
  instance: unknown,
  params: ReferencingAuditEntryParams,
): AuditEntryResult {
  const dobj = instance as DoWithStorage;
  const sql = bindDoSql(dobj);
  return dobj.ctx.storage.transactionSync(() =>
    closeDecisionEntryInTxn(sql, params, "observed"),
  );
}

/** Open the DO's transaction for a test driving a txn-context-only method. */
export function inTxn<T>(instance: unknown, closure: () => T): T {
  return (instance as DoWithStorage).ctx.storage.transactionSync(closure);
}
