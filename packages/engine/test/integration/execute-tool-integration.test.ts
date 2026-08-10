import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import type { MockEmailListResult } from "@habenula-ai/tools/services/mock/mock-email";

describe("executeTool integration", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  const baseParams = {
    toolName: "mock_email_list",
    toolParams: { label: "INBOX" },
    userId: "user-1",
    agentId: "agent-1",
    epochId: "2026-04-07",
    timestamp: "2026-04-07T12:00:00Z",
  };

  it("session grant → governance allows → mock tool executes → returns message data + audit entry", async () => {
    const stub = getStub();

    // Store mock credential on the row + connect the mock_email service
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId: baseParams.userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool(baseParams);
    });

    // Governance result
    expect(result.governance.decision).toBe("allow");
    expect(result.governance.service).toBe("mock_email");
    expect(result.governance.verb).toBe("list");
    expect(result.governance.noun).toBe("INBOX");

    // Execution result
    expect(result.execution).toBeDefined();
    expect(result.execution!.success).toBe(true);
    const data = result.execution!.data as MockEmailListResult;
    expect(data.messages.length).toBeGreaterThan(0);
    expect(data.messages[0]!.subject).toBeTruthy();
    expect(data.messages[0]!.sender).toBeTruthy();
    expect(data.messages[0]!.timestamp).toBeTruthy();

    // Decision entry records governance decision; outcome entry records execution result
    const auditRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        decision: string;
        outcome: string;
        service: string;
        verb: string;
        noun: string;
      }>`SELECT decision, outcome, service, verb, noun FROM audit_log WHERE id = ${result.governance.auditEntry.id}`;
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.decision).toBe("allow");
    expect(auditRows[0]!.outcome).toBe("success");
    expect(auditRows[0]!.service).toBe("mock_email");
    expect(auditRows[0]!.verb).toBe("list");
    expect(auditRows[0]!.noun).toBe("INBOX");

    // Outcome entry in hash chain — references the decision entry
    const outcomeRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        outcome: string;
        decision_entry_id: string;
      }>`SELECT outcome, decision_entry_id FROM audit_log WHERE decision_entry_id = ${result.governance.auditEntry.id}`;
    });

    expect(outcomeRows).toHaveLength(1);
    expect(outcomeRows[0]!.outcome).toBe("success");
    expect(outcomeRows[0]!.decision_entry_id).toBe(result.governance.auditEntry.id);
  });

  it("no grant → call held as pending → tool NOT executed → execution is undefined", async () => {
    const stub = getStub();

    // Connect the service so we test the grant gap, not the connection deny.
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool(baseParams);
    });

    // Confirmation flow: an un-granted connected action is parked
    // to ask the user, not hard-denied. No dispatch.
    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(result.held?.heldCallId).toBeTruthy();

    // Audit records the `pending` decision (audit-before-hold).
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        decision: string;
        outcome: string;
        error_message: string | null;
      }>`SELECT decision, outcome, error_message FROM audit_log WHERE id = ${result.governance.auditEntry.id}`;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("pending");
    // pending is not a failure outcome.
    expect(rows[0]!.outcome).toBe("success");

    // No outcome entry yet — the call is held, not resolved.
    const outcomeRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ id: string }>`
        SELECT id FROM audit_log WHERE decision_entry_id = ${result.governance.auditEntry.id}
      `;
    });
    expect(outcomeRows).toHaveLength(0);
  });

  it("off-menu / unknown tool → service 'unknown' → denied before execution, audit entry written first", async () => {
    const stub = getStub();

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        ...baseParams,
        toolName: "nonexistent_tool",
        toolParams: {},
      });
    });

    // lookupTool null ⇒ service "unknown" ⇒ isServiceConnected false ⇒ deny.
    expect(result.governance.decision).toBe("deny");
    expect(result.governance.service).toBe("unknown");
    // Never dispatched.
    expect(result.execution).toBeUndefined();

    // The decision audit entry exists (written before any dispatch), and there
    // is no outcome entry referencing it — nothing executed.
    const decisionRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ decision: string; outcome: string }>`
        SELECT decision, outcome FROM audit_log WHERE id = ${result.governance.auditEntry.id}
      `;
    });
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]!.decision).toBe("deny");

    const outcomeRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ id: string }>`
        SELECT id FROM audit_log WHERE decision_entry_id = ${result.governance.auditEntry.id}
      `;
    });
    expect(outcomeRows).toHaveLength(0);
  });

  it("audit log records correct service, verb, and noun matching label param", async () => {
    const stub = getStub();

    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId: baseParams.userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("mock_email", "list", "SENT", sessionId);
    });

    // Test with SENT label
    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        ...baseParams,
        toolParams: { label: "SENT" },
      });
    });

    expect(result.governance.service).toBe("mock_email");
    expect(result.governance.verb).toBe("list");
    expect(result.governance.noun).toBe("SENT");

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        service: string;
        verb: string;
        noun: string;
      }>`SELECT service, verb, noun FROM audit_log WHERE id = ${result.governance.auditEntry.id}`;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.service).toBe("mock_email");
    expect(rows[0]!.verb).toBe("list");
    expect(rows[0]!.noun).toBe("SENT");
  });
});
