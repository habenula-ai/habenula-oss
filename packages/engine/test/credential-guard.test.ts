import type { HabenulaEnv } from "../src/env";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import {
  KNOWN_PLACEHOLDER_KEYS,
  validateCredentialKey,
} from "../src/credential-guard";

/**
 * The fail-closed credential-key guard. The suite
 * runs on a per-run generated key (vitest bindings injection), so the pass
 * path is covered by every other fetch test; this file drives the refusal
 * paths by overriding the env object passed to the fetch handler, and pins
 * the one deliberate exception — /api/health stays a credential-unaware
 * liveness probe.
 */

const [WRANGLER_PLACEHOLDER, DOCS_PLACEHOLDER] = KNOWN_PLACEHOLDER_KEYS as [
  string,
  string,
];

describe("validateCredentialKey", () => {
  it("refuses both known placeholder keys", () => {
    for (const key of KNOWN_PLACEHOLDER_KEYS) {
      const refusal = validateCredentialKey(key);
      expect(refusal, key).toContain("publicly known dev placeholder");
    }
  });

  it("refuses a placeholder regardless of hex case", () => {
    expect(validateCredentialKey(WRANGLER_PLACEHOLDER.toUpperCase())).toContain(
      "publicly known dev placeholder",
    );
  });

  it("refuses a missing or empty key", () => {
    expect(validateCredentialKey(undefined)).toContain("is not set");
    expect(validateCredentialKey("")).toContain("is not set");
  });

  it("refuses malformed keys (wrong length or non-hex)", () => {
    const valid = "a".repeat(64);
    for (const key of [
      valid.slice(1), // 63 chars
      `${valid}a`, // 65 chars
      `${valid.slice(2)}zz`, // non-hex characters
      "not-a-key",
    ]) {
      expect(validateCredentialKey(key), key).toContain(
        "exactly 64 hex characters",
      );
    }
  });

  it("accepts a well-formed non-placeholder key, either case", () => {
    expect(validateCredentialKey("9".repeat(32) + "a".repeat(32))).toBeNull();
    expect(validateCredentialKey("9".repeat(32) + "A".repeat(32))).toBeNull();
  });
});

async function fetchWith(
  path: string,
  key: string | undefined,
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, CREDENTIAL_ENCRYPTION_KEY: key } as HabenulaEnv;
  const response = await worker.fetch(
    new Request(`http://localhost${path}`),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("engine fetch guard", () => {
  it("governed routes 503 under a placeholder key, with the shared refusal message", async () => {
    for (const key of [WRANGLER_PLACEHOLDER, DOCS_PLACEHOLDER]) {
      const res = await fetchWith("/api/status", key);
      expect(res.status, key).toBe(503);
      const body = (await res.json()) as { error: string };
      // Byte-identical to the module's message — the same surface the daemon
      // pre-flight prints ("identical failure surface").
      expect(body.error).toBe(validateCredentialKey(key));
    }
  });

  it("governed routes 503 under a missing key", async () => {
    const res = await fetchWith("/api/status", undefined);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(validateCredentialKey(undefined));
  });

  it("/api/health stays 200 under a placeholder key — liveness is not credential-aware", async () => {
    const res = await fetchWith("/api/health", WRANGLER_PLACEHOLDER);
    expect(res.status).toBe(200);
  });

  it("a valid key passes the guard", async () => {
    const res = await fetchWith("/api/status", "9".repeat(32) + "a".repeat(32));
    expect(res.status).toBe(200);
  });
});
