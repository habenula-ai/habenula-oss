// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `oauth_state` table. Each takes the bound
 * `EngineSql` and carries the exact SQL and semantics from the former inline
 * `UserAgent` call sites — no behavior change.
 *
 * The single-use consume semantics (read + delete inside one
 * `transactionSync()`) and the ISO-8601 expiry comparison stay in
 * `UserAgent`: the orchestrator owns the transaction, and helpers are
 * single-statement. `state_key` is the lookup key, so reads return the
 * remaining columns as `OAuthStateData` (`oauth/types.ts`), the one shape
 * both this layer and `UserAgent` share — derived from the generated row
 * schema, not restated.
 */
import type { EngineSql } from "./types";
import type { OAuthStateData } from "../../oauth/types";
import type { OAuthStateRow } from "../schemas/oauth-state";

/** Store state for a pending authorization flow. */
export function insertOAuthState(
  sql: EngineSql,
  stateKey: string,
  data: OAuthStateData,
): void {
  sql`
    INSERT INTO oauth_state (state_key, code_verifier, code_challenge, service, auth_code, created_at, expires_at, status)
    VALUES (${stateKey}, ${data.code_verifier}, ${data.code_challenge}, ${data.service}, ${data.auth_code}, ${data.created_at}, ${data.expires_at}, ${data.status})
  `;
}

/**
 * Read state without consuming it, or null if absent. Expiry stays at the
 * call site.
 *
 * `SELECT *` rather than a hand-listed column set: `OAuthStateData` is
 * derived from `OAuthStateRow` and auto-widens if a column is ever added to
 * `oauth_state`, so a fixed column list here would silently stop matching it
 * (typed-present, runtime-undefined) the moment that happens. `SELECT *`
 * stays structurally in sync with whatever columns exist, the same
 * `SELECT *`-for-narrow-tables convention `connected-services.ts` uses.
 */
export function readOAuthState(
  sql: EngineSql,
  stateKey: string,
): OAuthStateData | null {
  const rows = [
    ...sql<OAuthStateRow>`
      SELECT * FROM oauth_state WHERE state_key = ${stateKey} LIMIT 1
    `,
  ];
  const row = rows[0];
  if (!row) return null;
  const { state_key, ...payload } = row;
  return payload;
}

/** Delete state — the consume/expired-cleanup half of the single-use pair. */
export function deleteOAuthState(sql: EngineSql, stateKey: string): void {
  sql`DELETE FROM oauth_state WHERE state_key = ${stateKey}`;
}

/**
 * Stamp a pending flow denied — the callback's `?error=` branch records the
 * terminal outcome so the CLI's status poll can observe it. A stamp, not
 * a delete: an immediate delete would read as row-absent
 * (i.e. still pending) to the status derivation; the observing CLI deletes
 * via cancel once it has reported the denial. No-op on an absent key.
 *
 * Keys on `state_key` alone — no service/status predicate — so the caller must
 * have already verified the flow's service belongs to the acting provider (the
 * callback's `?error=` branch does, before calling).
 */
export function markOAuthStateDenied(sql: EngineSql, stateKey: string): void {
  sql`UPDATE oauth_state SET status = 'denied' WHERE state_key = ${stateKey}`;
}

/**
 * Delete the pending rows for a service — the supersede half of
 * store-with-supersede: a fresh connect for the same
 * service replaces any stale pending state rather than accumulating orphans.
 *
 * Scoped to `status IS NULL` (pending only): a `denied` row is a terminal
 * observation a still-polling client has not seen yet, so supersede must not
 * erase it — that would silently degrade the client's status read from
 * `denied` back to `pending` and send it polling to its own timeout. Denied
 * rows are cleaned up by the observing client's cancel (or expiry), not here.
 */
export function deleteOAuthStateByService(
  sql: EngineSql,
  service: string,
): void {
  sql`DELETE FROM oauth_state WHERE service = ${service} AND status IS NULL`;
}
