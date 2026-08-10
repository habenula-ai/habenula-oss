import { describe, it, expect } from "vitest";
import {
  importEncryptionKey,
  encryptCredential,
  decryptCredential,
} from "../src/crypto";
import { makeStoredCredential } from "./helpers/seed-credential";

const VALID_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ALT_KEY_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("importEncryptionKey", () => {
  it("succeeds with a valid 64-char hex key", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);
    expect(key).toBeDefined();
    expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });
  });

  it("throws on too-short key", async () => {
    await expect(importEncryptionKey("abcd")).rejects.toThrow(
      "Encryption key must be exactly 64 hex characters",
    );
  });

  it("throws on non-hex characters", async () => {
    const nonHex = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(nonHex).toHaveLength(64);
    await expect(importEncryptionKey(nonHex)).rejects.toThrow(
      "Encryption key must contain only hex characters",
    );
  });
});

describe("encryptCredential / decryptCredential", () => {
  it("round-trips a credential", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential();

    const encrypted = await encryptCredential(key, credential);
    const decrypted = await decryptCredential(key, encrypted);

    expect(decrypted).toEqual(credential);
  });

  it("generates unique IVs on each encryption", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential();

    const a = await encryptCredential(key, credential);
    const b = await encryptCredential(key, credential);

    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("throws when decrypting with the wrong key", async () => {
    const keyA = await importEncryptionKey(VALID_KEY_HEX);
    const keyB = await importEncryptionKey(ALT_KEY_HEX);
    const credential = makeStoredCredential();

    const encrypted = await encryptCredential(keyA, credential);

    await expect(decryptCredential(keyB, encrypted)).rejects.toThrow();
  });

  it("throws on tampered ciphertext", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential();

    const encrypted = await encryptCredential(key, credential);

    // Flip a character in the ciphertext
    const chars = encrypted.ct.split("");
    const idx = Math.floor(chars.length / 2);
    chars[idx] = chars[idx] === "a" ? "b" : "a";
    const tampered = { ...encrypted, ct: chars.join("") };

    await expect(decryptCredential(key, tampered)).rejects.toThrow();
  });

  it("throws on tampered IV", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential();

    const encrypted = await encryptCredential(key, credential);

    // Flip a character in the IV
    const chars = encrypted.iv.split("");
    chars[0] = chars[0] === "a" ? "b" : "a";
    const tampered = { ...encrypted, iv: chars.join("") };

    await expect(decryptCredential(key, tampered)).rejects.toThrow();
  });

  it("rejects a payload with an empty access_token", async () => {
    // The loud-failure guard for a provider mapping that stored the wrong
    // response field: "" passes a bare
    // typeof-string check but is never a usable credential.
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential({ access_token: "" });

    const encrypted = await encryptCredential(key, credential);

    await expect(decryptCredential(key, encrypted)).rejects.toThrow(
      "Decrypted payload is not a valid StoredCredential",
    );
  });

  it("still accepts an empty refresh_token (Google stores one)", async () => {
    // google/provider.ts stores refresh_token: "" when Google omits it; the
    // empty-token guard must not extend to refresh_token or it would brick
    // those credentials at first use.
    const key = await importEncryptionKey(VALID_KEY_HEX);
    const credential = makeStoredCredential({ refresh_token: "" });

    const encrypted = await encryptCredential(key, credential);
    const decrypted = await decryptCredential(key, encrypted);

    expect(decrypted).toEqual(credential);
  });

  it("rejects decrypted payload with wrong shape", async () => {
    const key = await importEncryptionKey(VALID_KEY_HEX);

    // Encrypt a valid-JSON object that is NOT a StoredCredential
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify({ foo: "bar" }));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      data,
    );

    // Convert to hex manually to build a valid EncryptedPayload
    const toHex = (buf: ArrayBuffer) => {
      const bytes = new Uint8Array(buf);
      let hex = "";
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, "0");
      }
      return hex;
    };

    const payload = { ct: toHex(ciphertext), iv: toHex(iv) };

    await expect(decryptCredential(key, payload)).rejects.toThrow(
      "Decrypted payload is not a valid StoredCredential",
    );
  });
});
