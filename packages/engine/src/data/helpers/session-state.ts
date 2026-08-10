// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `session_state` table. Each takes the bound
 * `EngineSql` and carries the exact SQL and semantics from the former inline
 * `UserAgent` call sites — no behavior change, just a typed, single-source
 * layer over the generated `SessionStateRow`.
 *
 * Expiry math and the unparseable-`started_at` guard stay in `UserAgent`:
 * helpers are single-statement and single-table, orchestration lives at the
 * call site.
 */
import type { EngineSql } from "./types";
import type { SessionStateRow } from "../schemas/session-state";

/** Read a session's raw `started_at` anchor, or null if not established. */
export function readSessionStartedAt(
  sql: EngineSql,
  sessionId: string,
): string | null {
  const rows = [
    ...sql<Pick<SessionStateRow, "started_at">>`
      SELECT started_at FROM session_state WHERE session_id = ${sessionId} LIMIT 1
    `,
  ];
  return rows[0]?.started_at ?? null;
}

/**
 * Insert the session anchor row. `INSERT OR IGNORE` keeps establishment
 * idempotent — a concurrent or repeated establish never resets `started_at`.
 */
export function insertSessionState(
  sql: EngineSql,
  sessionId: string,
  startedAt: string,
  agentId: string,
): void {
  sql`
    INSERT OR IGNORE INTO session_state (session_id, started_at, agent_id)
    VALUES (${sessionId}, ${startedAt}, ${agentId})
  `;
}

/** All sessions not yet closed (`ended_at IS NULL`) — reaper and kill scan. */
export function selectOpenSessions(
  sql: EngineSql,
): Pick<SessionStateRow, "session_id" | "started_at">[] {
  return [
    ...sql<Pick<SessionStateRow, "session_id" | "started_at">>`
      SELECT session_id, started_at FROM session_state WHERE ended_at IS NULL
    `,
  ];
}

/**
 * The single active session: the newest un-ended row (`ended_at IS NULL`),
 * or null if none. The single-active invariant means at most
 * one un-ended row exists by construction; the `ORDER BY started_at DESC
 * LIMIT 1` is the tie-break for the accumulated-state and race cases, where
 * the newest wins and the derive reaps the rest (see `selectOpenSessions`).
 */
export function selectActiveSession(sql: EngineSql): SessionStateRow | null {
  const rows = [
    ...sql<SessionStateRow>`
      SELECT session_id, started_at, agent_id, ended_at FROM session_state
      WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/** Stamp a session closed. The caller supplies the effective-instant stamp. */
export function markSessionEnded(
  sql: EngineSql,
  sessionId: string,
  endedAt: string,
): void {
  sql`UPDATE session_state SET ended_at = ${endedAt} WHERE session_id = ${sessionId}`;
}

/**
 * A session's ended_at, or null if un-ended or absent — the read-time belt
 * for `readCommissionRun`: a run on an ended session
 * reports expired even when a best-effort sweep (kill TX2) was lost.
 */
export function readSessionEndedAt(
  sql: EngineSql,
  sessionId: string,
): string | null {
  const rows = [
    ...sql<{ ended_at: string | null }>`
      SELECT ended_at FROM session_state WHERE session_id = ${sessionId} LIMIT 1
    `,
  ];
  return rows[0]?.ended_at ?? null;
}
