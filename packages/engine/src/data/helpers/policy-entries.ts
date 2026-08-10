// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `policy_entries` table. Each takes the bound
 * `EngineSql` and carries the exact SQL and semantics from the former inline
 * `UserAgent` call sites — no behavior change.
 *
 * The deny-floor seed in `migrate()` stays inline there: it is one-off
 * data/cleanup outside the helper pattern, same bucket as the
 * `policy_overrides` drop. Row→PolicyEntry domain mapping, grant expiry math,
 * and the wildcard-scope guard stay in `UserAgent`.
 */
import type { EngineSql } from "./types";
import type { PolicyEntriesRow } from "../schemas/policy-entries";

/** Every column the policy evaluator reads — all but `consumed_at`. */
export type ActivePolicyEntryRow = Omit<PolicyEntriesRow, "consumed_at">;

/**
 * Active entries for evaluation: unconsumed, unexpired, matching the session,
 * highest priority first so the first match wins in evaluatePolicy. The
 * `session_id IS NULL` branch now admits only the `standing` deny floor —
 * `session` and `task` grants both carry their minting session, so a
 * task grant from another session is not evaluated here.
 *
 * Expiry compares against `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, NOT
 * `datetime('now')`: `expires_at` is a JS ISO-8601 string and SQLite compares
 * TEXT lexicographically, so the space-separated `datetime('now')` form would
 * read every grant as unexpired ('T' > ' '). Both sides must be ISO-shaped.
 */
export function selectActivePolicyEntries(
  sql: EngineSql,
  sessionId: string | null,
): ActivePolicyEntryRow[] {
  return [
    ...sql<ActivePolicyEntryRow>`
      SELECT id, source, session_id, service, verb, noun, decision, priority, created_at, expires_at
      FROM policy_entries
      WHERE source IN ('session', 'task', 'standing')
        AND (session_id IS NULL OR session_id = ${sessionId})
        AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND consumed_at IS NULL
      ORDER BY priority DESC
    `,
  ];
}

/**
 * Active grants for the status view (`GET /api/status`):
 * unconsumed, unexpired entries matching the session, filtered to
 * `source IN ('session','task')`. Deliberately narrower than
 * `selectActivePolicyEntries`, which also selects `standing` — the default-deny
 * floor is not a grant and must not double-render in the status view. Same
 * ISO-shaped expiry comparison as its sibling (a `datetime('now')` form would
 * read every grant unexpired). Stable-ordered newest-first within a priority.
 *
 * Matches strictly on `session_id = ?` (no `IS NULL` branch): both `session`
 * and `task` grants now carry the session that minted them, so a
 * grant from another session is never surfaced here — and only `standing`
 * (excluded above) is ever session-less.
 */
export function selectActiveGrants(
  sql: EngineSql,
  sessionId: string | null,
): ActivePolicyEntryRow[] {
  return [
    ...sql<ActivePolicyEntryRow>`
      SELECT id, source, session_id, service, verb, noun, decision, priority, created_at, expires_at
      FROM policy_entries
      WHERE source IN ('session', 'task')
        AND session_id = ${sessionId}
        AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        AND consumed_at IS NULL
      ORDER BY priority DESC, created_at DESC
    `,
  ];
}

/** All standing entries for API display, stable-ordered within a priority. */
export function selectStandingEntries(
  sql: EngineSql,
): ActivePolicyEntryRow[] {
  return [
    ...sql<ActivePolicyEntryRow>`
      SELECT id, source, session_id, service, verb, noun, decision, priority, created_at, expires_at
      FROM policy_entries
      WHERE source = 'standing'
      ORDER BY priority DESC, created_at ASC
    `,
  ];
}

/** The scope columns of one entry by id — assertDenyFloor's boot-time read. */
export function readPolicyEntryScope(
  sql: EngineSql,
  id: string,
): Pick<
  PolicyEntriesRow,
  "decision" | "service" | "verb" | "noun" | "priority"
> | null {
  const rows = [
    ...sql<
      Pick<PolicyEntriesRow, "decision" | "service" | "verb" | "noun" | "priority">
    >`
      SELECT decision, service, verb, noun, priority
      FROM policy_entries
      WHERE id = ${id}
    `,
  ];
  return rows[0] ?? null;
}

/** Insert a session-scoped grant (priority 10, expiry anchored by the caller). */
export function insertSessionGrant(
  sql: EngineSql,
  params: {
    id: string;
    sessionId: string;
    service: string;
    verb: string;
    noun: string;
    decision: "allow" | "deny";
    createdAt: string;
    expiresAt: string;
  },
): void {
  sql`
    INSERT INTO policy_entries (id, source, session_id, service, verb, noun, decision, priority, created_at, expires_at)
    VALUES (${params.id}, 'session', ${params.sessionId}, ${params.service}, ${params.verb}, ${params.noun}, ${params.decision}, 10, ${params.createdAt}, ${params.expiresAt})
  `;
}

/**
 * Insert a task-scoped (single-use) grant — no expiry, bounded by consumption.
 * Bound to the session that minted it (`session_id`), so it can never surface
 * under a later session: a task grant is a within-session scope, not a
 * session-less one. `standing` remains the only source stored with a NULL
 * `session_id`.
 */
export function insertTaskGrant(
  sql: EngineSql,
  params: {
    id: string;
    sessionId: string;
    service: string;
    verb: string;
    noun: string;
    decision: "allow" | "deny";
    createdAt: string;
  },
): void {
  sql`
    INSERT INTO policy_entries (id, source, session_id, service, verb, noun, decision, priority, created_at)
    VALUES (${params.id}, 'task', ${params.sessionId}, ${params.service}, ${params.verb}, ${params.noun}, ${params.decision}, 10, ${params.createdAt})
  `;
}

/**
 * Mark a task grant consumed. Guarded to unconsumed task rows so a repeat
 * call can never move the consumption instant.
 */
export function consumeTaskGrant(
  sql: EngineSql,
  entryId: string,
  consumedAt: string,
): void {
  sql`
    UPDATE policy_entries SET consumed_at = ${consumedAt}
    WHERE id = ${entryId} AND source = 'task' AND consumed_at IS NULL
  `;
}

/** Delete every entry except the deny floor — killSwitch TX1 (deny-all). */
export function deletePolicyEntriesExcept(
  sql: EngineSql,
  keepId: string,
): void {
  sql`DELETE FROM policy_entries WHERE id != ${keepId}`;
}
