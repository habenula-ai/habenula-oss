/**
 * Origin provenance through the audit chain: `origin` joins the hash input so provenance is
 * tamper-evident, defaults to 'human' everywhere, and — the sweep-side rule —
 * a commission-held call swept at session end closes with a terminal entry
 * carrying the swept ACTION's origin, so the pending/terminal pair can never
 * disagree about provenance inside the chain.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import type { UserAgent } from "../../src/agent/user-agent";
import { computeEntryHash, GENESIS_SENTINEL } from "@habenula-ai/audit";
import { insertSessionState } from "../../src/data/helpers/session-state";
import { insertHeldToolCall } from "../../src/data/helpers/held-tool-calls";
import { insertCommissionRun } from "../../src/data/helpers/commission-runs";

/** A started_at safely past the 90-minute cap. */
const EXPIRED_START = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

describe("audit origin provenance", () => {
  it("tampering with a stored origin breaks the hash chain", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);
      const written = agent.writeAuditEntry({
        userId: "u-1",
        agentId: "a-1",
        sessionId: "s-1",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "allow",
        origin: "mcp_commission",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      const [row] = [
        ...sql<{
          epoch_id: string;
          sequence_num: number;
          id: string;
          timestamp: string;
          origin: string;
          hash: string;
          parameters_metadata: string;
        }>`SELECT epoch_id, sequence_num, id, timestamp, origin, hash, parameters_metadata FROM audit_log WHERE id = ${written.id}`,
      ];
      expect(row!.origin).toBe("mcp_commission");

      const recompute = (origin: string) =>
        computeEntryHash({
          epochId: row!.epoch_id,
          sequenceNum: row!.sequence_num,
          prevHash: GENESIS_SENTINEL,
          id: row!.id,
          timestamp: row!.timestamp,
          userId: "u-1",
          agentId: "a-1",
          sessionId: "s-1",
          origin,
          service: "mock_email",
          verb: "list",
          noun: "INBOX",
          toolName: "mock_email_list",
          parametersMetadata: row!.parameters_metadata,
          decision: "allow",
          outcome: "success",
          errorMessage: null,
          decisionEntryId: null,
          latencyMs: 0,
          costUsd: null,
        });
      // honest recompute matches; a flipped origin does not — provenance is
      // inside the tamper-evident chain, not beside it.
      expect(recompute("mcp_commission")).toBe(row!.hash);
      expect(recompute("human")).not.toBe(row!.hash);
    });
  });

  it("a swept commission hold's terminal entry inherits mcp_commission", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);

      // An expired session holding a commission-origin parked call.
      insertSessionState(sql, "s-old", EXPIRED_START, "onboarding");
      insertCommissionRun(sql, {
        id: "run-1",
        goal: "g",
        data: null,
        sessionId: "s-old",
        createdAt: EXPIRED_START,
      });
      const pending = agent.writeAuditEntry({
        userId: "u-1",
        agentId: "a-1",
        sessionId: "s-old",
        toolName: "mock_email_list",
        service: "mock_email",
        verb: "list",
        noun: "INBOX",
        decision: "pending",
        origin: "mcp_commission",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });
      insertHeldToolCall(sql, "h-1", "s-old", pending.id, EXPIRED_START, "run-1");

      agent.reapExpiredSessions();

      const [terminal] = [
        ...sql<{ origin: string; outcome: string }>`
          SELECT origin, outcome FROM audit_log
          WHERE decision_entry_id = ${pending.id} LIMIT 1
        `,
      ];
      expect(terminal).toBeDefined();
      expect(terminal!.outcome).toBe("timeout");
      expect(terminal!.origin).toBe("mcp_commission");
    });
  });

  it("a commission session's session.end inherits mcp_commission (start/end origin symmetry)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const agent = instance as unknown as UserAgent;
      const sql = bindDoSql(instance as never);

      // A commission-established, now-expired session whose session.start
      // carries mcp_commission (createSessionInTxn stamps it from the run).
      insertSessionState(sql, "s-comm", EXPIRED_START, "onboarding");
      agent.writeAuditEntry({
        userId: "u-1",
        agentId: "a-1",
        sessionId: "s-comm",
        toolName: "session.start",
        service: "session",
        verb: "start",
        noun: "-",
        decision: "allow",
        origin: "mcp_commission",
        parametersMetadata: {},
        outcome: "success",
        latencyMs: 0,
      });

      agent.reapExpiredSessions();

      const [end] = [
        ...sql<{ origin: string }>`
          SELECT origin FROM audit_log
          WHERE session_id = ${"s-comm"} AND tool_name = 'session.end' LIMIT 1
        `,
      ];
      expect(end).toBeDefined();
      // Previously the end defaulted to 'human', breaking start/end symmetry —
      // an origin-filtered reconstruction saw the start but never the end.
      expect(end!.origin).toBe("mcp_commission");
    });
  });
});
