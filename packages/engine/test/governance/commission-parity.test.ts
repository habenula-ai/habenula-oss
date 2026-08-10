/**
 * The spec's preserved behavior: a commissioned action
 * and an identical CLI action produce identical governance decisions — origin
 * is provenance for the audit log, never an input to evaluatePolicy. Verified
 * on real DOs across the deny (no grant) and allow (session grant) paths.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserAgent, ExecuteToolResult } from "../../src/agent/user-agent";
import type { AuditOrigin } from "../../src/data/helpers/audit-log";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

/** Run the identical governed call on a fresh DO under the given origin. */
async function decide(
  origin: AuditOrigin,
  granted: boolean,
): Promise<ExecuteToolResult["governance"]> {
  const stub = getStub();
  return runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as UserAgent;
    agent.connectService("mock_email");
    if (granted) {
      const sessionId = agent.resolveActiveSession({
        userId: "u",
        agentId: "onboarding",
      });
      agent.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    }
    const result = await agent.executeTool({
      toolName: "mock_email_list",
      toolParams: { label: "INBOX" },
      userId: "u",
      agentId: "onboarding",
      origin,
    });
    return result.governance;
  });
}

const strip = (g: ExecuteToolResult["governance"]) => ({
  decision: g.decision,
  service: g.service,
  verb: g.verb,
  noun: g.noun,
  matchedSource: g.matchedSource,
});

describe("commission ↔ CLI governance parity", () => {
  it("un-granted: both origins hold identically (pending)", async () => {
    const human = await decide("human", false);
    const commission = await decide("mcp_commission", false);
    expect(strip(commission)).toEqual(strip(human));
    expect(human.decision).toBe("pending");
  });

  it("granted: both origins allow identically off the same grant shape", async () => {
    const human = await decide("human", true);
    const commission = await decide("mcp_commission", true);
    expect(strip(commission)).toEqual(strip(human));
    expect(human.decision).toBe("allow");
    expect(human.matchedSource).toBe("session");
  });
});
