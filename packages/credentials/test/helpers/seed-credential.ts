import type { StoredCredential } from "../../src/types";

/**
 * Canonical StoredCredential fixture. Defaults describe a valid credential —
 * the far-future expiry never reads as expired, and the scopes satisfy the
 * read-capability gates a seeded credential is checked against. Tests override
 * only the fields they assert on (an expired expiry_unix, a stripped scope
 * set).
 *
 * This is the package-local copy used by the credential-vault unit tests. The
 * engine keeps its own richer copy (with DO-row seeding helpers) for the
 * integration suites that drive a Durable Object.
 */
export function makeStoredCredential(
  overrides?: Partial<StoredCredential>,
): StoredCredential {
  return {
    access_token: "ya29.test-access-token",
    refresh_token: "1//test-refresh-token",
    expiry_unix: 4102444800, // 2100-01-01
    scopes: ["email.read", "https://www.googleapis.com/auth/gmail.readonly"],
    ...overrides,
  };
}

/**
 * An expired credential. The refresh gate is not `expiry < now` — it is
 * SingleFlightRefresher's 60-second skew buffer (refresh unless
 * `expiry_unix > now + 60`), so anything at or below now + 60 triggers a
 * refresh. A full minute past expiry keeps the fixture unambiguously on the
 * refresh side of the buffer; use this rather than hand-rolling an offset
 * that might land inside it.
 */
export function makeExpiredCredential(
  overrides?: Partial<StoredCredential>,
): StoredCredential {
  return makeStoredCredential({
    expiry_unix: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  });
}
