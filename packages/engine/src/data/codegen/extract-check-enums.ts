// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parse `CHECK(col IN ('a','b',…))` column constraints out of a CREATE TABLE
 * statement (or a `sqlite_master.sql` string — they are the same text for our
 * schema). Returns a map of column name → ordered enum values.
 *
 * Imported by BOTH the generator (`generate.ts`) and the parity test, so
 * generation and verification share one extraction code path. The generator
 * test asserts against hand-written literal enums (not this function's output),
 * which is the independent guard against a bug in here.
 */
export function extractCheckEnums(
  createTableSql: string,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  // Matches: CHECK ( <col> IN ( '<v>', '<v>', … ) )
  const checkRe = /CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = checkRe.exec(createTableSql)) !== null) {
    const column = match[1];
    const rawList = match[2];
    if (column === undefined || rawList === undefined) continue;
    result[column] = [...rawList.matchAll(/'([^']*)'/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined);
  }
  return result;
}
