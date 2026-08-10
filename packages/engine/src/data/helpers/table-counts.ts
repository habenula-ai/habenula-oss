// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Row counts per coordinator-DO table — the visual model snapshot's
 * `tableCounts` read. One switch over nine literal single-table
 * statements: SQL identifiers can't be bound as template values, and the
 * literal-per-table form keeps each query a static string within the
 * single-statement helper rule instead of interpolating
 * an identifier.
 */
import type { EngineSql } from "./types";
import type { TABLES } from "../ddl";

export type CountableTable = keyof typeof TABLES;

export function countRows(sql: EngineSql, table: CountableTable): number {
  const rows = (() => {
    switch (table) {
      case "audit_log":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM audit_log`;
      case "connected_services":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM connected_services`;
      case "user_settings":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM user_settings`;
      case "oauth_state":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM oauth_state`;
      case "policy_entries":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`;
      case "held_tool_calls":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`;
      case "commission_runs":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM commission_runs`;
      case "session_state":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM session_state`;
      case "spend_ledger":
        return sql<{ n: number }>`SELECT COUNT(*) AS n FROM spend_ledger`;
    }
  })();
  return rows[0]?.n ?? 0;
}
