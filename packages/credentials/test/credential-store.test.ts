import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { importEncryptionKey } from "../src/crypto";
import {
  storeCredential,
  loadCredential,
  type CredentialRowStore,
} from "../src/credential-store";
import type { EncryptedPayload } from "../src/types";
import { makeStoredCredential } from "./helpers/seed-credential";

/**
 * In-memory stand-in for a `connected_services` row's credential column. The
 * row-backed store is injected, so the encrypt/store seam is exercised in
 * isolation without a DO — the same seam the DO drives in production.
 */
function makeRowStore(): { store: CredentialRowStore; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const store: CredentialRowStore = {
    read: (service) => rows.get(service) ?? null,
    write: (service, ciphertext) => {
      rows.set(service, ciphertext);
      return true;
    },
  };
  return { store, rows };
}

describe("credential store", () => {
  it("store/load round-trip", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const credential = makeStoredCredential();
    const { store } = makeRowStore();

    await storeCredential(store, encKey, "gmail", credential);
    const loaded = await loadCredential(store, encKey, "gmail");

    expect(loaded).toEqual(credential);
  });

  it("load returns null for a service with no credential", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const { store } = makeRowStore();

    const loaded = await loadCredential(store, encKey, "slack");

    expect(loaded).toBeNull();
  });

  it("stored value is opaque — does not contain plaintext token", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const credential = makeStoredCredential({
      access_token: "super-secret-token-12345",
    });
    const { store, rows } = makeRowStore();

    await storeCredential(store, encKey, "drive", credential);

    const raw = rows.get("drive");
    expect(raw).toBeDefined();

    const parsed = JSON.parse(raw!) as EncryptedPayload;
    expect(parsed).toHaveProperty("ct");
    expect(parsed).toHaveProperty("iv");
    expect(typeof parsed.ct).toBe("string");
    expect(typeof parsed.iv).toBe("string");

    // Neither token must appear anywhere in the stored value
    expect(raw).not.toContain("super-secret-token-12345");
    expect(raw).not.toContain("1//test-refresh-token");
  });
});
