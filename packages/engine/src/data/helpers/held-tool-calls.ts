// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `held_tool_calls` table. Each takes the bound
 * `EngineSql` and carries the exact SQL and semantics from the former inline
 * `UserAgent` call sites — no behavior change.
 *
 * Session-expiry and mid-resume (`answered` turn_state) filtering stay in
 * `UserAgent`: they cross into `session_state` and JSON turn-state parsing,
 * and helpers are single-statement, single-table.
 */
import type { EngineSql } from "./types";
import type { HeldToolCallsRow } from "../schemas/held-tool-calls";

/**
 * Park a call awaiting confirmation. `turn_state` defaults to empty; the
 * conversation loop fills it in via `updateHeldTurnState` once the in-flight
 * turn snapshot exists. Callers that already have a turn-state snapshot (the
 * executeTool park path seeds a `directExecute` one) pass it here
 * so the row is created in a single write rather than an insert-then-update.
 */
export function insertHeldToolCall(
  sql: EngineSql,
  id: string,
  sessionId: string,
  pendingAuditEntryId: string,
  heldAt: string,
  runId: string | null = null,
  turnState = "",
  holdKind: HeldToolCallsRow["hold_kind"] = "confirmation",
  awaitedSlotKeys: string | null = null,
  spendContext: string | null = null,
): void {
  sql`
    INSERT INTO held_tool_calls (id, session_id, pending_audit_entry_id, turn_state, held_at, run_id, hold_kind, awaited_slot_keys, spend_context)
    VALUES (${id}, ${sessionId}, ${pendingAuditEntryId}, ${turnState}, ${heldAt}, ${runId}, ${holdKind}, ${awaitedSlotKeys}, ${spendContext})
  `;
}

/**
 * All held rows in deterministic `held_at` order (oldest first). The ordering
 * matters now that several holds can coexist: the DO's
 * single-hold reads (`heldCallId`, the status snapshot) must pick a stable row,
 * not whichever the engine yields first. `run_id` lets a caller scope to a task
 * (null = the human conversation).
 */
/**
 * Ordered by `(held_at, id)` — a TOTAL order. `held_at` alone is not: two holds
 * parked inside the same millisecond tie, and SQLite may then yield them in any
 * order. This read picks the live-slot hold behind the status snapshot, which
 * is required to be deterministic ("not whichever row the query
 * yields first"), so `id` breaks the tie.
 */
export function selectHeldCalls(
  sql: EngineSql,
): Pick<HeldToolCallsRow, "id" | "session_id" | "turn_state" | "run_id">[] {
  return [
    ...sql<Pick<HeldToolCallsRow, "id" | "session_id" | "turn_state" | "run_id">>`
      SELECT id, session_id, turn_state, run_id FROM held_tool_calls
      ORDER BY held_at ASC, id ASC
    `,
  ];
}

/** Read one held call in full, or null. Read-time expiry stays at the call site. */
export function readHeldCall(
  sql: EngineSql,
  id: string,
): HeldToolCallsRow | null {
  const rows = [
    ...sql<HeldToolCallsRow>`
      SELECT id, session_id, pending_audit_entry_id, turn_state, held_at, run_id,
             hold_kind, awaited_slot_keys, spend_context
      FROM held_tool_calls WHERE id = ${id} LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/**
 * A task's parked `input` hold, or null. `habenula_provide`
 * resolves a `needs_input` task by finding its one input hold; `hold_kind='input'`
 * distinguishes it from a confirmation hold the same task might later own. Read-time
 * expiry and mid-resume filtering stay at the DO call site.
 */
export function selectInputHoldForTask(
  sql: EngineSql,
  runId: string,
): Pick<HeldToolCallsRow, "id" | "turn_state" | "pending_audit_entry_id"> | null {
  const rows = [
    ...sql<Pick<HeldToolCallsRow, "id" | "turn_state" | "pending_audit_entry_id">>`
      SELECT id, turn_state, pending_audit_entry_id FROM held_tool_calls
      WHERE run_id = ${runId} AND hold_kind = 'input' LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/** Persist the in-flight turn-state blob against a held call. */
export function updateHeldTurnState(
  sql: EngineSql,
  id: string,
  turnState: string,
): void {
  sql`UPDATE held_tool_calls SET turn_state = ${turnState} WHERE id = ${id}`;
}

/**
 * Rewrite a hold in place as a spend hold: a money-verb
 * call resumed by a grant passed permission but breached the cap, so the SAME
 * row re-parks under a fresh pending audit entry with its spend context (the
 * amount, the breaches, and the authorizing grant id riding along). The turn
 * state is untouched — the parked call stays resumable by `approve_once`.
 */
export function reholdForSpend(
  sql: EngineSql,
  id: string,
  pendingAuditEntryId: string,
  spendContext: string,
): void {
  sql`
    UPDATE held_tool_calls
    SET pending_audit_entry_id = ${pendingAuditEntryId}, spend_context = ${spendContext}
    WHERE id = ${id}
  `;
}

/**
 * A run's surviving held call, or null — the crash-repair discriminator
 * A `running` run with a live run-linked hold died between the
 * park and the awaiting write, so its TRUE state is awaiting, never failed.
 */
export function selectHeldCallForRun(
  sql: EngineSql,
  runId: string,
): Pick<HeldToolCallsRow, "id"> | null {
  const rows = [
    ...sql<Pick<HeldToolCallsRow, "id">>`
      SELECT id FROM held_tool_calls WHERE run_id = ${runId} LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/** Delete one held call (resolve / expiry / kill). */
export function deleteHeldToolCall(sql: EngineSql, id: string): void {
  sql`DELETE FROM held_tool_calls WHERE id = ${id}`;
}

/**
 * A session's held calls with their pending-entry refs and turn state — the
 * session-end sweeps' read. `turn_state` lets a sweep tell a genuinely parked
 * call from one mid-resolve (dispatched/answered), whose terminal audit
 * outcome belongs to the resolve path.
 */
/**
 * EVERY hold a run owns, oldest first. `selectHeldCallForRun`
 * answers "does this run have a live hold" with `LIMIT 1`; a SWEEP must not use it.
 * One run normally owns one hold, but `provideTaskInput` transiently holds two (it
 * parks the re-attempt's confirmation hold before deleting the input hold), so an
 * isolate death in that window leaves two rows on one `run_id`. A sweep that deletes
 * only one leaves the survivor with a dangling `pending` audit entry AND still
 * independently resolvable — approving it would dispatch a tool for a task the user
 * already cancelled. `turn_state` comes back so the caller can tell a genuinely
 * parked call from one mid-resolve, exactly as `selectHeldCallsForSession` does.
 */
export function selectHeldCallsForRun(
  sql: EngineSql,
  runId: string,
): Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">[] {
  return [
    ...sql<Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">>`
      SELECT id, pending_audit_entry_id, turn_state FROM held_tool_calls
      WHERE run_id = ${runId}
      ORDER BY held_at ASC, id ASC
    `,
  ];
}

export function selectHeldCallsForSession(
  sql: EngineSql,
  sessionId: string,
): Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">[] {
  return [
    ...sql<Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">>`
      SELECT id, pending_audit_entry_id, turn_state FROM held_tool_calls
      WHERE session_id = ${sessionId}
    `,
  ];
}

/**
 * Every held call's pending-entry ref — killSwitch's pre-TX1 snapshot, taken
 * before the rows are deleted so TX2 can still resolve their audit entries.
 * `turn_state` rides along so TX2 can skip mid-resolve calls (dispatched/
 * answered) whose real outcome the resolve path owns — the same invariant the
 * session-end sweeps enforce via `selectHeldCallsForSession`.
 */
export function selectHeldCallAuditRefs(
  sql: EngineSql,
): Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">[] {
  return [
    ...sql<Pick<HeldToolCallsRow, "id" | "pending_audit_entry_id" | "turn_state">>`
      SELECT id, pending_audit_entry_id, turn_state FROM held_tool_calls
    `,
  ];
}

/** Clear all held calls — killSwitch TX1 (deny-all). */
export function deleteAllHeldToolCalls(sql: EngineSql): void {
  sql`DELETE FROM held_tool_calls`;
}
