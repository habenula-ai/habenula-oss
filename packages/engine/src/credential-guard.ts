// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fail-closed credential-key guard.
 *
 * The engine refuses to serve governed routes when CREDENTIAL_ENCRYPTION_KEY
 * is missing, malformed, or a publicly known placeholder, so real credentials
 * are never encrypted under a world-known key on any run path. Pure and
 * dependency-free by design: the Worker fetch guard (src/index.ts) and the
 * habenula-engine daemon pre-flight both consume it, so the refusal
 * message is byte-identical across every surface.
 */

/**
 * The documented dev/test placeholder keys — the former wrangler.toml [vars]
 * default (that [vars] entry is gone now, but the value is still in
 * circulation) and the second placeholder quoted in crypto tests and docs.
 * Both are allowlisted in the secret scanner as public non-secrets; that is
 * exactly why the engine must refuse to encrypt real credentials under them.
 */
export const KNOWN_PLACEHOLDER_KEYS: readonly string[] = [
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
];

const GENERATE_HINT = "Generate one with: openssl rand -hex 32";

/**
 * Validate a candidate CREDENTIAL_ENCRYPTION_KEY. Returns a human-readable
 * refusal message, or null when the key is acceptable. Format bounds match
 * importEncryptionKey (@habenula-ai/credentials): exactly 64 hex characters,
 * case-insensitive.
 */
export function validateCredentialKey(key: string | undefined): string | null {
  if (key === undefined || key === "") {
    return `CREDENTIAL_ENCRYPTION_KEY is not set. The engine refuses to handle credentials without an encryption key. ${GENERATE_HINT}`;
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    return `CREDENTIAL_ENCRYPTION_KEY must be exactly 64 hex characters (a 256-bit key). ${GENERATE_HINT}`;
  }
  if (KNOWN_PLACEHOLDER_KEYS.includes(key.toLowerCase())) {
    return `CREDENTIAL_ENCRYPTION_KEY is the publicly known dev placeholder. The engine refuses to encrypt real credentials under it. ${GENERATE_HINT}`;
  }
  return null;
}
