import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "@habenula-ai/governance";
import type { PolicyEntry, PolicyAction } from "@habenula-ai/governance";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";
import { SERVICES, toolName } from "@habenula-ai/tools";

/**
 * Governance evaluates the concrete service. A
 * grant scoped to one service authorizes that service and does NOT implicitly
 * authorize another service's action — the per-service authorization
 * strengthening. evaluatePolicy stays a pure function (Hard Invariant 2).
 * Iterates the catalog rather than naming services, so a new service re-runs
 * every invariant — including non-authorization against every other service.
 */
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

/** One representative concrete action per catalog service, from its tools. */
const ACTIONS: PolicyAction[] = SERVICES.flatMap((service) =>
  service.tools.map((tool) => ({
    agent: "agent-1",
    service: service.service,
    verb: tool.verb,
    noun: tool.nounExtractor({}),
    toolName: toolName(tool),
    params: {},
  })),
);

describe("governance on the concrete service", () => {
  const denyFloor = makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 });

  /** A grant entry matching exactly the given action. */
  function grantFor(action: PolicyAction, decision: "allow" | "deny"): PolicyEntry {
    return makeEntry({
      id: `${action.service}-${decision}`,
      service: action.service,
      verb: action.verb,
      noun: action.noun,
      decision,
      priority: 5,
    });
  }

  it("allows each service's action when a grant for that service matches", () => {
    for (const action of ACTIONS) {
      const entries = [denyFloor, grantFor(action, "allow")];
      expect(
        evaluatePolicy(entries, action).decision,
        `grant on ${action.service} should allow ${action.toolName}`,
      ).toBe("allow");
    }
  });

  it("denies each service's action under an explicit deny for that service", () => {
    for (const action of ACTIONS) {
      const entries = [denyFloor, grantFor(action, "deny")];
      expect(
        evaluatePolicy(entries, action).decision,
        `explicit deny on ${action.service} should deny ${action.toolName}`,
      ).toBe("deny");
    }
  });

  it("a grant on one service authorizes no other service (per-service isolation)", () => {
    for (const granted of ACTIONS) {
      const entries = [denyFloor, grantFor(granted, "allow")];
      for (const other of ACTIONS) {
        if (other.service === granted.service) continue;
        // Same verb/noun shape, different concrete service ⇒ deny floor.
        expect(
          evaluatePolicy(entries, other).decision,
          `grant on ${granted.service} must not authorize ${other.service}`,
        ).toBe("deny");
      }
      // The action it was granted for still allows.
      expect(evaluatePolicy(entries, granted).decision).toBe("allow");
    }
  });
});
