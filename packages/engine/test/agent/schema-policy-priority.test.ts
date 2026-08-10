import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Deny-floor defense-in-depth — a `CHECK(priority IS NOT NULL)`
 * on `policy_entries.priority`.
 *
 * The load-bearing guard is the pure evaluator: `evaluatePolicy` denies outright
 * when a matched entry carries a non-finite priority, so a corrupt priority
 * fails closed on every DO regardless of age and independent of input source —
 * see `packages/governance/test/evaluate-policy.test.ts`. This CHECK is a second,
 * independent STORAGE guard: the column is already `INTEGER NOT NULL DEFAULT 0`,
 * so a null cannot be written today, but if a future refactor drops the inline
 * `NOT NULL` the CHECK still refuses a null. It applies only to DOs created after
 * it ships (`CREATE TABLE IF NOT EXISTS` never touches existing DOs).
 *
 * This asserts our DDL carries the clause — the regression signal for the CHECK,
 * which fails the moment the clause is dropped. We do NOT separately assert that
 * a null write is rejected: the pre-existing `NOT NULL` already rejects it, so
 * such a test passes with or without the CHECK and proves nothing about this
 * change (it would have passed unchanged on `main`).
 */
describe("policy_entries.priority NOT NULL CHECK", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("carries the CHECK(priority IS NOT NULL) clause in the live table SQL", async () => {
    const stub = getStub();

    const createSql = await runInDurableObject(stub, (instance) => {
      const rows = instance.sql<{ sql: string }>`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'policy_entries'
      `;
      return [...rows][0]?.sql ?? "";
    });

    // Whitespace-tolerant: proves the defense-in-depth guard exists independent
    // of the inline NOT NULL, so removing NOT NULL alone can't reopen the hole.
    expect(createSql).toMatch(/CHECK\s*\(\s*priority\s+IS\s+NOT\s+NULL\s*\)/i);
  });
});
