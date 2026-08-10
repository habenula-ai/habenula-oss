// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of @habenula-ai/credentials. The engine imports from this
// barrel; @habenula-ai/tools imports the `StoredCredential` type its provider
// strategies mint. Integration tests that must mock a single module (e.g. the
// DO decrypt seam) reach it through the package's `./*` subpath export.

// The credential shapes.
export type { StoredCredential, EncryptedPayload } from "./types.js";

// AES-256-GCM encryption at rest (Web Crypto).
export {
  importEncryptionKey,
  encryptCredential,
  decryptCredential,
} from "./crypto.js";

// The row-backed store seam: encrypt/decrypt stay here, storage is injected.
export {
  storeCredential,
  loadCredential,
  type CredentialRowStore,
} from "./credential-store.js";

// Single-flight token refresh (refreshFn injected by the provider strategy).
export { SingleFlightRefresher, CredentialNotFoundError } from "./token-refresh.js";
