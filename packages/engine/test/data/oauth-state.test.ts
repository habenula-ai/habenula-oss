import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as os from "../../src/data/helpers/oauth-state";
import type { EngineSql } from "../../src/data/helpers/types";
import type { UserAgent } from "../../src/agent/user-agent";
import type { OAuthStateData } from "../../src/oauth/types";

/**
 * Behavior tests for the oauth_state data helpers plus the single-use consume
 * semantics they compose into. Run against a real
 * DO's SQLite via runInDurableObject — no mocks. The consume tests go through
 * UserAgent.consumeOAuthState, since the read+delete transaction is owned by
 * the orchestrator, not the helpers.
 */
describe("oauth_state helpers", () => {
  /** ISO-8601 UTC, `offsetMs` from now — the representation the table stores. */
  const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

  const payload = (expiresAt: string): OAuthStateData => ({
    code_verifier: "verifier-1",
    code_challenge: "challenge-1",
    service: "gmail",
    auth_code: null,
    created_at: iso(),
    expires_at: expiresAt,
    status: null,
  });

  it("stores and reads back a state payload; absent key reads null", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const data = payload(iso(600_000));
      os.insertOAuthState(sql, "key-1", data);
      expect(os.readOAuthState(sql, "key-1")).toEqual(data);
      expect(os.readOAuthState(sql, "absent")).toBeNull();
    });
  });

  it("delete removes exactly the keyed row", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      os.insertOAuthState(sql, "key-1", payload(iso(600_000)));
      os.insertOAuthState(sql, "key-2", payload(iso(600_000)));
      os.deleteOAuthState(sql, "key-1");
      expect(os.readOAuthState(sql, "key-1")).toBeNull();
      expect(os.readOAuthState(sql, "key-2")).not.toBeNull();
    });
  });

  it("consume is single-use: first call returns the row, second finds nothing", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.storeOAuthState("key-1", payload(iso(600_000)));
      const first = agent.consumeOAuthState("key-1");
      expect(first?.code_verifier).toBe("verifier-1");
      expect(agent.consumeOAuthState("key-1")).toBeNull();
    });
  });

  it("consuming an expired state returns null AND cleans up the row", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      agent.storeOAuthState("key-1", payload(iso(-10_000)));
      expect(agent.consumeOAuthState("key-1")).toBeNull();
      // The expired-cleanup branch deleted the row, not just skipped it.
      expect(os.readOAuthState(sql, "key-1")).toBeNull();
    });
  });
});
