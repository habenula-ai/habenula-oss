import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AuditListResponse } from "@habenula-ai/contracts";
import { bindDoSql } from "../helpers/do-sql";
import * as al from "../../src/data/helpers/audit-log";
import type { EngineSql } from "../../src/data/helpers/types";
import type { UserAgent } from "../../src/agent/user-agent";

describe("UserAgent", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("creates audit_log table on construction", async () => {
    const stub = getStub();

    const tables = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'
      `;
    });

    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("audit_log");
  });

  it("creates indexes on construction", async () => {
    const stub = getStub();

    const indexes = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'
        ORDER BY name
      `;
    });

    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_epoch");
    expect(names).toContain("idx_timestamp");
    expect(names).toContain("idx_service");
    expect(names).toContain("idx_decision");
  });

  it("inserts and queries an audit entry", async () => {
    const stub = getStub();

    const entry = {
      id: "test-entry-001",
      epoch_id: "2026-04-07",
      sequence_num: 0,
      prev_hash: "GENESIS",
      hash: "abc123",
      epoch_prev_hash: null,
      timestamp: "2026-04-07T12:00:00Z",
      user_id: "user-1",
      agent_id: "agent-1",
      session_id: "session-1",
      tool_name: "gmail_list",
      service: "gmail",
      verb: "list",
      noun: "messages",
      decision: "allow",
      parameters_metadata: '{"label":{"type":"string"}}',
      parameters_content: null,
      outcome: "success",
      error_message: null,
      latency_ms: 42,
      cost_usd: null,
    };

    const rows = await runInDurableObject(stub, (instance) => {
      instance.sql`
        INSERT INTO audit_log (
          id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
          timestamp, user_id, agent_id, session_id,
          tool_name, service, verb, noun,
          decision, parameters_metadata, parameters_content,
          outcome, error_message, latency_ms, cost_usd
        ) VALUES (
          ${entry.id}, ${entry.epoch_id}, ${entry.sequence_num},
          ${entry.prev_hash}, ${entry.hash}, ${entry.epoch_prev_hash},
          ${entry.timestamp}, ${entry.user_id}, ${entry.agent_id}, ${entry.session_id},
          ${entry.tool_name}, ${entry.service}, ${entry.verb}, ${entry.noun},
          ${entry.decision}, ${entry.parameters_metadata}, ${entry.parameters_content},
          ${entry.outcome}, ${entry.error_message}, ${entry.latency_ms}, ${entry.cost_usd}
        )
      `;

      return instance.sql<{
        id: string;
        epoch_id: string;
        sequence_num: number;
        service: string;
        verb: string;
        noun: string;
        decision: string;
        latency_ms: number;
      }>`SELECT * FROM audit_log WHERE id = ${entry.id}`;
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(entry.id);
    expect(row.epoch_id).toBe(entry.epoch_id);
    expect(row.sequence_num).toBe(entry.sequence_num);
    expect(row.service).toBe(entry.service);
    expect(row.verb).toBe(entry.verb);
    expect(row.noun).toBe(entry.noun);
    expect(row.decision).toBe(entry.decision);
    expect(row.latency_ms).toBe(entry.latency_ms);
  });

  it("persists data across separate DO calls", async () => {
    const id = env.USER_AGENT.idFromName("persistence-test");
    const stub = env.USER_AGENT.get(id);

    // First call: insert
    await runInDurableObject(stub, (instance) => {
      instance.sql`
        INSERT INTO audit_log (
          id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
          timestamp, user_id, agent_id, session_id,
          tool_name, service, verb, noun,
          decision, parameters_metadata, parameters_content,
          outcome, error_message, latency_ms, cost_usd
        ) VALUES (
          'persist-001', '2026-04-07', 0, 'GENESIS', 'hash-1', ${null},
          '2026-04-07T12:00:00Z', 'user-1', 'agent-1', 'session-1',
          'gmail_list', 'gmail', 'list', 'messages',
          'allow', '{}', ${null},
          'success', ${null}, 35, ${null}
        )
      `;
    });

    // Second call: query — proves SQLite persisted between calls
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ id: string }>`
        SELECT id FROM audit_log WHERE id = 'persist-001'
      `;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("persist-001");
  });

  it("migrate() ALTERs a status column onto an older oauth_state table, idempotently", async () => {
    // The guarded ALTER is dead under a normal test:
    // fresh isolated storage always CREATEs oauth_state WITH the column, so
    // the PRAGMA guard never fires. Seed the older shape by hand — drop
    // the table and recreate it without `status` — then run migrate() and
    // assert the repo's first additive-column migration works on the real DO
    // SQLite runtime (including `ALTER … ADD COLUMN … CHECK`).
    //
    // The seeded timestamps are TEXT on purpose. The timestamp-type migration
    // that runs just before the ALTER recreates any table still declaring them
    // INTEGER, which would hand this test a table that already has `status` and
    // silently retire the ALTER coverage. That path has its own test below.
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as {
        migrate(): void;
        ctx: { storage: DurableObjectStorage };
      };
      const sql = internals.ctx.storage.sql;
      sql.exec(`DROP TABLE oauth_state`);
      sql.exec(`
        CREATE TABLE oauth_state (
          state_key TEXT PRIMARY KEY,
          code_verifier TEXT NOT NULL,
          code_challenge TEXT NOT NULL,
          service TEXT NOT NULL,
          auth_code TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `);
      const columnsOf = () =>
        [...sql.exec(`PRAGMA table_info(oauth_state)`)].map((c) => c.name);
      expect(columnsOf()).not.toContain("status");

      internals.migrate();
      expect(columnsOf()).toContain("status");

      // Both a NULL and a stamped 'denied' round-trip through the CHECK.
      instance.sql`
        INSERT INTO oauth_state (state_key, code_verifier, code_challenge, service, auth_code, created_at, expires_at, status)
        VALUES ('k-null', 'v', 'c', 'mock_email', NULL, '2026-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z', NULL)
      `;
      instance.sql`
        INSERT INTO oauth_state (state_key, code_verifier, code_challenge, service, auth_code, created_at, expires_at, status)
        VALUES ('k-denied', 'v', 'c', 'mock_email', NULL, '2026-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z', 'denied')
      `;
      const stored = instance.sql<{ state_key: string; status: string | null }>`
        SELECT state_key, status FROM oauth_state ORDER BY state_key
      `;
      expect(stored).toEqual([
        { state_key: "k-denied", status: "denied" },
        { state_key: "k-null", status: null },
      ]);
      // A value outside the CHECK set is rejected on the ALTERed table too.
      expect(
        () => instance.sql`
          INSERT INTO oauth_state (state_key, code_verifier, code_challenge, service, auth_code, created_at, expires_at, status)
          VALUES ('k-bad', 'v', 'c', 'mock_email', NULL, '2026-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z', 'connected')
        `,
      ).toThrow();

      // Idempotent: the PRAGMA guard skips the ALTER on a re-run, and the
      // stamped rows survive.
      expect(() => internals.migrate()).not.toThrow();
      expect(columnsOf().filter((n) => n === "status")).toHaveLength(1);
    });
  });

  it("migrate() recreates an oauth_state whose timestamps are still INTEGER, idempotently", async () => {
    // The timestamp-type migration, unreachable in a normal test for the same
    // reason as the ALTER above: fresh storage always CREATEs the table with
    // TEXT timestamps. Seed the pre-change shape by hand, with a row in it, and
    // assert the recreate. Dropping the row is the intended behavior, not
    // collateral: every oauth_state row is an in-flight authorization with a
    // ~10-minute TTL, and a UNIX-seconds `expires_at` cannot be compared
    // against an ISO string, so carrying it forward would strand it unexpirable.
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as {
        migrate(): void;
        ctx: { storage: DurableObjectStorage };
      };
      const sql = internals.ctx.storage.sql;
      sql.exec(`DROP TABLE oauth_state`);
      sql.exec(`
        CREATE TABLE oauth_state (
          state_key TEXT PRIMARY KEY,
          code_verifier TEXT NOT NULL,
          code_challenge TEXT NOT NULL,
          service TEXT NOT NULL,
          auth_code TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT CHECK(status IN ('denied'))
        )
      `);
      sql.exec(
        `INSERT INTO oauth_state VALUES ('stale', 'v', 'c', 'mock_email', NULL, 0, 9999999999, NULL)`,
      );
      const typeOf = (column: string) =>
        [...sql.exec(`PRAGMA table_info(oauth_state)`)].find(
          (c) => c.name === column,
        )?.type;
      const rowCount = () =>
        [...sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM oauth_state`)][0]!
          .n;
      expect(typeOf("created_at")).toBe("INTEGER");
      expect(rowCount()).toBe(1);

      internals.migrate();
      expect(typeOf("created_at")).toBe("TEXT");
      expect(typeOf("expires_at")).toBe("TEXT");
      // Recreated from the registry DDL, so `status` and its CHECK come along.
      expect(
        [...sql.exec(`PRAGMA table_info(oauth_state)`)].map((c) => c.name),
      ).toContain("status");
      expect(rowCount()).toBe(0);

      // A fresh ISO-timestamped flow stores and reads back on the new table.
      const now = new Date();
      instance.storeOAuthState("fresh", {
        code_verifier: "v",
        code_challenge: "c",
        service: "mock_email",
        auth_code: null,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 600_000).toISOString(),
        status: null,
      });
      expect(instance.loadOAuthState("fresh")).not.toBeNull();

      // Idempotent: the type guard skips the recreate on a re-run, so the row
      // that was just stored survives.
      expect(() => internals.migrate()).not.toThrow();
      expect(typeOf("created_at")).toBe("TEXT");
      expect(instance.loadOAuthState("fresh")).not.toBeNull();
    });
  });
});

describe("UserAgent.listAuditEntries", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  function seed(
    sql: EngineSql,
    over: Partial<al.ReferencingAuditEntryParams> = {},
  ): al.AuditEntryResult {
    const params = {
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
      toolName: "email_list_messages",
      service: "email",
      verb: "list",
      noun: "inbox",
      decision: "allow" as const,
      parametersMetadata: { label: { type: "string" } },
      outcome: "success" as const,
      latencyMs: 12,
      epochId: "2026-07-01",
      timestamp: "2026-07-01T10:00:00.000Z",
      ...over,
    };
    // The type split routes a referent-carrying seed to the closer write, on
    // the observed basis so a seed never silently skips.
    return params.decisionEntryId !== undefined
      ? al.closeDecisionEntryInTxn(sql, params as al.ReferencingAuditEntryParams, "observed")
      : al.insertAuditEntryInTxn(sql, params as al.AuditEntryParams);
  }

  it("pages newest first across the epoch boundary — exact page size, round-trip cursor, no overlap or gap", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (let n = 0; n < 3; n++) seed(sql, { epochId: "2026-07-01" });
      for (let n = 0; n < 2; n++) seed(sql, { epochId: "2026-07-02" });

      const seen: Array<[string, number]> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: AuditListResponse = agent.listAuditEntries({ limit: 2, cursor });
        // Never more than the requested size — the +1 probe row must not leak.
        expect(res.entries.length).toBeLessThanOrEqual(2);
        seen.push(...res.entries.map((e) => [e.epochId, e.sequenceNum] as [string, number]));
        cursor = res.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual([
        ["2026-07-02", 1],
        ["2026-07-02", 0],
        ["2026-07-01", 2],
        ["2026-07-01", 1],
        ["2026-07-01", 0],
      ]);
    });
  });

  it("closes the cursor on an exact-limit final page — no phantom empty page", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (let n = 0; n < 3; n++) seed(sql);
      const res = agent.listAuditEntries({ limit: 3 });
      expect(res.entries).toHaveLength(3);
      expect(res.nextCursor).toBeNull();
    });
  });

  it("falls back to the first page on a malformed cursor — including a non-integer sequence half", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (let n = 0; n < 3; n++) seed(sql);
      const first = agent.listAuditEntries({ limit: 10 });
      // Undecodable base64; no separator; and three malformed sequence halves.
      // The sequence half must decode as a NUMBER: sequence_num has integer
      // affinity, so a string bound would coerce and silently return the
      // wrong page rather than failing safe.
      const bad = [
        "%%%not-base64%%%",
        btoa("nopipe"),
        btoa("2026-07-01|abc"),
        btoa("2026-07-01|-3"),
        btoa("2026-07-01|1.5"),
      ];
      for (const cursor of bad) {
        const res = agent.listAuditEntries({ limit: 10, cursor });
        expect(res.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
      }
    });
  });

  it("clamps limit — 0/negative floor at 1, oversize caps, non-finite defaults", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      for (let n = 0; n < 3; n++) seed(sql);
      expect(agent.listAuditEntries({ limit: 0 }).entries).toHaveLength(1);
      expect(agent.listAuditEntries({ limit: -5 }).entries).toHaveLength(1);
      expect(agent.listAuditEntries({ limit: 10_000 }).entries).toHaveLength(3);
      expect(agent.listAuditEntries({ limit: Number.NaN }).entries).toHaveLength(3);
    });
  });

  it("maps rows verbatim — snake to camel, null preserved distinctly from empty string", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const genesis = seed(sql, { costUsd: 5e-7 });
      const second = seed(sql, { errorMessage: "", decisionEntryId: genesis.id });

      const res = agent.listAuditEntries({ limit: 2 });
      const [newest, oldest] = res.entries;

      expect(oldest).toEqual({
        epochId: "2026-07-01",
        sequenceNum: 0,
        prevHash: "GENESIS",
        id: genesis.id,
        timestamp: "2026-07-01T10:00:00.000Z",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "session-1",
        origin: "human",
        service: "email",
        verb: "list",
        noun: "inbox",
        toolName: "email_list_messages",
        parametersMetadata: '{"label":{"type":"string"}}',
        decision: "allow",
        outcome: "success",
        errorMessage: null, // absent stays null, never ""
        decisionEntryId: null,
        latencyMs: 12,
        costUsd: 5e-7, // exact float, not a string
        hash: genesis.hash,
        epochPrevHash: null,
      });
      // An empty-string errorMessage stays "", never null — the two frame
      // identically inside the hash but are distinct on the wire.
      expect(newest?.id).toBe(second.id);
      expect(newest?.errorMessage).toBe("");
      expect(newest?.prevHash).toBe(genesis.hash);
      expect(newest?.decisionEntryId).toBe(genesis.id);
    });
  });
});
