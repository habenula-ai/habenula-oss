import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as al from "../../src/data/helpers/audit-log";
import { computeEntryHash, verifyChainRange } from "@habenula-ai/audit";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the audit_log data helpers.
 * Run against a real DO's SQLite via runInDurableObject — no
 * mocks. The wrapper-level chain tests (genesis, epoch rollover, tamper)
 * live in test/governance/write-audit-entry.test.ts and keep running through
 * UserAgent.writeAuditEntry; these cover what the fold added: the bare
 * in-transaction helper, the identity reads, and the hot-path SQL-identity
 * guarantee.
 */
describe("audit_log helpers", () => {
  const baseParams = (over: Partial<al.AuditEntryParams> = {}): al.AuditEntryParams => ({
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    toolName: "email_list_messages",
    service: "email",
    verb: "list",
    noun: "inbox",
    decision: "allow",
    parametersMetadata: {},
    outcome: "success",
    latencyMs: 0,
    epochId: "2026-07-02",
    timestamp: "2026-07-02T10:00:00.000Z",
    ...over,
  });

  it("chains sequential inserts: prev_hash links, sequence increments", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const first = al.insertAuditEntryInTxn(sql, baseParams());
      const second = al.insertAuditEntryInTxn(sql, baseParams());
      expect(first.sequenceNum).toBe(0);
      expect(second.sequenceNum).toBe(1);
      const rows = [
        ...sql<{ id: string; prev_hash: string; hash: string }>`
          SELECT id, prev_hash, hash FROM audit_log ORDER BY sequence_num ASC
        `,
      ];
      expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    });
  });

 it("clamps a derived epoch to the newest stored epoch — a regressed clock never reopens a sealed one", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      // Seed an entry in a FUTURE epoch — stands in for "the newest stored epoch
      // is ahead of the wall clock", the post-regression state a clock rollback
      // across UTC midnight produces.
      const sealed = al.insertAuditEntryInTxn(
        sql,
        baseParams({ epochId: "2099-01-01", timestamp: "2099-01-01T00:00:00.000Z" }),
      );
      // A write with NO explicit epoch derives today (< 2099). The clamp must
      // continue the 2099 epoch, not open an earlier one and fork the chain.
      const next = al.insertAuditEntryInTxn(
        sql,
        baseParams({ epochId: undefined, timestamp: "2026-07-24T00:00:00.000Z" }),
      );
      const [row] = [
        ...sql<{ epoch_id: string; sequence_num: number; prev_hash: string }>`
          SELECT epoch_id, sequence_num, prev_hash FROM audit_log WHERE id = ${next.id}
        `,
      ];
      expect(row!.epoch_id).toBe("2099-01-01"); // clamped forward, not today
      expect(row!.sequence_num).toBe(sealed.sequenceNum + 1); // appended, not a fresh genesis
      expect(row!.prev_hash).toBe(sealed.hash); // links onto the newest epoch's tail
    });
  });

  it("hot-path read-prev issues SQL text identical to the pre-fold string", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const real = bindDoSql(instance as unknown as { sql: EngineSql });
      const issued: string[] = [];
      // Recording shim: capture each statement's placeholder-form text, then
      // delegate to the real bound tagged template unchanged.
      const recording = ((
        strings: TemplateStringsArray,
        ...values: (string | number | boolean | null)[]
      ) => {
        issued.push(strings.join("?"));
        return real(strings, ...values);
      }) as EngineSql;

      al.insertAuditEntryInTxn(recording, baseParams());

      // The exact exec() string governance/write-audit-entry.ts issued before
      // the fold — the every-tool-call hot path.
      expect(issued).toContain(
        "SELECT hash, sequence_num FROM audit_log WHERE epoch_id = ? ORDER BY sequence_num DESC LIMIT 1",
      );
      expect(issued).toContain(
        "SELECT hash FROM audit_log ORDER BY epoch_id DESC, sequence_num DESC LIMIT 1",
      );
    });
  });

  it("stored hash matches an independent recompute; tampering breaks the match", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const written = al.insertAuditEntryInTxn(sql, baseParams());
      const row = [
        ...sql<Record<string, string | number | null>>`
          SELECT * FROM audit_log WHERE id = ${written.id}
        `,
      ][0]!;
      const recompute = () =>
        computeEntryHash({
          epochId: row.epoch_id as string,
          sequenceNum: row.sequence_num as number,
          prevHash: row.prev_hash as string,
          id: row.id as string,
          timestamp: row.timestamp as string,
          userId: row.user_id as string,
          agentId: row.agent_id as string,
          sessionId: row.session_id as string,
          origin: row.origin as string,
          service: row.service as string,
          verb: row.verb as string,
          noun: row.noun as string,
          toolName: row.tool_name as string,
          parametersMetadata: row.parameters_metadata as string,
          decision: row.decision as string,
          outcome: row.outcome as string,
          errorMessage: row.error_message as string | null,
          decisionEntryId: row.decision_entry_id as string | null,
          latencyMs: row.latency_ms as number,
          costUsd: row.cost_usd as number | null,
        });
      expect(recompute()).toBe(row.hash);
      row.verb = "delete"; // tamper
      expect(recompute()).not.toBe(row.hash);
    });
  });

 it("folds error_message, session_id, and user_id into the hash; tampering any breaks the match", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const written = al.insertAuditEntryInTxn(
        sql,
        baseParams({ decision: "deny", outcome: "error", errorMessage: "Denied by user" }),
      );
      const row = [
        ...sql<Record<string, string | number | null>>`
          SELECT * FROM audit_log WHERE id = ${written.id}
        `,
      ][0]!;
      const recompute = () =>
        computeEntryHash({
          epochId: row.epoch_id as string,
          sequenceNum: row.sequence_num as number,
          prevHash: row.prev_hash as string,
          id: row.id as string,
          timestamp: row.timestamp as string,
          userId: row.user_id as string,
          agentId: row.agent_id as string,
          sessionId: row.session_id as string,
          origin: row.origin as string,
          service: row.service as string,
          verb: row.verb as string,
          noun: row.noun as string,
          toolName: row.tool_name as string,
          parametersMetadata: row.parameters_metadata as string,
          decision: row.decision as string,
          outcome: row.outcome as string,
          errorMessage: row.error_message as string | null,
          decisionEntryId: row.decision_entry_id as string | null,
          latencyMs: row.latency_ms as number,
          costUsd: row.cost_usd as number | null,
        });
      expect(recompute()).toBe(row.hash);

      // Rewrite the deny reason — the field an incident review reads.
      row.error_message = "Approved by user";
      expect(recompute()).not.toBe(row.hash);
      row.error_message = "Denied by user"; // restore

      // Reattribute the entry to a different session / user.
      row.session_id = "session-2";
      expect(recompute()).not.toBe(row.hash);
      row.session_id = "session-1"; // restore

      row.user_id = "user-2";
      expect(recompute()).not.toBe(row.hash);
    });
  });

  it("closeDecisionEntryInTxn sets the column; the hash matches the pre-split input for the same fields", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const decision = al.insertAuditEntryInTxn(
        sql,
        baseParams({ decision: "pending", timestamp: "2026-07-02T10:01:00.000Z" }),
      );
      const closer = al.closeDecisionEntryInTxn(
        sql,
        {
          ...baseParams({ timestamp: "2026-07-02T10:02:00.000Z" }),
          decisionEntryId: decision.id,
        },
        "observed",
      );
      const row = [
        ...sql<Record<string, string | number | null>>`
          SELECT * FROM audit_log WHERE id = ${closer.id}
        `,
      ][0]!;
      expect(row.decision_entry_id).toBe(decision.id);
      // The shared private row-writer hands computeEntryHash the same input
      // shape the pre-split write did, so the stored hash must match an
      // independent recompute that frames the referent — byte-identical.
      expect(
        computeEntryHash({
          epochId: row.epoch_id as string,
          sequenceNum: row.sequence_num as number,
          prevHash: row.prev_hash as string,
          id: row.id as string,
          timestamp: row.timestamp as string,
          userId: row.user_id as string,
          agentId: row.agent_id as string,
          sessionId: row.session_id as string,
          origin: row.origin as string,
          service: row.service as string,
          verb: row.verb as string,
          noun: row.noun as string,
          toolName: row.tool_name as string,
          parametersMetadata: row.parameters_metadata as string,
          decision: row.decision as string,
          outcome: row.outcome as string,
          errorMessage: row.error_message as string | null,
          decisionEntryId: row.decision_entry_id as string | null,
          latencyMs: row.latency_ms as number,
          costUsd: row.cost_usd as number | null,
        }),
      ).toBe(row.hash);
    });
  });

  it("insertAuditEntryInTxn always writes NULL in decision_entry_id", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const written = al.insertAuditEntryInTxn(sql, baseParams());
      const [row] = [
        ...sql<{ decision_entry_id: string | null }>`
          SELECT decision_entry_id FROM audit_log WHERE id = ${written.id}
        `,
      ];
      expect(row!.decision_entry_id).toBeNull();
    });
  });

  it("hasCloserInTxn answers by the referent column alone", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const decision = al.insertAuditEntryInTxn(sql, baseParams({ decision: "pending" }));
      expect(al.hasCloserInTxn(sql, decision.id)).toBe(false);
      al.closeDecisionEntryInTxn(
        sql,
        { ...baseParams(), decisionEntryId: decision.id },
        "observed",
      );
      expect(al.hasCloserInTxn(sql, decision.id)).toBe(true);
    });
  });

  it("the write rule is asymmetric on the basis: inferred skips a closed decision, observed never does", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const closersOf = (id: string) => [
        ...sql<{ decision: string; outcome: string }>`
          SELECT decision, outcome FROM audit_log
          WHERE decision_entry_id = ${id} ORDER BY sequence_num ASC
        `,
      ];

      // An open decision: the inferred writer is the only one who can speak,
      // so it writes its deduced disposition.
      const open = al.insertAuditEntryInTxn(sql, baseParams({ decision: "pending" }));
      expect(
        al.closeDecisionEntryInTxn(
          sql,
          {
            ...baseParams({ decision: "deny", outcome: "timeout" }),
            decisionEntryId: open.id,
          },
          "inferred",
        ),
      ).not.toBeNull();
      expect(closersOf(open.id)).toEqual([{ decision: "deny", outcome: "timeout" }]);

      // A closed decision: the truth is already recorded, so the inferred
      // writer skips rather than contradicting it.
      const closed = al.insertAuditEntryInTxn(sql, baseParams({ decision: "pending" }));
      al.closeDecisionEntryInTxn(
        sql,
        { ...baseParams({ decision: "allow", outcome: "success" }), decisionEntryId: closed.id },
        "observed",
      );
      expect(
        al.closeDecisionEntryInTxn(
          sql,
          {
            ...baseParams({ decision: "deny", outcome: "timeout" }),
            decisionEntryId: closed.id,
          },
          "inferred",
        ),
      ).toBeNull();
      expect(closersOf(closed.id)).toEqual([{ decision: "allow", outcome: "success" }]);

      // The observed writer holds a fact nothing else can supply, so it lands
      // on top of the fabrication as a correction and the log keeps both.
      expect(
        al.closeDecisionEntryInTxn(
          sql,
          {
            ...baseParams({ decision: "allow", outcome: "error" }),
            decisionEntryId: open.id,
          },
          "observed",
        ),
      ).not.toBeNull();
      expect(closersOf(open.id)).toEqual([
        { decision: "deny", outcome: "timeout" },
        { decision: "allow", outcome: "error" },
      ]);
    });
  });

  it("identity reads recover entry scope and session.start identity", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const pending = al.insertAuditEntryInTxn(
        sql,
        baseParams({ decision: "pending", toolName: "email_send" }),
      );
      al.insertAuditEntryInTxn(
        sql,
        baseParams({ toolName: "session.start", service: "session", verb: "start", noun: "-" }),
      );
      expect(al.readAuditEntryIdentity(sql, pending.id)).toEqual({
        user_id: "user-1",
        agent_id: "agent-1",
        session_id: "session-1",
        tool_name: "email_send",
        service: "email",
        verb: "list",
        noun: "inbox",
        origin: "human",
      });
      expect(al.readAuditEntryIdentity(sql, "absent")).toBeNull();
      expect(al.readSessionStartIdentity(sql, "session-1")).toEqual({
        user_id: "user-1",
        agent_id: "agent-1",
        origin: "human",
      });
      expect(al.readSessionStartIdentity(sql, "other")).toBeNull();
    });
  });

 describe("selectAuditChainPage", () => {
    /** Seed two epochs (3 + 2 rows) through the real write path. */
    function seedTwoEpochs(sql: EngineSql) {
      for (let n = 0; n < 3; n++) {
        al.insertAuditEntryInTxn(
          sql,
          baseParams({ epochId: "2026-07-01", timestamp: `2026-07-01T10:0${n}:00.000Z` }),
        );
      }
      for (let n = 0; n < 2; n++) {
        al.insertAuditEntryInTxn(
          sql,
          baseParams({ epochId: "2026-07-02", timestamp: `2026-07-02T10:0${n}:00.000Z` }),
        );
      }
    }

    it("returns the chain's own total order, newest first", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        seedTwoEpochs(sql);
        const rows = al.selectAuditChainPage(sql, { limit: 10 });
        expect(rows.map((r) => [r.epoch_id, r.sequence_num])).toEqual([
          ["2026-07-02", 1],
          ["2026-07-02", 0],
          ["2026-07-01", 2],
          ["2026-07-01", 1],
          ["2026-07-01", 0],
        ]);
      });
    });

    it("keyset cursor pages across the epoch boundary with no overlap or gap", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        seedTwoEpochs(sql);
        // Page 1 ends ON the epoch-2 genesis, so page 2's keyset predicate
        // must step down into epoch 1 rather than repeat or skip a row.
        const first = al.selectAuditChainPage(sql, { limit: 2 });
        const last = first[first.length - 1]!;
        expect([last.epoch_id, last.sequence_num]).toEqual(["2026-07-02", 0]);
        const second = al.selectAuditChainPage(sql, {
          limit: 10,
          before: { epochId: last.epoch_id, sequenceNum: last.sequence_num },
        });
        expect(second.map((r) => [r.epoch_id, r.sequence_num])).toEqual([
          ["2026-07-01", 2],
          ["2026-07-01", 1],
          ["2026-07-01", 0],
        ]);
      });
    });

    it("never selects parameters_content, and ships every hashed column plus hash and epoch_prev_hash", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        al.insertAuditEntryInTxn(sql, baseParams());
        const rows = al.selectAuditChainPage(sql, { limit: 1 });
        const keys = Object.keys(rows[0]!);
        // The projection is the ONE gate keeping content off this wire
        // (respond() is log-and-pass): the column must not be selected at all.
        expect(keys).not.toContain("parameters_content");
        expect(keys.sort()).toEqual(
          [
            "id", "epoch_id", "sequence_num", "prev_hash", "hash",
            "epoch_prev_hash", "timestamp", "user_id", "agent_id",
            "session_id", "tool_name", "service", "verb", "noun", "decision",
            "parameters_metadata", "outcome", "error_message",
            "decision_entry_id", "latency_ms", "cost_usd", "origin",
          ].sort(),
        );
      });
    });
  });

  describe("well-formed hashed columns", () => {
    // An unpaired UTF-16 surrogate is a legal JS and JSON string with no UTF-8
    // encoding. Written raw, the column stores bytes that were never hashed
    // (measured here: `a\uD800b` reads back as five code points, where the
    // hash's UTF-8 conversion sees three) and the chain can never verify
    // again. `insertRow` conditions every string once, so the stored text is
    // the hashed text. See wellFormed in @habenula-ai/audit.
    const HIGH = "\ud800";
    const LOW = "\udc00";

    it("stores a surrogate-bearing tool name in the exact form the hash was taken over", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        const written = al.insertAuditEntryInTxn(sql, baseParams({ toolName: `a${HIGH}b` }));
        const row = [
          ...sql<{ tool_name: string; hash: string }>`
            SELECT tool_name, hash FROM audit_log WHERE id = ${written.id}
          `,
        ][0]!;

        // Read back byte-for-byte as what was hashed. Asserted as a literal,
        // not as `wellFormed(input)`: comparing the writer's output against
        // the same function the writer used would pass however wrong that
        // function became. One U+FFFD is the claim — a raw write leaves three.
        expect(row.tool_name).toBe("a�b");
        expect(row.hash).toBe(written.hash);
      });
    });

    it("keeps the chain verifying when every hostile string field carries a surrogate", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        // A clean row first, so a break would be located at the poisoned one
        // rather than at the range's own lower edge.
        al.insertAuditEntryInTxn(sql, baseParams());
        al.insertAuditEntryInTxn(
          sql,
          baseParams({
            toolName: `tool${HIGH}`,
            noun: `${LOW}inbox`,
            service: `svc${HIGH}${LOW}`,
            verb: `list${LOW}`,
            errorMessage: `not_connected${HIGH}`,
            outcome: "error",
            decision: "deny",
            parametersMetadata: { label: `INBOX${HIGH}` },
            timestamp: "2026-07-02T10:05:00.000Z",
          }),
        );
        al.insertAuditEntryInTxn(sql, baseParams({ timestamp: "2026-07-02T10:06:00.000Z" }));

        const verdict = verifyChainRange([...instance.listAuditEntries({ limit: 10 }).entries].reverse());
        expect(verdict.entriesChecked).toBe(3);
        expect(verdict.breaks).toEqual([]);
      });
    });

    it("carries the conditioning through a closer, which is written by the same row-writer", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        const decision = al.insertAuditEntryInTxn(
          sql,
          baseParams({ decision: "pending", toolName: `held${HIGH}` }),
        );
        al.closeDecisionEntryInTxn(
          sql,
          {
            ...baseParams({
              toolName: `held${HIGH}`,
              outcome: "error",
              errorMessage: `denied${LOW}`,
              timestamp: "2026-07-02T10:07:00.000Z",
            }),
            decisionEntryId: decision.id,
          },
          "observed",
        );
        const verdict = verifyChainRange([...instance.listAuditEntries({ limit: 10 }).entries].reverse());
        expect(verdict.entriesChecked).toBe(2);
        expect(verdict.breaks).toEqual([]);
      });
    });

    it("returns identifiers that find the row that was written", async () => {
      const stub = getUserAgentStub();
      await runInDurableObject(stub, (instance) => {
        const sql = bindDoSql(instance as unknown as { sql: EngineSql });
        // A surrogate in the caller-supplied epoch id: the read-prev query, the
        // stored column, and the returned handle must all agree on one key, or
        // the next write starts a second epoch under the other spelling.
        const first = al.insertAuditEntryInTxn(sql, baseParams({ epochId: `2026-07-03${HIGH}` }));
        const second = al.insertAuditEntryInTxn(sql, baseParams({ epochId: `2026-07-03${HIGH}` }));
        expect(first.sequenceNum).toBe(0);
        expect(second.sequenceNum).toBe(1);
        expect(al.readAuditEntryIdentity(sql, second.id)).not.toBeNull();

        // Counted, not compared: an assertion that printed either spelling
        // would put an unpaired surrogate in the failure diff, and the test
        // reporter cannot serialize one — the regression would arrive as a
        // transport error instead of a readable diff.
        const epochs = [...sql<{ n: number }>`SELECT COUNT(DISTINCT epoch_id) AS n FROM audit_log`];
        expect(epochs[0]!.n).toBe(1);
        expect(first.epochId).toBe(second.epochId);
      });
    });
  });
});
