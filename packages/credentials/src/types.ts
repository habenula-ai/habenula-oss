// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A decrypted OAuth credential as tool executors and provider strategies
 * consume it. The OAuth provider strategies in `@habenula-ai/tools` mint and
 * refresh this shape; executors receive it through `ExecuteContext` and never
 * see ciphertext or the encryption key. Encryption at rest is this package's
 * concern too (`EncryptedPayload` + `crypto.ts`), but the two shapes are
 * distinct: `StoredCredential` is the plaintext, `EncryptedPayload` the
 * envelope that lives on the `connected_services` row.
 */
export interface StoredCredential {
  access_token: string;
  refresh_token: string;
  expiry_unix: number;
  scopes: string[];
}

/**
 * The AES-256-GCM ciphertext envelope stored on a service's
 * `connected_services` row. Both fields are hex-encoded; the engine's Durable
 * Object persists the JSON of this shape and never the plaintext credential.
 */
export interface EncryptedPayload {
  /** Hex-encoded ciphertext */
  ct: string;
  /** Hex-encoded 12-byte IV */
  iv: string;
}
