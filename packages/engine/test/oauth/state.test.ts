import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { OAuthStateData } from "../../src/oauth/types";

/** ISO-8601 UTC, `offsetMs` from now — the representation `oauth_state` stores. */
function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeState(overrides?: Partial<OAuthStateData>): OAuthStateData {
  return {
    code_verifier: "test-verifier-abc123",
    code_challenge: "test-challenge-abc123",
    service: "mock_email",
    auth_code: "mock_authcode_abc123",
    created_at: iso(),
    expires_at: iso(600_000),
    status: null,
    ...overrides,
  };
}

describe("OAuth state (DO-backed)", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("store + loadOAuthState round-trip", async () => {
    const stub = getStub();
    const state = makeState();

    await runInDurableObject(stub, (instance) => {
      instance.storeOAuthState("test-key", state);
    });

    const loaded = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState("test-key");
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.code_verifier).toBe("test-verifier-abc123");
    expect(loaded!.service).toBe("mock_email");
    expect(loaded!.auth_code).toBe("mock_authcode_abc123");
  });

  it("loadOAuthState does not consume the state", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.storeOAuthState("persist-key", makeState());
    });

    const first = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState("persist-key");
    });
    const second = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState("persist-key");
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.code_verifier).toBe(second!.code_verifier);
  });

  it("consumeOAuthState returns data and deletes it atomically", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.storeOAuthState("consume-key", makeState());
    });

    const consumed = await runInDurableObject(stub, (instance) => {
      return instance.consumeOAuthState("consume-key");
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.code_verifier).toBe("test-verifier-abc123");

    // Second consume returns null — one-time use
    const second = await runInDurableObject(stub, (instance) => {
      return instance.consumeOAuthState("consume-key");
    });
    expect(second).toBeNull();
  });

  it("expired state returns null from loadOAuthState", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.storeOAuthState("expired-key", makeState({
        expires_at: iso(-1000),
      }));
    });

    const loaded = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState("expired-key");
    });
    expect(loaded).toBeNull();
  });

  it("expired state returns null from consumeOAuthState and is cleaned up", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.storeOAuthState("expired-consume", makeState({
        expires_at: iso(-1000),
      }));
    });

    const consumed = await runInDurableObject(stub, (instance) => {
      return instance.consumeOAuthState("expired-consume");
    });
    expect(consumed).toBeNull();

    // Verify it was deleted (not just skipped)
    const rows = await runInDurableObject(stub, (instance) => {
      return [...instance.sql<{ state_key: string }>`
        SELECT state_key FROM oauth_state WHERE state_key = ${"expired-consume"}
      `];
    });
    expect(rows).toHaveLength(0);
  });

  it("nonexistent key returns null", async () => {
    const stub = getStub();

    const loaded = await runInDurableObject(stub, (instance) => {
      return instance.loadOAuthState("does-not-exist");
    });
    expect(loaded).toBeNull();

    const consumed = await runInDurableObject(stub, (instance) => {
      return instance.consumeOAuthState("does-not-exist");
    });
    expect(consumed).toBeNull();
  });
});
