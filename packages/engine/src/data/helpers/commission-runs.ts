// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `commission_runs` table — the minimal run
 * record behind `habenula_commission` / `habenula_result`, the kernel of
 * the task model. Statement-level only, no
 * transactions of their own.
 *
 * Terminal-status writes are conditional and absorbing:
 * they apply only over a non-terminal status, so a quit/kill/read-time
 * `expired` landing mid-turn can never be overwritten by that turn's later
 * `completed`, and repeated writes are idempotent.
 */
import type { EngineSql } from "./types";
import type { CommissionRunsRow } from "../schemas/commission-runs";

/** Derived from the codegen row schema so the union can never drift from DDL. */
export type CommissionRunStatus = CommissionRunsRow["status"];

/** Create the run record (`running`). `data` is the JSON-encoded value map or null. */
export function insertCommissionRun(
  sql: EngineSql,
  params: {
    id: string;
    goal: string;
    data: string | null;
    sessionId: string;
    createdAt: string;
  },
): void {
  sql`
    INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
    VALUES (${params.id}, 'mcp_commission', ${params.goal}, ${params.data}, 'running', ${params.sessionId}, ${params.createdAt}, ${params.createdAt})
  `;
}

/** Read one run in full, or null. Read-time expiry stays at the call site. */
export function readCommissionRun(
  sql: EngineSql,
  id: string,
): CommissionRunsRow | null {
  const rows = [
    ...sql<CommissionRunsRow>`
      SELECT id, origin, goal, data, status, session_id, created_at, updated_at,
             label, status_detail, awaited_slot_keys
      FROM commission_runs WHERE id = ${id} LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/** The newest `limit` runs, newest first — the visual model snapshot's
 * bounded window. `created_at DESC, id DESC` for a stable order
 * under same-instant inserts. */
export function selectRecentCommissionRuns(
  sql: EngineSql,
  limit: number,
): CommissionRunsRow[] {
  return [
    ...sql<CommissionRunsRow>`
      SELECT id, origin, goal, data, status, session_id, created_at, updated_at
      FROM commission_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `,
  ];
}

/** The columns `listTasks` reports — the lightweight summary the queue view needs. */
export type TaskListRow = Pick<
  CommissionRunsRow,
  "id" | "origin" | "goal" | "status" | "label" | "created_at" | "updated_at"
>;

/**
 * The task-listing read behind `GET /api/tasks` / `habenula`-side inspection.
 * Cross-origin: the runs the DO
 * holds, newest first, as a lightweight summary — the full per-action detail
 * comes from `readCommissionRun` / `readTaskDetail`. Read-time expiry stays at
 * the call site (the DO reaps before listing), so a row here reports its stored
 * status.
 *
 * Bounded by `limit` and paged by a keyset `before` cursor `(created_at, id)`,
 * closing the Phase-B "unbounded, no LIMIT/pagination" flag: a DO holding a long
 * history never returns an unbounded payload. `(created_at DESC, id DESC)` is a
 * stable total order under same-instant inserts, and the row-value keyset
 * `(created_at, id) < (cursor)` is the matching pagination predicate. Rows are
 * never pruned — the bound is on the *view*, not retention (the task record
 * stays the queue's forensic surface).
 */
export function listTasks(
  sql: EngineSql,
  params: { limit: number; before?: { createdAt: string; id: string } },
): TaskListRow[] {
  const { limit, before } = params;
  if (before) {
    return [
      ...sql<TaskListRow>`
        SELECT id, origin, goal, status, label, created_at, updated_at
        FROM commission_runs
        WHERE (created_at, id) < (${before.createdAt}, ${before.id})
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `,
    ];
  }
  return [
    ...sql<TaskListRow>`
      SELECT id, origin, goal, status, label, created_at, updated_at
      FROM commission_runs
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `,
  ];
}

/**
 * Persist the per-action status detail: a JSON array of
 * `{service, verb, noun, outcome}` records, metadata only (never tool output).
 * Written after the commission loop settles, alongside the terminal status.
 * Unconditional — the detail is a faithful record of what ran and never needs
 * the absorbing-terminal guard the status write carries.
 */
export function updateTaskStatusDetail(
  sql: EngineSql,
  id: string,
  statusDetail: string,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET status_detail = ${statusDetail}, updated_at = ${updatedAt}
    WHERE id = ${id}
  `;
}

/**
 * Park a run on missing client input: move it to
 * `needs_input` and record the published slot key(s) it awaits (a JSON array,
 * closed vocabulary — never model prose). Same absorbing guard as the status
 * writes: applies only while the run is still non-terminal, so a quit/kill
 * landing mid-turn is never overwritten.
 */
export function markNeedsInput(
  sql: EngineSql,
  id: string,
  awaitedSlotKeys: string,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET status = 'needs_input', awaited_slot_keys = ${awaitedSlotKeys}, updated_at = ${updatedAt}
    WHERE id = ${id} AND status IN ('running', 'awaiting_confirmation')
  `;
}

/**
 * Resume a `needs_input` run: move it back to `running`
 * and clear the awaited-slot record, so the normal terminal / awaiting writes
 * apply again once the re-attempted call settles. Scoped to `needs_input` — the
 * one non-terminal status the ordinary `updateCommissionStatus` guard excludes.
 */
export function clearNeedsInput(
  sql: EngineSql,
  id: string,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET status = 'running', awaited_slot_keys = NULL, updated_at = ${updatedAt}
    WHERE id = ${id} AND status = 'needs_input'
  `;
}

/**
 * Replace a run's bound `data` map: `habenula_provide`
 * merges the client's supplied values into the run's JSON `data` before
 * re-attempting the parked call, so `{{data.<key>}}` binding sees the new value.
 * The caller does the merge; this persists the result verbatim.
 */
export function updateRunData(
  sql: EngineSql,
  id: string,
  data: string,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET data = ${data}, updated_at = ${updatedAt}
    WHERE id = ${id}
  `;
}

/**
 * Move a run between statuses. A write to a terminal status (or between the
 * two non-terminal ones) applies only while the run is still non-terminal —
 * terminal states are absorbing.
 */
export function updateCommissionStatus(
  sql: EngineSql,
  id: string,
  status: CommissionRunStatus,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET status = ${status}, updated_at = ${updatedAt}
    WHERE id = ${id} AND status IN ('running', 'awaiting_confirmation')
  `;
}

/**
 * Cancel a parked task: move an `awaiting_confirmation`
 * or `needs_input` run to the terminal `cancelled` state. Guarded to exactly
 * those two parked statuses — a `running` task holds the live turn (the cancel
 * is refused upstream before reaching here) and a terminal status is absorbing,
 * so a stray or racing cancel can never overwrite either. The caller sweeps the
 * task's hold and closes its pending audit entry in the SAME transaction as this
 * write (Hard Invariant 3).
 */
export function cancelRun(sql: EngineSql, id: string, updatedAt: string): void {
  sql`
    UPDATE commission_runs
    SET status = 'cancelled', updated_at = ${updatedAt}
    WHERE id = ${id} AND status IN ('awaiting_confirmation', 'needs_input')
  `;
}

/**
 * Non-terminal runs (the bounded-commission cap's read + crash reconciliation).
 * Includes `needs_input`: a task parked on missing client
 * input is pending, so it MUST count toward `MAX_PENDING_COMMISSIONS` — else an
 * untrusted client could accumulate unbounded needs_input tasks and defeat the
 * DoS bound. This is the cap/reconciliation view only;
 * `updateCommissionStatus`'s absorbing guard deliberately still EXCLUDES
 * needs_input (see `clearNeedsInput`).
 */
export function selectNonTerminalRuns(
  sql: EngineSql,
): Pick<CommissionRunsRow, "id" | "status" | "session_id" | "origin">[] {
  return [
    ...sql<Pick<CommissionRunsRow, "id" | "status" | "session_id" | "origin">>`
      SELECT id, status, session_id, origin FROM commission_runs
      WHERE status IN ('running', 'awaiting_confirmation', 'needs_input')
    `,
  ];
}

/**
 * Mark a session's non-terminal runs `expired` — the session-end sweeps'
 * write (timeout reap / quit / superseded / kill TX2). Absorbing: it never
 * overwrites a terminal. Includes `needs_input` so a
 * task parked on missing input resolves to `expired` when its session lapses
 * — its
 * input hold is swept with every other hold, so the run must not linger
 * `needs_input` against a dead session.
 */
export function markRunsExpiredForSession(
  sql: EngineSql,
  sessionId: string,
  updatedAt: string,
): void {
  sql`
    UPDATE commission_runs
    SET status = 'expired', updated_at = ${updatedAt}
    WHERE session_id = ${sessionId} AND status IN ('running', 'awaiting_confirmation', 'needs_input')
  `;
}

/**
 * Expire a single run by id from any non-terminal status, including
 * `needs_input`. The read-time belts (`commissionGoal`
 * cap count, `readCommissionRun`) expire a run whose session ended without its
 * sweep. Unlike `updateCommissionStatus`, whose guard excludes `needs_input`
 * so the post-park `awaiting_confirmation` write no-ops correctly, this write
 * MUST reach a `needs_input` run. Absorbing: it never overwrites a terminal.
 */
export function expireRun(sql: EngineSql, id: string, updatedAt: string): void {
  sql`
    UPDATE commission_runs
    SET status = 'expired', updated_at = ${updatedAt}
    WHERE id = ${id} AND status IN ('running', 'awaiting_confirmation', 'needs_input')
  `;
}
