import { env } from "cloudflare:workers";
import { encryptCredential, importEncryptionKey } from "@habenula-ai/credentials";
import type { StoredCredential } from "@habenula-ai/credentials";

/**
 * Canonical StoredCredential fixture. Defaults describe a valid credential —
 * the far-future expiry never reads as expired, and the scopes satisfy both
 * the mock's and gmail's read-capability gates (Tool.requiredScopes)
 * so a seeded credential passes the scope
 * precondition on whichever service it lands on. Tests override only the
 * fields they assert on (an expired expiry_unix, a stripped scope set).
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

/**
 * Encrypt a credential into the opaque ciphertext that lives on a
 * `connected_services` row's `credential` column.
 *
 * Pass the result as the second argument to
 * `connectService(service, ciphertext)` on the SAME DO stub the credential
 * should belong to — the row-backed credential store resolves by `service`
 * within the DO, not by `userId`, so seeding and execution must share a stub.
 */
export async function encryptCredentialForRow(
  encryptionKey: string,
  credential: StoredCredential,
): Promise<string> {
  const encKey = await importEncryptionKey(encryptionKey);
  return JSON.stringify(await encryptCredential(encKey, credential));
}

/**
 * The full seeding composition governed-execution tests repeat: the canonical
 * fixture (with optional overrides) encrypted under the test environment's
 * CREDENTIAL_ENCRYPTION_KEY. Pass the result to
 * `connectService(service, ciphertext)` on the same DO stub the credential
 * should belong to (see encryptCredentialForRow).
 */
export function seedCiphertext(
  overrides?: Partial<StoredCredential>,
): Promise<string> {
  return encryptCredentialForRow(
    env.CREDENTIAL_ENCRYPTION_KEY,
    makeStoredCredential(overrides),
  );
}
