// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical DDL registry for the coordinator DO's SQLite schema.
 *
 * Each `CREATE TABLE` / `CREATE INDEX` string is copied verbatim from the
 * historical inline `UserAgent.migrate()` body. This module is the single
 * source of truth for the schema: `migrate()` executes these strings, and the
 * codegen step (`data/codegen/generate.ts`) parses them to emit the Zod row
 * schemas under `data/schemas/`. Keep it hand-written and free of any
 * data/cleanup statements (seeds, back-compat drops, deletes) — those stay in
 * `migrate()`, outside this registry, so the generator never sees them.
 *
 * Order matches the original `migrate()` table-creation order.
 */

export interface TableDdl {
  /** The `CREATE TABLE IF NOT EXISTS …` statement, verbatim. */
  ddl: string;
  /** Zero or more `CREATE INDEX …` statements for this table, verbatim. */
  indexes: string[];
}

export const TABLES = {
  audit_log: {
    ddl: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        epoch_id TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        epoch_prev_hash TEXT,
        timestamp TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        service TEXT NOT NULL,
        verb TEXT NOT NULL,
        noun TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('allow','deny','pending')),
        parameters_metadata TEXT NOT NULL,
        parameters_content TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success','error','timeout')),
        error_message TEXT,
        decision_entry_id TEXT,
        latency_ms INTEGER NOT NULL,
        cost_usd REAL,
        origin TEXT NOT NULL DEFAULT 'human' CHECK(origin IN ('human','mcp_commission'))
      )
    `,
    indexes: [
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_epoch ON audit_log(epoch_id, sequence_num)`,
      `CREATE INDEX IF NOT EXISTS idx_timestamp ON audit_log(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_service ON audit_log(service)`,
      `CREATE INDEX IF NOT EXISTS idx_decision ON audit_log(decision)`,
      // Deliberately NON-unique, and not an oversight to "fix": a UNIQUE
      // constraint on an append-only table enforces first-writer-wins, and the
      // losing write may be the true one — a sweep's inferred timeout racing a
      // real outcome would then block the truth from landing. The write rule
      // lives in `closeDecisionEntryInTxn` (basis-aware, skip only when
      // inferred); a second closer is a correction, not an error.
      `CREATE INDEX IF NOT EXISTS idx_decision_entry ON audit_log(decision_entry_id)`,
    ],
  },
  connected_services: {
    ddl: `
      CREATE TABLE IF NOT EXISTS connected_services (
        service TEXT PRIMARY KEY,
        connected_at TEXT NOT NULL,
        credential TEXT
      )
    `,
    indexes: [],
  },
  user_settings: {
    ddl: `
      CREATE TABLE IF NOT EXISTS user_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `,
    indexes: [],
  },
  oauth_state: {
    // One row per in-flight authorization, ~10-minute TTL. Timestamps are
    // ISO-8601 UTC strings (`Date.toISOString()`), the representation every
    // table here uses. Expiry is compared in JS at the call site, not in SQL:
    // fixed-width ISO UTC sorts lexicographically in timestamp order, so a
    // plain `<=` is chronological. Any future SQL-side comparison must use
    // `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, never `datetime('now')` — the
    // latter is space-separated and 'T' > ' ', so every row would read as
    // unexpired (the trap `policy_entries` documents).
    ddl: `
      CREATE TABLE IF NOT EXISTS oauth_state (
        state_key TEXT PRIMARY KEY,
        code_verifier TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        service TEXT NOT NULL,
        auth_code TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT CHECK(status IN ('denied'))
      )
    `,
    indexes: [],
  },
  policy_entries: {
    ddl: `
      CREATE TABLE IF NOT EXISTS policy_entries (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('session','task','standing')),
        session_id TEXT,
        service TEXT NOT NULL,
        verb TEXT NOT NULL,
        noun TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('allow','deny')), -- no DEFAULT: an insert omitting decision must fail closed, not silently default to 'allow'
        priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IS NOT NULL), -- 2nd storage guard against a null priority; primary guard is evaluate-policy.ts, which denies outright on a non-finite priority
        created_at TEXT NOT NULL,
        expires_at TEXT,
        consumed_at TEXT
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_policy_source ON policy_entries(source)`,
      `CREATE INDEX IF NOT EXISTS idx_policy_session ON policy_entries(session_id)`,
    ],
  },
  held_tool_calls: {
    ddl: `
      CREATE TABLE IF NOT EXISTS held_tool_calls (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        pending_audit_entry_id TEXT NOT NULL,
        turn_state TEXT NOT NULL,
        held_at TEXT NOT NULL,
        run_id TEXT,
        hold_kind TEXT NOT NULL DEFAULT 'confirmation' CHECK(hold_kind IN ('confirmation','input')),
        awaited_slot_keys TEXT,
        spend_context TEXT
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_held_session ON held_tool_calls(session_id)`,
    ],
  },
  commission_runs: {
    ddl: `
      CREATE TABLE IF NOT EXISTS commission_runs (
        id TEXT PRIMARY KEY NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('mcp_commission','human')),
        goal TEXT NOT NULL,
        data TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','awaiting_confirmation','completed','failed','denied','expired','needs_input','cancelled')),
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        label TEXT,
        status_detail TEXT,
        awaited_slot_keys TEXT
      )
    `,
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_commission_session ON commission_runs(session_id)`,
      // Backs `listTasks`' keyset page order. Without it
      // every page full-scans and sorts, and `task watch` re-runs that per tick —
      // so the pagination would bound the payload but not the work. Rows are
      // never pruned by design, so the scan cost grows with commission history.
      `CREATE INDEX IF NOT EXISTS idx_commission_created ON commission_runs(created_at DESC, id DESC)`,
    ],
  },
  session_state: {
    ddl: `
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        ended_at TEXT
      )
    `,
    indexes: [],
  },
  spend_ledger: {
    // One row per committed spend. Both windows are
    // SUM queries over this table — no counters, so no increment to
    // double-apply, no reset to schedule, no rollover boundary. Amounts are
    // integer cents (never REAL — float drifts under accumulation, which is
    // exactly this access pattern); the CHECKs are the storage-layer guard —
    // a negative row would permanently widen both windows (a cap bypass).
    // `settled_amount_cents` stays unset until receipt-driven reconciliation
    // lands; `audit_entry_id` links each spend to its hash-chained outcome
    // row so a ledger-gap check is a join. Rows are never pruned in this
    // phase; like audit_log, lifetime growth needs a retention/archival plan
    // (month sums only ever read current-month rows) — deferred with
    // reconciliation, which owns the row lifecycle.
    ddl: `
      CREATE TABLE IF NOT EXISTS spend_ledger (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        service TEXT NOT NULL,
        verb TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
        quote_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        settled_amount_cents INTEGER CHECK(settled_amount_cents IS NULL OR settled_amount_cents >= 0),
        audit_entry_id TEXT NOT NULL
      )
    `,
    indexes: [
      // Unique on the PAIR: keyed on the idempotency key alone, a
      // model-authored key reused under a different quote would be silently
      // dropped by INSERT OR IGNORE — an uncounted spend is a cap bypass.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_idempotency ON spend_ledger(idempotency_key, quote_id)`,
      `CREATE INDEX IF NOT EXISTS idx_spend_session ON spend_ledger(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_spend_created ON spend_ledger(created_at)`,
    ],
  },
} satisfies Record<string, TableDdl>;

/** Table names in migrate() creation order. */
export const TABLE_NAMES = Object.keys(TABLES);
