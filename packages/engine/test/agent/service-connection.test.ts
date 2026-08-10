import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";

describe("Service connection + policy + kill switch", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("service is not connected by default", async () => {
    const stub = getStub();
    const connected = await runInDurableObject(stub, (instance) => {
      return instance.isServiceConnected("mock_email");
    });
    expect(connected).toBe(false);
  });

  it("connectService makes service connected", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
    });
    const connected = await runInDurableObject(stub, (instance) => {
      return instance.isServiceConnected("mock_email");
    });
    expect(connected).toBe(true);
  });

  it("disconnectService removes connection", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
    });
    await runInDurableObject(stub, (instance) => {
      instance.disconnectService("mock_email");
    });
    const connected = await runInDurableObject(stub, (instance) => {
      return instance.isServiceConnected("mock_email");
    });
    expect(connected).toBe(false);
  });

  it("listConnectedServices returns all connected services", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.connectService("calendar");
    });
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services).toHaveLength(2);
    expect(services.map((s) => s.service)).toContain("mock_email");
    expect(services.map((s) => s.service)).toContain("calendar");
  });

  it("connectService is idempotent", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.connectService("mock_email");
    });
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services).toHaveLength(1);
  });

  it("default policy is deny — a connected service with no grant does not authorize", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      // no grant created — default is deny
    });
    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    // No grant matched: the call is not allowed and nothing executed. With an
    // askable path the pipeline parks the call as "pending" rather than
    // hard-denying — either way it is never "allow".
    expect(result.governance.decision).not.toBe("allow");
    expect(result.execution).toBeUndefined();
  });

  it("a scoped session grant changes the policy to allow", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });
    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("allow");
  });

  it("executeTool denied when service not connected — audit says 'Service not connected'", async () => {
    const stub = getStub();
    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("deny");
    expect(result.execution).toBeUndefined();

    // Audit log distinguishes this from a policy deny
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE id = ${result.governance.auditEntry.id}
      `;
    });
    expect(rows[0]!.error_message).toBe("Service not connected: mock_email");
  });

  it("executeTool denied when service connected but an explicit deny grant matches — audit says 'Denied by policy'", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      // An explicit (non-floor) scoped deny grant. *No* grant
      // parks the call as `pending`; an explicit deny is a real "no" that stays
      // deny — this test covers that hard-deny path.
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId, "deny");
    });
    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("deny");
    expect(result.execution).toBeUndefined();

    // Audit log says policy deny, not service disconnect
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE id = ${result.governance.auditEntry.id}
      `;
    });
    expect(rows[0]!.error_message).toBe("Denied by policy");
  });

  it("executeTool allowed when service connected and policy is allow", async () => {
    const userId = "user-svc-allow";
    const ciphertext = await seedCiphertext();

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });
    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("allow");
    expect(result.execution).toBeDefined();
    expect(result.execution!.success).toBe(true);
  });

  it("kill switch clears grants but preserves connected services", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.connectService("calendar");
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
    });

    await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
    });

    // Connections survive a kill: the kill is deny-all only,
    // so the user can resume without re-running OAuth.
    const services = await runInDurableObject(stub, (instance) => {
      return instance.listConnectedServices();
    });
    expect(services).toHaveLength(2);
    expect(services.map((s) => s.service)).toContain("mock_email");
    expect(services.map((s) => s.service)).toContain("calendar");

    // After kill only the wildcard deny floor remains — the session grant is gone.
    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-1");
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("default-deny");
  });

  it("tool calls no longer authorized after kill switch", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });

    // Tool works before kill
    const before = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(before.governance.decision).toBe("allow");

    // Kill
    await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
    });

    // Kill is deny-all only: the connection survives, so this
    // un-granted call is NOT hard-denied as "not connected". With no affirmative
    // grant left, the askable pipeline parks it for confirmation (decision
    // `pending`) — this is the resume-by-re-approval contract. It is
    // deliberately not a plain `deny`: a hard deny would offer no prompt for the
    // user to re-approve, silently breaking resume. It still never executes here.
    const after = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(after.governance.decision).toBe("pending");
    expect(after.held?.heldCallId).toBeTruthy(); // parked for re-approval
    expect(after.execution).toBeUndefined();
  });

  it("kill switch clears session and task grants", async () => {
    const stub = getStub();
    // Create session grant + task grant
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
      instance.createTaskGrant("mock_email", "send", "outbox", "session-1");
    });

    // Verify grants exist before kill
    const entriesBefore = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-1");
    });
    // wildcard deny + session grant + task grant = 3
    expect(entriesBefore).toHaveLength(3);

    // Kill
    await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
    });

    // After kill: only the wildcard deny should remain
    const entriesAfter = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-1");
    });
    expect(entriesAfter).toHaveLength(1);
    expect(entriesAfter[0]!.id).toBe("default-deny");
    expect(entriesAfter[0]!.decision).toBe("deny");
  });
});
