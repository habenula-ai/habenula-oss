import { describe, it, expect } from "vitest";
import { TABLES } from "../../src/data/ddl";
import { extractCheckEnums } from "../../src/data/codegen/extract-check-enums";
import {
  renderSchema,
  rowName,
  enumName,
  type ColumnMeta,
} from "../../src/data/codegen/templates";

/**
 * Independent guard on the emit layer. Expectations are hand-written literals,
 * NOT derived from extractCheckEnums or introspection — so a bug in either is
 * caught here rather than silently baked into the committed schemas.
 */

describe("extractCheckEnums — from the real DDL", () => {
  it("pulls all three CHECK enums out of audit_log", () => {
    expect(extractCheckEnums(TABLES.audit_log.ddl)).toEqual({
      decision: ["allow", "deny", "pending"],
      outcome: ["success", "error", "timeout"],
      origin: ["human", "mcp_commission"],
    });
  });

  it("pulls source and decision out of policy_entries", () => {
    expect(extractCheckEnums(TABLES.policy_entries.ddl)).toEqual({
      source: ["session", "task", "standing"],
      decision: ["allow", "deny"],
    });
  });

  it("pulls the single-value status enum out of oauth_state", () => {
    expect(extractCheckEnums(TABLES.oauth_state.ddl)).toEqual({
      status: ["denied"],
    });
  });

  it("returns nothing for tables without CHECK constraints", () => {
    for (const t of [
      "connected_services",
      "user_settings",
      "session_state",
      "spend_ledger",
    ] as const) {
      expect(extractCheckEnums(TABLES[t].ddl)).toEqual({});
    }
  });
});

describe("renderSchema — SQL→Zod mapping", () => {
  it("maps types, nullability and PKs for connected_services", () => {
    const cols: ColumnMeta[] = [
      { name: "service", sqlType: "TEXT", nullable: false },
      { name: "connected_at", sqlType: "TEXT", nullable: false },
      { name: "credential", sqlType: "TEXT", nullable: true },
    ];
    const src = renderSchema("connected_services", cols);
    expect(src).toContain("export const ConnectedServicesRow = z.object({");
    expect(src).toContain("  service: z.string(),");
    expect(src).toContain("  connected_at: z.string(),");
    expect(src).toContain("  credential: z.string().nullable(),");
    expect(src).toContain(
      "export type ConnectedServicesRow = z.infer<typeof ConnectedServicesRow>;",
    );
    // No CHECK columns → no enum exports.
    expect(src).not.toContain("z.enum(");
  });

  it("emits enums and enum exports for audit_log", () => {
    const cols: ColumnMeta[] = [
      { name: "id", sqlType: "TEXT", nullable: false },
      { name: "latency_ms", sqlType: "INTEGER", nullable: false },
      { name: "cost_usd", sqlType: "REAL", nullable: true },
      { name: "epoch_prev_hash", sqlType: "TEXT", nullable: true },
      {
        name: "decision",
        sqlType: "TEXT",
        nullable: false,
        enumValues: ["allow", "deny", "pending"],
      },
      {
        name: "outcome",
        sqlType: "TEXT",
        nullable: false,
        enumValues: ["success", "error", "timeout"],
      },
    ];
    const src = renderSchema("audit_log", cols);
    expect(src).toContain("  id: z.string(),"); // PK → non-nullable
    expect(src).toContain("  latency_ms: z.number(),"); // INTEGER
    expect(src).toContain("  cost_usd: z.number().nullable(),"); // REAL nullable
    expect(src).toContain("  epoch_prev_hash: z.string().nullable(),");
    expect(src).toContain('  decision: z.enum(["allow", "deny", "pending"]),');
    expect(src).toContain('  outcome: z.enum(["success", "error", "timeout"]),');
    expect(src).toContain("export const AuditDecision = AuditLogRow.shape.decision;");
    expect(src).toContain("export const AuditOutcome = AuditLogRow.shape.outcome;");
  });

  it("names policy_entries enums PolicySource / PolicyDecision", () => {
    const cols: ColumnMeta[] = [
      { name: "session_id", sqlType: "TEXT", nullable: true },
      {
        name: "source",
        sqlType: "TEXT",
        nullable: false,
        enumValues: ["session", "task", "standing"],
      },
      {
        name: "decision",
        sqlType: "TEXT",
        nullable: false,
        enumValues: ["allow", "deny"],
      },
    ];
    const src = renderSchema("policy_entries", cols);
    expect(src).toContain("  session_id: z.string().nullable(),");
    expect(src).toContain('  source: z.enum(["session", "task", "standing"]),');
    expect(src).toContain('  decision: z.enum(["allow", "deny"]),');
    expect(src).toContain(
      "export const PolicySource = PolicyEntriesRow.shape.source;",
    );
    expect(src).toContain(
      "export const PolicyDecision = PolicyEntriesRow.shape.decision;",
    );
  });

  it("keeps the OAuth acronym casing in generated names", () => {
    const cols: ColumnMeta[] = [
      { name: "state_key", sqlType: "TEXT", nullable: false },
      { name: "created_at", sqlType: "INTEGER", nullable: false },
      { name: "auth_code", sqlType: "TEXT", nullable: true },
    ];
    const src = renderSchema("oauth_state", cols);
    expect(src).toContain("export const OAuthStateRow = z.object({");
    expect(src).toContain("  state_key: z.string(),");
    expect(src).toContain("  created_at: z.number(),");
    expect(src).toContain("  auth_code: z.string().nullable(),");
  });

  it("derives export names consistently", () => {
    expect(rowName("held_tool_calls")).toBe("HeldToolCallsRow");
    expect(rowName("oauth_state")).toBe("OAuthStateRow");
    expect(enumName("audit_log", "decision")).toBe("AuditDecision");
    expect(enumName("policy_entries", "source")).toBe("PolicySource");
  });
});
