import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AuditLogRow } from "../../src/data/schemas/audit-log";
import { ConnectedServicesRow } from "../../src/data/schemas/connected-services";
import { HeldToolCallsRow } from "../../src/data/schemas/held-tool-calls";
import { OAuthStateRow } from "../../src/data/schemas/oauth-state";
import { PolicyEntriesRow } from "../../src/data/schemas/policy-entries";
import { SessionStateRow } from "../../src/data/schemas/session-state";
import { SpendLedgerRow } from "../../src/data/schemas/spend-ledger";
import { UserSettingsRow } from "../../src/data/schemas/user-settings";
import { extractCheckEnums } from "../../src/data/codegen/extract-check-enums";

/**
 * Drift guard over every registered table: the committed
 * generated schemas must match the real DO's live SQLite.
 *
 * Two independent halves per table:
 *  1. pragma_table_info → column name/type/nullability match the Zod row schema.
 *  2. CHECK enums extracted from the live `sqlite_master.sql` match a
 *     hand-maintained literal (NOT derived from extractCheckEnums, so a bug in
 *     the extractor can't hide by agreeing with itself).
 */

// Generated Zod row schema per table.
const SCHEMAS = {
  audit_log: AuditLogRow,
  connected_services: ConnectedServicesRow,
  held_tool_calls: HeldToolCallsRow,
  oauth_state: OAuthStateRow,
  policy_entries: PolicyEntriesRow,
  session_state: SessionStateRow,
  spend_ledger: SpendLedgerRow,
  user_settings: UserSettingsRow,
} as const;

// Hand-maintained expected CHECK-enum sets — typed literally here, never
// derived from the shared extractor, so an extractor bug (e.g. dropping
// 'pending') can't hide by agreeing with itself.
const EXPECTED_ENUMS: Record<string, Record<string, string[]>> = {
  audit_log: {
    decision: ["allow", "deny", "pending"],
    outcome: ["success", "error", "timeout"],
    origin: ["human", "mcp_commission"],
  },
  commission_runs: {
    origin: ["mcp_commission", "human"],
    status: [
      "running",
      "awaiting_confirmation",
      "completed",
      "failed",
      "denied",
      "expired",
      "needs_input",
      "cancelled",
    ],
  },
  connected_services: {},
  held_tool_calls: {
    hold_kind: ["confirmation", "input"],
  },
  oauth_state: {
    status: ["denied"],
  },
  policy_entries: {
    source: ["session", "task", "standing"],
    decision: ["allow", "deny"],
  },
  session_state: {},
  spend_ledger: {},
  user_settings: {},
};

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/**
 * A Zod field accepts a value of the mapped SQL type and rejects the other.
 * CHECK-enum TEXT columns are probed with one of the enum's own options — an
 * arbitrary string would be rejected for the wrong reason (not in the enum,
 * rather than not a string).
 */
function acceptsSqlType(field: z.ZodTypeAny, sqlType: string): boolean {
  const inner = field instanceof z.ZodNullable ? field.unwrap() : field;
  const textProbe =
    inner instanceof z.ZodEnum ? (inner.options[0] as string) : "x";
  if (sqlType === "TEXT") {
    return field.safeParse(textProbe).success && !field.safeParse(1).success;
  }
  // INTEGER / REAL
  return field.safeParse(1).success && !field.safeParse(textProbe).success;
}

describe("schema ↔ DO parity", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  for (const [table, rowSchema] of Object.entries(SCHEMAS)) {
    it(`${table}: columns/types/nullability match pragma_table_info`, async () => {
      const stub = getStub();
      const cols = await runInDurableObject(stub, (instance) =>
        instance.sql<PragmaColumn>`
          SELECT name, type, "notnull", pk FROM pragma_table_info(${table})
        `,
      );

      const shape = rowSchema.shape as Record<string, z.ZodTypeAny>;
      // Same column set.
      expect(new Set(cols.map((c) => c.name))).toEqual(
        new Set(Object.keys(shape)),
      );

      for (const col of cols) {
        const field = shape[col.name];
        expect(field, `missing schema field for ${table}.${col.name}`).toBeDefined();
        // Nullability: a non-PK column without NOT NULL is nullable.
        const dbNullable = col.notnull === 0 && col.pk === 0;
        expect(
          field!.safeParse(null).success,
          `${table}.${col.name} nullability`,
        ).toBe(dbNullable);
        expect(
          acceptsSqlType(field!, col.type),
          `${table}.${col.name} type ${col.type}`,
        ).toBe(true);
      }
    });

    it(`${table}: CHECK enums match the live table SQL`, async () => {
      const stub = getStub();
      const createSql = await runInDurableObject(stub, (instance) => {
        const rows = instance.sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
        `;
        return [...rows][0]?.sql ?? "";
      });
      expect(extractCheckEnums(createSql)).toEqual(EXPECTED_ENUMS[table]);

      // The generated schema's enum options must match the same literals —
      // without this, a drifted schema enum (e.g. a dropped 'pending') would
      // slip past the pragma half, whose type probe accepts any valid option.
      const shape = (SCHEMAS[table as keyof typeof SCHEMAS])
        .shape as Record<string, z.ZodTypeAny>;
      for (const [col, values] of Object.entries(EXPECTED_ENUMS[table]!)) {
        const field = shape[col]!;
        const inner = field instanceof z.ZodNullable ? field.unwrap() : field;
        expect(
          (inner as z.ZodEnum<Record<string, string>>).options,
          `${table}.${col} schema enum`,
        ).toEqual(values);
      }
    });
  }
});
