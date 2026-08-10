// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `spend_ledger` table.
 * One row per committed spend; both windows are SUM queries — no counters.
 * The sum helpers throw on storage failure; the caller maps a throw to the
 * spend check's `unavailable` outcome (hold and ask, never silent allow).
 */
import type { EngineSql } from "./types";

export interface SpendLedgerInsert {
  id: string;
  sessionId: string;
  createdAt: string;
  service: string;
  verb: string;
  amountCents: number;
  quoteId: string;
  idempotencyKey: string;
  auditEntryId: string;
}

/**
 * The exact shape `new Date().toISOString()` emits. `sumMonthSpendCents`
 * compares `created_at` lexicographically against a boundary in this shape,
 * so a row written in any other form (no millis, a zone offset, epoch millis)
 * would mis-bucket silently — enforce the format where rows are written.
 */
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Record one committed spend. `ON CONFLICT (idempotency_key, quote_id) DO
 * NOTHING` makes a replayed commit idempotent — same key, same quote writes
 * one row — and ONLY that: any other constraint violation still throws, so a
 * caller bug can never silently drop a committed spend (an uncounted spend is
 * a cap bypass; `INSERT OR IGNORE` would swallow those too). The pair (not
 * the key alone) is load-bearing: a model-authored key reused under a
 * DIFFERENT quote is a new spend and must be counted. Callers run this inside
 * the same transaction as the outcome audit write (Hard Invariant #3 pairing).
 *
 * Amounts are integer cents by invariant: a negative
 * row would permanently shrink both SUM windows and a fractional one would
 * break the integer arithmetic the cap depends on, so both throw loudly here
 * rather than corrupting the ledger — mirroring the DDL's CHECK.
 */
export function insertSpendInTxn(sql: EngineSql, row: SpendLedgerInsert): void {
  if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0) {
    throw new Error(
      `spend_ledger: amountCents must be a non-negative integer, got ${row.amountCents}`,
    );
  }
  if (!ISO_UTC_MILLIS.test(row.createdAt)) {
    throw new Error(
      `spend_ledger: createdAt must be toISOString() form (UTC millis), got ${row.createdAt}`,
    );
  }
  sql`
    INSERT INTO spend_ledger (id, session_id, created_at, service, verb, amount_cents, quote_id, idempotency_key, settled_amount_cents, audit_entry_id)
    VALUES (${row.id}, ${row.sessionId}, ${row.createdAt}, ${row.service}, ${row.verb}, ${row.amountCents}, ${row.quoteId}, ${row.idempotencyKey}, ${null}, ${row.auditEntryId})
    ON CONFLICT (idempotency_key, quote_id) DO NOTHING
  `;
}

/** The session window: SUM over the active session's rows. */
export function sumSessionSpendCents(sql: EngineSql, sessionId: string): number {
  const rows = [
    ...sql<{ total: number }>`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_ledger
      WHERE session_id = ${sessionId}
    `,
  ];
  return rows[0]?.total ?? 0;
}

/**
 * The month window: SUM since the first instant of the current UTC calendar
 * month. The boundary is the caller's to compute — `created_at` is ISO-8601
 * UTC, so the comparison is lexicographic.
 */
export function sumMonthSpendCents(sql: EngineSql, monthStartIso: string): number {
  const rows = [
    ...sql<{ total: number }>`
      SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_ledger
      WHERE created_at >= ${monthStartIso}
    `,
  ];
  return rows[0]?.total ?? 0;
}
