// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential, EncryptedPayload } from "./types.js";

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function assertStoredCredential(
  value: unknown,
): asserts value is StoredCredential {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).access_token !== "string" ||
    // An empty access_token is never a usable credential — a provider mapping
    // that read the wrong response field (e.g. Slack's top-level token slot,
    // which is "" with no bot scope) must fail loud at decrypt, not as a
    // silent 401 at the first API call. The guard stops at access_token:
    // Google legitimately stores refresh_token: "" (google/provider.ts).
    (value as Record<string, unknown>).access_token === "" ||
    typeof (value as Record<string, unknown>).refresh_token !== "string" ||
    typeof (value as Record<string, unknown>).expiry_unix !== "number" ||
    !Array.isArray((value as Record<string, unknown>).scopes)
  ) {
    throw new Error("Decrypted payload is not a valid StoredCredential");
  }
}

/**
 * Import a 256-bit hex key for AES-256-GCM.
 * Throws if key is not exactly 64 hex characters.
 */
export async function importEncryptionKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 64) {
    throw new Error(
      `Encryption key must be exactly 64 hex characters, got ${hexKey.length}`,
    );
  }
  if (!/^[0-9a-f]+$/i.test(hexKey)) {
    throw new Error("Encryption key must contain only hex characters (0-9a-f)");
  }

  const raw = fromHex(hexKey);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a credential. Each call generates a unique random 12-byte IV.
 */
export async function encryptCredential(
  key: CryptoKey,
  credential: StoredCredential,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(credential));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    data,
  );

  return {
    ct: toHex(ciphertext),
    iv: toHex(iv),
  };
}

/**
 * Decrypt a credential. Throws on wrong key or tampered ciphertext.
 */
export async function decryptCredential(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<StoredCredential> {
  const iv = fromHex(payload.iv);
  const ciphertext = fromHex(payload.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    ciphertext,
  );

  const json: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  assertStoredCredential(json);
  return json;
}
