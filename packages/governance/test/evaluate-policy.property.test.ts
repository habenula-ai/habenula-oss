// Property-based security suite for evaluatePolicy. The evaluator is the
// governance pure function (Hard
// Invariant #2): these properties pin deny-wins, totality, and determinism as
// executable invariants over generated policies and actions, failing CI in
// both the monorepo and the packed mirror if a change weakens them. The
// example-based per-module suite lives in evaluate-policy.test.ts.
import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { evaluatePolicy } from "../src/evaluate-policy";
import type { PolicyAction, PolicyEntry } from "../src/policy";
import { WILDCARD_DENY_ID } from "../src/policy";

// Fixed seed: identical generation and shrink paths on every run, local and
// CI, so any failure reproduces byte-for-byte from the report.
const PROP = { seed: 34 } as const;

const CREATED_AT = "2026-01-01T00:00:00Z";

// Names mix realistic catalog values, the wildcard literal, and arbitrary
// strings (including empty), so matching is exercised across every class.
const nameArb = fc.oneof(
  fc.constantFrom("email", "calendar", "github", "slack", "web"),
  fc.constant("*"),
  fc.string({ maxLength: 12 }),
);

// Nouns add mixed-case variants: entry/action noun comparison is
// case-insensitive in the evaluator.
const nounArb = fc.oneof(nameArb, fc.constantFrom("Inbox", "INBOX", "inbox"));

const sourceArb = fc.constantFrom<PolicyEntry["source"]>("session", "task", "standing");
const finitePriorityArb = fc.integer({ min: -100, max: 100 });
const anyPriorityArb = fc.oneof(
  finitePriorityArb,
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

function entryArb(priorityArb: fc.Arbitrary<number>): fc.Arbitrary<PolicyEntry> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    source: sourceArb,
    service: nameArb,
    verb: nameArb,
    noun: nounArb,
    decision: fc.constantFrom<PolicyEntry["decision"]>("allow", "deny"),
    priority: priorityArb,
    createdAt: fc.constant(CREATED_AT),
  });
}

const actionArb: fc.Arbitrary<PolicyAction> = fc.record({
  agent: fc.string({ maxLength: 8 }),
  service: nameArb,
  verb: nameArb,
  noun: nounArb,
  toolName: fc.string({ maxLength: 12 }),
  params: fc.constant({}),
});

const entriesArb = fc.array(entryArb(anyPriorityArb), { maxLength: 12 });

// A concrete scoped entry matching `action` exactly (no wildcards required).
function scopedEntry(
  action: PolicyAction,
  overrides: Partial<PolicyEntry> & Pick<PolicyEntry, "id" | "decision" | "priority">,
): PolicyEntry {
  return {
    source: "session",
    service: action.service,
    verb: action.verb,
    noun: action.noun,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("evaluatePolicy properties (Hard Invariant #2)", () => {
  test.prop([entriesArb, actionArb], PROP)(
    "totality: every generated input yields a valid decision, never a throw",
    (entries, action) => {
      const result = evaluatePolicy(entries, action);
      expect(["allow", "deny"]).toContain(result.decision);
      expect(typeof result.source).toBe("string");
      expect(result.source.length).toBeGreaterThan(0);
    },
  );

  test.prop([entriesArb, actionArb], PROP)(
    "determinism: identical inputs produce identical results, and inputs are never mutated",
    (entries, action) => {
      const entriesBefore = structuredClone(entries);
      const actionBefore = structuredClone(action);
      const first = evaluatePolicy(entries, action);
      const second = evaluatePolicy(structuredClone(entries), structuredClone(action));
      expect(second).toEqual(first);
      expect(entries).toEqual(entriesBefore);
      expect(action).toEqual(actionBefore);
    },
  );

  test.prop(
    [
      entriesArb.chain((entries) =>
        fc.tuple(
          fc.constant(entries),
          fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
        ),
      ),
      actionArb,
    ],
    PROP,
  )(
    "order-invariance: the decision does not depend on how entries are listed",
    ([entries, permuted], action) => {
      expect(evaluatePolicy(permuted, action).decision).toBe(
        evaluatePolicy(entries, action).decision,
      );
    },
  );

  test.prop([actionArb], PROP)("deny-wins: an empty policy set denies implicitly", (action) => {
    expect(evaluatePolicy([], action)).toEqual({ decision: "deny", source: "implicit" });
  });

  test.prop(
    [
      fc.array(
        fc
          .tuple(entryArb(finitePriorityArb), fc.constantFrom(0, 1, 2))
          .map(([entry, position]): PolicyEntry => {
            return {
              ...entry,
              decision: "allow",
              service: position === 0 ? "*" : entry.service,
              verb: position === 1 ? "*" : entry.verb,
              noun: position === 2 ? "*" : entry.noun,
            };
          }),
        { maxLength: 8 },
      ),
      actionArb,
    ],
    PROP,
  )(
    "wildcard hardening: allow entries carrying * in any position never match — only deny honors wildcards",
    (wildcardAllows, action) => {
      const result = evaluatePolicy(wildcardAllows, action);
      expect(result.decision).toBe("deny");
      expect(result.source).toBe("implicit");
    },
  );

  test.prop([entriesArb, entryArb(finitePriorityArb), actionArb], PROP)(
    "deny monotonicity: adding a deny entry never turns a deny into an allow",
    (entries, extra, action) => {
      fc.pre(evaluatePolicy(entries, action).decision === "deny");
      const withDeny = [...entries, { ...extra, decision: "deny" as const }];
      expect(evaluatePolicy(withDeny, action).decision).toBe("deny");
    },
  );

  test.prop([actionArb, finitePriorityArb, fc.boolean()], PROP)(
    "deny-wins: an equal-priority allow/deny conflict fails closed in either listing order",
    (action, priority, denyFirst) => {
      fc.pre(![action.service, action.verb, action.noun].includes("*"));
      const allow = scopedEntry(action, { id: "conflict-allow", decision: "allow", priority });
      const deny = scopedEntry(action, { id: "conflict-deny", decision: "deny", priority });
      const result = evaluatePolicy(denyFirst ? [deny, allow] : [allow, deny], action);
      expect(result.decision).toBe("deny");
      expect(result.entryId).toBe("conflict-deny");
    },
  );

  test.prop([actionArb, fc.integer({ min: 1, max: 100 })], PROP)(
    "grants work: a scoped allow strictly above the deny floor is honored",
    (action, priority) => {
      fc.pre(![action.service, action.verb, action.noun].includes("*"));
      const floor: PolicyEntry = {
        id: WILDCARD_DENY_ID,
        source: "standing",
        service: "*",
        verb: "*",
        noun: "*",
        decision: "deny",
        priority: 0,
        createdAt: CREATED_AT,
      };
      const grant = scopedEntry(action, { id: "grant", decision: "allow", priority });
      const result = evaluatePolicy([floor, grant], action);
      expect(result).toEqual({ decision: "allow", source: grant.source, entryId: "grant" });
    },
  );

  test.prop(
    [
      entriesArb,
      actionArb,
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    ],
    PROP,
  )(
    "fail closed: any matched entry with a non-finite priority denies as malformed",
    (entries, action, badPriority) => {
      // decision "deny" so the injected entry matches even a wildcard-bearing
      // action (allow refuses wildcards), making it always part of `matched`.
      const corrupt = scopedEntry(action, {
        id: "corrupt",
        decision: "deny",
        priority: badPriority,
      });
      expect(evaluatePolicy([...entries, corrupt], action)).toEqual({
        decision: "deny",
        source: "malformed",
      });
    },
  );
});
