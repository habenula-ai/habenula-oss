import type { StoredCredential } from "@habenula-ai/credentials";

/**
 * A valid decrypted credential for tool-executor and capability tests. The
 * engine's `seed-credential` helper is the canonical one, but it is bound to
 * the engine's crypto and DO env, so this package keeps its own plain factory.
 * Defaults to a far-future expiry and read scopes; override per test — scopes
 * are what the capability gates read. Centralizes the shape so a
 * `StoredCredential` field change lands here, not across every inline literal.
 */
export function makeCredential(
  overrides: Partial<StoredCredential> = {},
): StoredCredential {
  return {
    access_token: "test-access-token",
    refresh_token: "1//test-refresh-token",
    expiry_unix: 4102444800, // 2100-01-01
    scopes: ["email.read", "https://www.googleapis.com/auth/gmail.readonly"],
    ...overrides,
  };
}
