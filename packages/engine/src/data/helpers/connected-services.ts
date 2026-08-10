// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `connected_services` table. Each takes the bound
 * `EngineSql` and carries the exact SQL and semantics from the former inline
 * `UserAgent` methods — no behavior change, just a typed, single-source layer
 * over the generated `ConnectedServicesRow`.
 *
 * SELECT-list rule: a full-row helper selects every column of its row type;
 * a helper that needs a subset declares a narrowed `Pick<…>` return type rather
 * than asserting the wide row type over a short column list.
 */
import type { EngineSql } from "./types";
import type { ConnectedServicesRow } from "../schemas/connected-services";

/** List all connected services, oldest connection first. */
export function listConnectedServices(
  sql: EngineSql,
): Pick<ConnectedServicesRow, "service" | "connected_at">[] {
  return [
    ...sql<Pick<ConnectedServicesRow, "service" | "connected_at">>`
      SELECT service, connected_at FROM connected_services ORDER BY connected_at
    `,
  ];
}

/**
 * Connected services with credential *presence* only — the visual model
 * snapshot's read. The projection is the sanitization: the
 * SELECT list carries `credential IS NOT NULL`, never the column itself, so
 * ciphertext cannot reach the caller (Hard Invariant #1). SQLite reports the
 * boolean expression as 0/1; the caller maps it.
 */
export function listConnectedServicesWithCredentialPresence(
  sql: EngineSql,
): (Pick<ConnectedServicesRow, "service" | "connected_at"> & {
  has_credential: number;
})[] {
  return [
    ...sql<
      Pick<ConnectedServicesRow, "service" | "connected_at"> & {
        has_credential: number;
      }
    >`
      SELECT service, connected_at, (credential IS NOT NULL) AS has_credential
      FROM connected_services ORDER BY connected_at
    `,
  ];
}

/**
 * Upsert a service connection. On reconnect a supplied credential replaces the
 * stored one (a refresh) and `connected_at` keeps its first-connect value, so
 * the order `listConnectedServices` returns is undisturbed.
 */
export function connectService(
  sql: EngineSql,
  service: string,
  credential?: string,
): void {
  sql`
    INSERT INTO connected_services (service, connected_at, credential)
    VALUES (${service}, ${new Date().toISOString()}, ${credential ?? null})
    ON CONFLICT(service) DO UPDATE SET credential = excluded.credential
  `;
}

/**
 * Disconnect a service. Deleting the row removes its `credential` column in the
 * same operation, so disconnect can never leave a credential behind. Returns
 * whether a row actually matched: `RETURNING service` yields a row only when
 * one existed, so a typo or a never-connected name reports `false` rather than
 * a false success.
 */
export function disconnectService(sql: EngineSql, service: string): boolean {
  const rows = [
    ...sql<Pick<ConnectedServicesRow, "service">>`
      DELETE FROM connected_services WHERE service = ${service}
      RETURNING service
    `,
  ];
  return rows.length > 0;
}

/** Whether a service currently has a row. */
export function isServiceConnected(sql: EngineSql, service: string): boolean {
  const rows = [
    ...sql<Pick<ConnectedServicesRow, "service">>`
      SELECT service FROM connected_services WHERE service = ${service} LIMIT 1
    `,
  ];
  return rows.length > 0;
}

/** Read the opaque stored credential ciphertext for a service, or null. */
export function readCredential(
  sql: EngineSql,
  service: string,
): string | null {
  const rows = [
    ...sql<Pick<ConnectedServicesRow, "credential">>`
      SELECT credential FROM connected_services WHERE service = ${service} LIMIT 1
    `,
  ];
  return rows[0]?.credential ?? null;
}

/**
 * Write ciphertext back to an existing service row. Returns whether a row
 * matched (via `RETURNING service`), so the caller can reject a stale write.
 *
 * With `expectedCiphertext`, the UPDATE is a **compare-and-swap**: it also keys
 * on `credential = expectedCiphertext`, so it matches nothing when the row was
 * deleted (a concurrent `disconnectService`) OR when `connectService` replaced
 * the credential (a reconnect / re-consent) during the refresh's network await.
 * That stops a token minted from a pre-reconnect grant from clobbering the
 * just-reconnected credential. Without it, the UPDATE is an unconditional
 * overwrite of the named row.
 */
export function writeCredential(
  sql: EngineSql,
  service: string,
  ciphertext: string,
  expectedCiphertext?: string,
): boolean {
  const rows =
    expectedCiphertext === undefined
      ? [
          ...sql<Pick<ConnectedServicesRow, "service">>`
            UPDATE connected_services SET credential = ${ciphertext}
            WHERE service = ${service}
            RETURNING service
          `,
        ]
      : [
          ...sql<Pick<ConnectedServicesRow, "service">>`
            UPDATE connected_services SET credential = ${ciphertext}
            WHERE service = ${service} AND credential = ${expectedCiphertext}
            RETURNING service
          `,
        ];
  return rows.length > 0;
}
