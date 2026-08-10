import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Policy entries DO storage", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("default-deny entry exists after migration", async () => {
    const stub = getStub();
    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("test-session");
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // Wildcard deny should always be present
    expect(entries.some((e) => e.decision === "deny" && e.priority === 0)).toBe(true);
  });

  it("a scoped session grant authorizes its exact action and nothing else", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "inbox", sessionId);
    });

    // The exact granted action is allowed.
    const allowed = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "inbox" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(allowed.governance.decision).toBe("allow");

    // A different noun (different mailbox) is NOT authorized by the same grant.
    const otherNoun = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "archive" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(otherNoun.governance.decision).not.toBe("allow");
  });

  it("a grant with a wildcard in any field is rejected", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      expect(() =>
        instance.createSessionGrant("*", "list", "inbox", "wild-1"),
      ).toThrow();
      expect(() =>
        instance.createSessionGrant("mock_email", "*", "inbox", "wild-1"),
      ).toThrow();
      expect(() =>
        instance.createSessionGrant("mock_email", "list", "*", "wild-1"),
      ).toThrow();
      expect(() => instance.createTaskGrant("*", "list", "inbox")).toThrow();
      expect(() =>
        instance.createTaskGrant("mock_email", "*", "inbox"),
      ).toThrow();
      expect(() =>
        instance.createTaskGrant("mock_email", "list", "*"),
      ).toThrow();
    });
  });

  it("a task grant authorizes exactly once then is consumed", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      // Session-scoped: bind to the session executeTool will resolve.
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createTaskGrant("mock_email", "list", "inbox", sessionId);
    });

    // First call consumes the task grant and is allowed.
    const first = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "inbox" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(first.governance.decision).toBe("allow");

    // Second identical call is no longer authorized — the grant is consumed.
    const second = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "inbox" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(second.governance.decision).not.toBe("allow");
  });

  it("createSessionGrant creates an entry with 30min expiry", async () => {
    const stub = getStub();
    const id = await runInDurableObject(stub, (instance) => {
      return instance.createSessionGrant("mock_email", "read", "inbox", "session-1");
    });

    expect(id).toBeTruthy();

    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-1");
    });
    const match = entries.find((e) => e.id === id);
    expect(match).toBeDefined();
    expect(match!.source).toBe("session");
    expect(match!.service).toBe("mock_email");
    expect(match!.verb).toBe("read");
    expect(match!.noun).toBe("inbox");
    expect(match!.expiresAt).toBeTruthy();
  });

  it("createTaskGrant creates an entry without expiry", async () => {
    const stub = getStub();
    const id = await runInDurableObject(stub, (instance) => {
      // Session-scoped: bound to the session the query below reads.
      return instance.createTaskGrant("mock_email", "list", "inbox", "task-session");
    });

    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("task-session");
    });
    const match = entries.find((e) => e.id === id);
    expect(match).toBeDefined();
    expect(match!.source).toBe("task");
    expect(match!.expiresAt).toBeUndefined();
  });

  it("a scoped session grant enables tool execution", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "inbox", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "inbox" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.denyReason).toBeUndefined();
  });

  it("no grant on a connected service parks the call as pending (asks the user)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
    });

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });

    // Under the confirmation flow, an un-granted connected action is held to
    // ask the user — not hard-denied. No dispatch happened.
    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(result.held?.heldCallId).toBeTruthy();
  });

  it("session grant allows tool execution when default is deny", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      const sessionId = instance.resolveActiveSession({ userId: "user-1", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "inbox", sessionId);
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

  it("expired session grant is excluded from policy evaluation", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      // Insert a session grant with expires_at in the past.
      // Use ISO 8601 (toISOString) to match how createSessionGrant writes —
      // the query filter compares against strftime ISO 'now', so the fixture
      // must store the same shape it would in production (see F1 regression).
      const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const created = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      instance.sql`
        INSERT INTO policy_entries (id, source, session_id, service, verb, noun, decision, priority, created_at, expires_at)
        VALUES ('expired-grant', 'session', 'session-expired', 'mock_email', 'list', 'inbox', 'allow', 10, ${created}, ${past})
      `;
    });

    // The expired grant should not appear in query results
    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-expired");
    });

    // Only the wildcard deny should remain (expired grant filtered out)
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("default-deny");

    // The expired grant doesn't authorize: with the service connected and no
    // live grant, the call is parked as `pending` to ask the user.
    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-1",
        agentId: "agent-1",
      });
    });
    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
  });

  // F1 regression: round-trip through the PRODUCTION write path
  // (createSessionGrant uses Date.toISOString()) against the query filter.
  // A fresh grant must be live; the same grant must be filtered once its
  // stored expires_at is in the past. Guards the ISO-vs-datetime('now')
  // lexicographic mismatch where 'T' > ' ' made every grant read as unexpired.
  it("fresh createSessionGrant is live, then excluded once expired", async () => {
    const stub = getStub();

    // Fresh grant (expires 30 min out) is present in the query result.
    const id = await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      return instance.createSessionGrant("mock_email", "list", "inbox", "sess-rt");
    });

    const live = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("sess-rt");
    });
    expect(live.some((e) => e.id === id)).toBe(true);

    // Rewrite the SAME grant's expires_at into the past using the exact
    // production format (toISOString), then confirm the filter drops it.
    await runInDurableObject(stub, (instance) => {
      const past = new Date(Date.now() - 1000).toISOString();
      instance.sql`UPDATE policy_entries SET expires_at = ${past} WHERE id = ${id}`;
    });

    const afterExpiry = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("sess-rt");
    });
    expect(afterExpiry.some((e) => e.id === id)).toBe(false);
    // Only the deny floor remains for this session.
    expect(afterExpiry).toHaveLength(1);
    expect(afterExpiry[0]!.id).toBe("default-deny");
  });
});
