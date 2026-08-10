import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { AuditChainEntry } from "@habenula-ai/contracts";

/**
 * The pre-merge guard for the audit read route's verbatim claim
 * that `AuditChainEntry`'s keys map
 * one-to-one onto the LIVE `audit_log` table's columns minus
 * `parameters_content`. This is deliberately the only gate — the SQL
 * projection never selects the column, and `respond()` is log-and-pass
 * boundary telemetry, not a filter — so a column added to the table without a
 * decision about the wire fails HERE, not in production telemetry.
 *
 * Columns come from the running DO's PRAGMA, not from a source-file parse, so
 * the guard tracks the schema as migrations evolve it.
 */
describe("contract — AuditChainEntry ↔ audit_log columns", () => {
  function camelOf(column: string): string {
    return column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  }

  it("wire keys are exactly the table's columns minus parameters_content", async () => {
    const id = env.USER_AGENT.newUniqueId();
    const stub = env.USER_AGENT.get(id);
    const columns = await runInDurableObject(stub, (instance) => {
      return [
        ...instance.sql<{ name: string }>`
          SELECT name FROM pragma_table_info('audit_log') ORDER BY name
        `,
      ].map((row) => row.name);
    });

    expect(columns).toContain("parameters_content");

    const expectedWireKeys = columns
      .filter((c) => c !== "parameters_content")
      .map(camelOf)
      .sort();
    const wireKeys = Object.keys(AuditChainEntry.shape).sort();

    expect(wireKeys).toEqual(expectedWireKeys);
  });
});
