import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MONTHLY_LIMIT_CENTS,
  DEFAULT_SESSION_LIMIT_CENTS,
} from "@habenula-ai/governance";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as us from "../../src/data/helpers/user-settings";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the user_settings accessors —
 * the table's first. The load-bearing property is the fail-safe read: an
 * absent or malformed limit reads as the shipped default, so the cap exists
 * before any user touches a setting and a corrupt value can never widen the
 * ceiling to "none".
 */
describe("user_settings helpers", () => {
  it("get/set round-trips a key; upsert overwrites", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(us.getSetting(sql, "k")).toBeNull();
      us.setSetting(sql, "k", "v1");
      expect(us.getSetting(sql, "k")).toBe("v1");
      us.setSetting(sql, "k", "v2");
      expect(us.getSetting(sql, "k")).toBe("v2");
    });
  });

  it("absent limits read as the shipped defaults, flagged as defaults", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(us.readSpendLimitsCents(sql)).toEqual({
        monthLimitCents: DEFAULT_MONTHLY_LIMIT_CENTS,
        sessionLimitCents: DEFAULT_SESSION_LIMIT_CENTS,
        monthIsDefault: true,
        sessionIsDefault: true,
      });
    });
  });

  it("stored limits read back in cents, unflagged; the other window keeps its default", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      us.setSetting(sql, us.SPEND_LIMIT_MONTHLY_KEY, "7500");
      expect(us.readSpendLimitsCents(sql)).toEqual({
        monthLimitCents: 7500,
        sessionLimitCents: DEFAULT_SESSION_LIMIT_CENTS,
        monthIsDefault: false,
        sessionIsDefault: true,
      });
    });
  });

  it("a zero limit is a stored value, not a default — every spend would ask", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      us.setSetting(sql, us.SPEND_LIMIT_SESSION_KEY, "0");
      const read = us.readSpendLimitsCents(sql);
      expect(read.sessionLimitCents).toBe(0);
      expect(read.sessionIsDefault).toBe(false);
    });
  });

  it("malformed stored limits fall back to the default (fail-safe direction)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      // "9007199254740993" (2^53 + 1) is all digits, so it passes the regex
      // and exercises the isSafeInteger branch — the only input that reaches it.
      for (const bad of ["abc", "-5", "12.5", "1e5", "", "9007199254740993"]) {
        us.setSetting(sql, us.SPEND_LIMIT_MONTHLY_KEY, bad);
        const read = us.readSpendLimitsCents(sql);
        expect(read.monthLimitCents).toBe(DEFAULT_MONTHLY_LIMIT_CENTS);
        expect(read.monthIsDefault).toBe(true);
      }
    });
  });
});
