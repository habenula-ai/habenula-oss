import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as cs from "../../src/data/helpers/connected-services";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the connected_services data helpers.
 * They run the helpers against a real DO's SQLite via
 * runInDurableObject — no mocks — exercising CRUD, the credential upsert, and
 * the read/write-back credential path.
 */
describe("connected_services helpers", () => {

  // The bound `this.sql` tagged template, obtained the same way UserAgent binds
  // it, so helpers run exactly as they do in production.

  it("connects, lists, and reports connection state", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(cs.isServiceConnected(sql, "gmail")).toBe(false);
      cs.connectService(sql, "gmail", "cipher-1");
      cs.connectService(sql, "github");
      expect(cs.isServiceConnected(sql, "gmail")).toBe(true);
      const list = cs.listConnectedServices(sql);
      expect(list.map((r) => r.service).sort()).toEqual(["github", "gmail"]);
      expect(list.every((r) => typeof r.connected_at === "string")).toBe(true);
    });
  });

  it("reads back a stored credential; credential-less connect stores null", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      cs.connectService(sql, "gmail", "cipher-1");
      cs.connectService(sql, "none-svc");
      expect(cs.readCredential(sql, "gmail")).toBe("cipher-1");
      expect(cs.readCredential(sql, "none-svc")).toBeNull();
      expect(cs.readCredential(sql, "absent")).toBeNull();
    });
  });

  it("upsert refreshes the credential and preserves connected_at", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      cs.connectService(sql, "gmail", "cipher-1");
      const first = cs.listConnectedServices(sql).find((r) => r.service === "gmail");
      cs.connectService(sql, "gmail", "cipher-2");
      const again = cs.listConnectedServices(sql).find((r) => r.service === "gmail");
      // Only the credential changes; the first-connect timestamp is undisturbed
      // and no duplicate row is created.
      expect(cs.readCredential(sql, "gmail")).toBe("cipher-2");
      expect(again?.connected_at).toBe(first?.connected_at);
      expect(cs.listConnectedServices(sql)).toHaveLength(1);
    });
  });

  it("writeCredential reports whether the row still exists", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      cs.connectService(sql, "gmail", "cipher-1");
      expect(cs.writeCredential(sql, "gmail", "cipher-refreshed")).toBe(true);
      expect(cs.readCredential(sql, "gmail")).toBe("cipher-refreshed");
      // After disconnect the write matches no row (the stale-write guard).
      cs.disconnectService(sql, "gmail");
      expect(cs.writeCredential(sql, "gmail", "cipher-late")).toBe(false);
      expect(cs.isServiceConnected(sql, "gmail")).toBe(false);
    });
  });

 it("writeCredential compare-and-swap lands only on the expected ciphertext", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      cs.connectService(sql, "gmail", "cipher-1");
      // CAS with the ciphertext the refresh read → lands.
      expect(cs.writeCredential(sql, "gmail", "cipher-refreshed", "cipher-1")).toBe(true);
      expect(cs.readCredential(sql, "gmail")).toBe("cipher-refreshed");
      // A reconnect replaced the credential mid-refresh; a CAS keyed on the
      // pre-reconnect ciphertext matches no row and must NOT overwrite the new one.
      cs.connectService(sql, "gmail", "cipher-reconnected");
      expect(cs.writeCredential(sql, "gmail", "cipher-stale", "cipher-refreshed")).toBe(false);
      expect(cs.readCredential(sql, "gmail")).toBe("cipher-reconnected");
    });
  });

  it("disconnectService reports whether a row was actually removed", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      cs.connectService(sql, "gmail", "cipher-1");
      // A connected service is removed and reports true.
      expect(cs.disconnectService(sql, "gmail")).toBe(true);
      expect(cs.isServiceConnected(sql, "gmail")).toBe(false);
      // A second disconnect (now a no-op) and an unknown name both report false.
      expect(cs.disconnectService(sql, "gmail")).toBe(false);
      expect(cs.disconnectService(sql, "never-connected")).toBe(false);
    });
  });
});
