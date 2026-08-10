// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential, EncryptedPayload } from "./types.js";
import { encryptCredential, decryptCredential } from "./crypto.js";

/**
 * Row-backed credential store: reads and writes the opaque ciphertext on a
 * service's `connected_services` row. The DO builds one over its own SQLite
 * and hands it to the credential functions, so encrypt/decrypt stay here while
 * the storage target (a DO-SQLite column) is injected. Scoped to one user's
 * DO, so it carries no userId — `service` keys the row.
 */
export interface CredentialRowStore {
  /** The stored ciphertext for the service, or null if absent. */
  read(service: string): string | null;
  /**
   * Overwrite the service row's credential with the ciphertext. Returns `true`
   * if the write landed, `false` if it did not — the caller must not treat a
   * `false` write as a successful refresh.
   *
   * When `expectedCiphertext` is given, the write is a **compare-and-swap**: it
   * lands only if the row still holds exactly that ciphertext, and reports
   * `false` if the row is gone (disconnect) OR its ciphertext changed
   * (reconnect / re-consent replaced it while the refresh's network call was in
   * flight). This is what stops a refresh minted from a pre-reconnect grant from
   * clobbering a just-reconnected credential. With no `expectedCiphertext`
   * the write is an unconditional overwrite of an existing row.
   */
  write(service: string, ciphertext: string, expectedCiphertext?: string): boolean;
}

function assertEncryptedPayload(
  value: unknown,
): asserts value is EncryptedPayload {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).ct !== "string" ||
    typeof (value as Record<string, unknown>).iv !== "string"
  ) {
    throw new Error("Stored credential is not a valid EncryptedPayload");
  }
}

/**
 * Encrypt a credential and store it on the service's row. The encrypted payload
 * is the same AES-256-GCM `{ct, iv}` JSON the KV value held. Returns the
 * underlying `write` result: `false` when no row matched (the service was
 * disconnected between read and write), so the caller can reject the refresh.
 */
export async function storeCredential(
  store: CredentialRowStore,
  encKey: CryptoKey,
  service: string,
  credential: StoredCredential,
  expectedCiphertext?: string,
): Promise<boolean> {
  const payload = await encryptCredential(encKey, credential);
  return store.write(service, JSON.stringify(payload), expectedCiphertext);
}

/**
 * Load and decrypt a credential from the service's row. Returns null when the
 * column is empty (mirroring the missing-KV-key behavior it replaces).
 */
export async function loadCredential(
  store: CredentialRowStore,
  encKey: CryptoKey,
  service: string,
): Promise<StoredCredential | null> {
  const raw = store.read(service);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  assertEncryptedPayload(parsed);
  return decryptCredential(encKey, parsed);
}
