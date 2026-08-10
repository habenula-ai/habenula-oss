import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { PolicyEntry } from "@habenula-ai/governance";
import { lookupTool } from "@habenula-ai/tools";
import { evaluatePolicy } from "@habenula-ai/governance";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";

function makeEntry(overrides?: Partial<PolicyEntry>): PolicyEntry {
  return {
    id: "test-entry",
    source: "standing",
    service: "*",
    verb: "*",
    noun: "*",
    decision: "deny",
    priority: 0,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("Deny blocks execute (integration)", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  const pipelineParams = {
    toolName: "gmail_list",
    params: { label: "INBOX" },
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    epochId: "2026-04-07",
    timestamp: "2026-04-07T12:00:00Z",
  };

  it("allow entries → decision 'allow', audit records 'allow'", async () => {
    const stub = getStub();
    // Scoped allow for gmail/list/INBOX — after the hardening only a
    // fully-scoped allow grant authorizes (a wildcard allow never matches).
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({
        id: "gmail-inbox-allow",
        source: "session",
        service: "gmail",
        verb: "list",
        noun: "INBOX",
        decision: "allow",
        priority: 5,
      }),
    ];

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeGovernancePipeline({
        ...pipelineParams,
        entries,
      });
    });

    expect(result.decision).toBe("allow");
    expect(result.service).toBe("gmail");
    expect(result.verb).toBe("list");
    expect(result.noun).toBe("INBOX");

    // Verify audit log records the allow decision
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ decision: string; outcome: string }>`
        SELECT decision, outcome FROM audit_log WHERE id = ${result.auditEntry.id}
      `;
    });

    expect(rows[0]!.decision).toBe("allow");
    expect(rows[0]!.outcome).toBe("success");
  });

  it("deny-only entries → decision 'deny', audit records 'deny', caller blocks execution", async () => {
    const stub = getStub();
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
    ];

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeGovernancePipeline({
        ...pipelineParams,
        entries,
      });
    });

    // Decision is deny — caller uses this to NOT execute the tool
    expect(result.decision).toBe("deny");

    // Audit log records the denial
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        decision: string;
        outcome: string;
        error_message: string | null;
      }>`SELECT decision, outcome, error_message FROM audit_log WHERE id = ${result.auditEntry.id}`;
    });

    expect(rows[0]!.decision).toBe("deny");
    expect(rows[0]!.outcome).toBe("error");
    expect(rows[0]!.error_message).toBe("Denied by policy");
  });

 it("malformed-priority match → deny with a distinct audit error_message", async () => {
    const stub = getStub();
    // A matched entry with a non-finite priority makes the deny-floor ordering
    // undefined, so the evaluator fails closed with source "malformed". The
    // `malformed` source is not persisted as an audit column, so the reason
    // string is the only forensic trace — pin that it is distinguishable from
    // an ordinary floor deny ("Denied by policy") above.
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({
        id: "corrupt-allow",
        source: "session",
        service: "gmail",
        verb: "list",
        noun: "INBOX",
        decision: "allow",
        priority: null as unknown as number,
      }),
    ];

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeGovernancePipeline({
        ...pipelineParams,
        entries,
      });
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedSource).toBe("malformed");

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        decision: string;
        outcome: string;
        error_message: string | null;
      }>`SELECT decision, outcome, error_message FROM audit_log WHERE id = ${result.auditEntry.id}`;
    });

    expect(rows[0]!.decision).toBe("deny");
    expect(rows[0]!.outcome).toBe("error");
    expect(rows[0]!.error_message).toBe(
      "Denied: malformed policy set (non-finite priority)"
    );
  });

  it("unknown tool → falls back to service 'unknown', verb 'execute'", async () => {
    const stub = getStub();
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "scoped-allow", service: "gmail", verb: "list", noun: "INBOX", decision: "allow", priority: 1 }),
    ];

    const result = await runInDurableObject(stub, (instance) => {
      return instance.executeGovernancePipeline({
        ...pipelineParams,
        toolName: "unregistered_tool",
        entries,
      });
    });

    expect(result.service).toBe("unknown");
    expect(result.verb).toBe("execute");
    expect(result.noun).toBe("unknown");

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ service: string; verb: string; noun: string }>`
        SELECT service, verb, noun FROM audit_log WHERE id = ${result.auditEntry.id}
      `;
    });

    expect(rows[0]!.service).toBe("unknown");
    expect(rows[0]!.verb).toBe("execute");
    expect(rows[0]!.noun).toBe("unknown");
  });

  it("governance pipeline executes in under 1ms (excluding audit write)", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "scoped-allow", service: "gmail", verb: "list", noun: "INBOX", decision: "allow", priority: 1 }),
    ];

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const toolEntry = lookupTool("gmail_list")!;
      const noun = toolEntry.nounExtractor({ label: "INBOX" });
      evaluatePolicy(entries, {
        agent: "agent-1",
        service: toolEntry.service,
        verb: toolEntry.verb,
        noun,
        toolName: "gmail_list",
        params: { label: "INBOX" },
      });
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / 1000;

    console.log(
      `registry lookup + evaluatePolicy: ${perCall.toFixed(4)}ms per call`
    );
    expect(perCall).toBeLessThan(1);
  });
});
