import { describe, it, expect } from "vitest";
import { generateCodeVerifier, generateCodeChallenge } from "../../src/oauth/pkce";

describe("PKCE", () => {
  describe("generateCodeVerifier", () => {
    it("returns a 43-character string", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toHaveLength(43);
    });

    it("contains only base64url characters", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces unique values on each call", () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe("generateCodeChallenge", () => {
    it("returns a 43-character base64url string", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toHaveLength(43);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is deterministic for the same verifier", async () => {
      const verifier = generateCodeVerifier();
      const a = await generateCodeChallenge(verifier);
      const b = await generateCodeChallenge(verifier);
      expect(a).toBe(b);
    });

    it("differs for different verifiers", async () => {
      const a = await generateCodeChallenge(generateCodeVerifier());
      const b = await generateCodeChallenge(generateCodeVerifier());
      expect(a).not.toBe(b);
    });

    it("matches independent SHA-256 computation", async () => {
      const verifier = "test-verifier-for-known-hash";
      const challenge = await generateCodeChallenge(verifier);

      // Compute independently
      const encoded = new TextEncoder().encode(verifier);
      const hash = await crypto.subtle.digest("SHA-256", encoded);
      const bytes = new Uint8Array(hash);
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const expected = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      expect(challenge).toBe(expected);
    });
  });
});
