// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-console -- Node build-time CLI: console is the intended output channel. */
/**
 * Schema codegen entrypoint. Runs under Node (via the pinned `tsx`), never in
 * the Workers runtime — it uses `node:sqlite` to introspect the canonical DDL
 * and emit one Zod row-schema module per table under `src/data/schemas/`.
 *
 * Pipeline: DDL registry (data/ddl.ts) → in-memory SQLite → PRAGMA
 * introspection + CHECK-enum extraction → pure renderer (templates.ts) →
 * committed `.ts` artifacts. A spike proved node:sqlite introspection is
 * identical to the real DO's, so these artifacts match production schema.
 *
 * Run with `just engine-codegen`. Generated files are committed and never
 * hand-edited; `scripts/check-schemas-fresh.cjs` fails CI if they drift.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TABLES } from "../ddl.ts";
import { extractCheckEnums } from "./extract-check-enums.ts";
import { renderSchema, type ColumnMeta, type SqlType } from "./templates.ts";

interface PragmaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const SQL_TYPES: readonly string[] = ["TEXT", "INTEGER", "REAL"];

function toSqlType(table: string, column: string, rawType: string): SqlType {
  if (!SQL_TYPES.includes(rawType)) {
    throw new Error(
      `Unmapped SQL type '${rawType}' on ${table}.${column} — extend SqlType/templates.ts before generating.`,
    );
  }
  return rawType as SqlType;
}

function introspect(): Record<string, ColumnMeta[]> {
  const db = new DatabaseSync(":memory:");
  for (const { ddl, indexes } of Object.values(TABLES)) {
    db.exec(ddl);
    for (const index of indexes) db.exec(index);
  }

  const perTable: Record<string, ColumnMeta[]> = {};
  for (const table of Object.keys(TABLES)) {
    const createSql = (
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string }
    ).sql;
    const checkEnums = extractCheckEnums(createSql);

    // Guard against silent extractor degradation: if the DDL has a
    // `CHECK(col IN (...))` clause the extractor didn't turn into an enum (e.g.
    // a quoted identifier or a shape the regex misses), the column would fall
    // back to a bare z.string() with no warning. Fail loudly instead.
    const inCheckClauses = (createSql.match(/CHECK\s*\([^)]*\bIN\b/gi) ?? [])
      .length;
    if (Object.keys(checkEnums).length !== inCheckClauses) {
      throw new Error(
        `${table}: DDL has ${inCheckClauses} CHECK(... IN ...) clause(s) but the extractor produced ${Object.keys(checkEnums).length} enum(s) — extend extract-check-enums.ts to handle this DDL.`,
      );
    }

    // No ORDER BY → natural cid order → DDL column order (readable output).
    const cols = db
      .prepare(`SELECT name, type, "notnull", pk FROM pragma_table_info('${table}')`)
      .all() as unknown as PragmaColumn[];

    perTable[table] = cols.map((c) => {
      const enumValues = checkEnums[c.name];
      return {
        name: c.name,
        sqlType: toSqlType(table, c.name, c.type),
        // A PRIMARY KEY column is never null in practice; only non-PK columns
        // declared without NOT NULL are nullable.
        nullable: c.notnull === 0 && c.pk === 0,
        ...(enumValues ? { enumValues } : {}),
      };
    });
  }
  db.close();
  return perTable;
}

function main(): void {
  const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
  const perTable = introspect();

  const expected = new Set<string>();
  for (const [table, columns] of Object.entries(perTable)) {
    const kebab = table.replace(/_/g, "-");
    expected.add(`${kebab}.ts`);
    writeFileSync(join(schemasDir, `${kebab}.ts`), renderSchema(table, columns), "utf8");
    console.log(`generated schemas/${kebab}.ts (${columns.length} columns)`);
  }

  // Reconcile: drop any orphaned schema file left behind by a removed table so
  // the directory always mirrors the registry exactly (the freshness guard then
  // sees the deletion as drift if it wasn't committed).
  for (const file of readdirSync(schemasDir)) {
    if (file.endsWith(".ts") && !expected.has(file)) {
      rmSync(join(schemasDir, file));
      console.log(`removed orphaned schemas/${file}`);
    }
  }
}

main();
