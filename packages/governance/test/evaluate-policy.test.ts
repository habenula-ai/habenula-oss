import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/evaluate-policy";
import type { PolicyEntry, PolicyAction } from "../src/policy";
import { WILDCARD_DENY_ID } from "../src/policy";

/**
 * Scoped allow grant matching the default makeAction() (email/list/inbox).
 * After the wildcard hardening, `*` is honored only for deny — so
 * an allow grant must be fully scoped to match. This is the shape every
 * "allow wins" test now uses.
 */
function scopedAllow(overrides?: Partial<PolicyEntry>): PolicyEntry {
  return {
    id: "scoped-allow",
    source: "session",
    service: "email",
    verb: "list",
    noun: "inbox",
    decision: "allow",
    priority: 5,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

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

function makeAction(overrides?: Partial<PolicyAction>): PolicyAction {
  return {
    agent: "test-agent",
    service: "email",
    verb: "list",
    noun: "inbox",
    toolName: "email_list_messages",
    params: { label: "INBOX" },
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("a wildcard allow entry never wins — `*` is honored only for deny", () => {
    // The hardening: an allow entry carrying `*` in any position
    // can never match. The only legitimate `*/*/*` row is the deny floor.
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "wildcard-allow", decision: "allow", priority: 1 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("deny");
  });

  it("a scoped allow grant wins over the deny floor", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow(),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });

  it("returns deny when only wildcard deny exists", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("deny");
  });

  it("returns deny when no entries match at all", () => {
    expect(evaluatePolicy([], makeAction()).decision).toBe("deny");
  });

  it("a scoped allow beats the wildcard deny floor", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow({ id: "email-allow", priority: 5 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });

  it("non-matching service falls through to the deny floor", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow({ id: "email-allow", priority: 5 }),
    ];
    expect(evaluatePolicy(entries, makeAction({ service: "slack" })).decision).toBe("deny");
  });

  it("higher priority scoped allow wins over a lower-priority scoped deny", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow({ id: "scoped-allow", priority: 10 }),
      makeEntry({ id: "specific-deny", service: "email", verb: "list", noun: "inbox", decision: "deny", priority: 5 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });

 it("equal-priority allow vs deny resolves to deny (fail-closed) regardless of input order", () => {
    const floor = makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 });
    const allow = scopedAllow({ id: "scoped-allow", priority: 10 });
    const deny = makeEntry({
      id: "scoped-deny",
      service: "email",
      verb: "list",
      noun: "inbox",
      decision: "deny",
      priority: 10,
    });

    // Allow listed before deny → still deny, and the winning entry is the deny.
    const allowFirst = evaluatePolicy([floor, allow, deny], makeAction());
    expect(allowFirst.decision).toBe("deny");
    expect(allowFirst.entryId).toBe("scoped-deny");

    // Deny listed before allow → same result. Order can't flip the decision.
    const denyFirst = evaluatePolicy([floor, deny, allow], makeAction());
    expect(denyFirst.decision).toBe("deny");
    expect(denyFirst.entryId).toBe("scoped-deny");
  });

 it("a malformed-priority allow fails closed against the deny floor, either order", () => {
    // A non-finite priority (null/NaN/undefined/Infinity — or any non-number
    // like a string) means the deny-floor ordering is undefined, so the
    // evaluator denies outright with a distinct `malformed` source rather than
    // rank corrupt input. `Number.isFinite` rejects all of these without
    // coercion, so a bare `typeof x !== "number" || Number.isNaN(x)` refactor
    // (which would let `Infinity` through) is pinned as a regression here. The
    // raw `b.priority - a.priority` form returned `0` for `0 - null`, which
    // slipped past the deny tie-break and let input order decide — a fail-OPEN
    // this replaces. The DB's NOT NULL + CHECK stop a null from being stored, but
    // this pure function is OSS-published (Hard Invariant #2) and must fail
    // closed on any input.
    const floor = makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 });

    for (const bad of [null, NaN, undefined, Infinity, "10"]) {
      // `... as unknown as number` models a corrupt row reaching the evaluator:
      // the type says priority is a number, the DB says it is NOT NULL.
      const badAllow = scopedAllow({ id: "bad-allow", priority: bad as unknown as number });

      for (const entries of [[badAllow, floor], [floor, badAllow]]) {
        const pd = evaluatePolicy(entries, makeAction());
        expect(pd.decision).toBe("deny");
        expect(pd.source).toBe("malformed");
        expect(pd.entryId).toBeUndefined();
      }
    }
  });

 it("a malformed-priority deny is NOT demoted below a finite allow — still fails closed, either order", () => {
    // The symmetric direction a plain -Infinity coercion would miss: a malformed
    // deny sunk to -Infinity would lose to a finite allow (a fail-OPEN). The
    // short-circuit denies regardless of the competing allow. This test fails
    // under the -Infinity approach and under `main`'s raw subtraction.
    const allow = scopedAllow({ id: "finite-allow", priority: 10 });

    for (const bad of [null, NaN, undefined, Infinity, "10"]) {
      const badDeny = makeEntry({
        id: "bad-deny",
        service: "email",
        verb: "list",
        noun: "inbox",
        decision: "deny",
        priority: bad as unknown as number,
      });

      for (const entries of [[badDeny, allow], [allow, badDeny]]) {
        expect(evaluatePolicy(entries, makeAction()).decision).toBe("deny");
      }
    }
  });

 it("two matched malformed entries deny without leaking NaN from the comparator, either order", () => {
    // Both non-finite → the short-circuit fires before the priority subtraction,
    // so `NaN` from `null - NaN` never reaches the sort. A malformed allow and a
    // malformed deny together still deny.
    const badAllow = scopedAllow({ id: "bad-allow", priority: null as unknown as number });
    const badDeny = makeEntry({
      id: "bad-deny",
      service: "email",
      verb: "list",
      noun: "inbox",
      decision: "deny",
      priority: NaN,
    });

    expect(evaluatePolicy([badAllow, badDeny], makeAction()).decision).toBe("deny");
    expect(evaluatePolicy([badDeny, badAllow], makeAction()).decision).toBe("deny");
  });

  it("a higher-priority allow still beats an equal-scope lower-priority deny (tie-break only fires on equal priority)", () => {
    // Guards against the tie-break over-reaching: priority is still the primary
    // key, so a deliberately higher-priority allow wins over a lower deny.
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow({ id: "scoped-allow", priority: 20 }),
      makeEntry({ id: "scoped-deny", service: "email", verb: "list", noun: "inbox", decision: "deny", priority: 10 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });

 it("a partial-wildcard allow (`noun: *`) does not match — falls through to the deny floor", () => {
    // The wildcard hardening rejects a `*` in ANY position on an allow entry, not
    // just a full `*/*/*`. This covers the noun-position branch independently.
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "noun-wildcard-allow", service: "email", verb: "list", noun: "*", decision: "allow", priority: 10 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("deny");
  });

 it("a partial-wildcard allow (`verb: *`) does not match — falls through to the deny floor", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "verb-wildcard-allow", service: "email", verb: "*", noun: "inbox", decision: "allow", priority: 10 }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("deny");
  });

  it("entry source and id are returned in the decision", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      scopedAllow({ id: "scoped-allow", source: "session", priority: 5 }),
    ];
    const result = evaluatePolicy(entries, makeAction());
    expect(result.source).toBe("session");
    expect(result.entryId).toBe("scoped-allow");
  });

  it("returns implicit deny source when no matches", () => {
    const result = evaluatePolicy([], makeAction());
    expect(result.decision).toBe("deny");
    expect(result.source).toBe("implicit");
  });

  it("is a pure function — no side effects", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "scoped-allow", service: "email", verb: "list", noun: "inbox", decision: "allow", priority: 1 }),
    ];
    const action = makeAction();
    const actionCopy = { ...action, params: { ...action.params } };

    evaluatePolicy(entries, action);

    expect(action).toEqual(actionCopy);
  });

  it("executes in under 1ms", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "scoped-allow", service: "email", verb: "list", noun: "inbox", decision: "allow", priority: 1 }),
    ];
    const action = makeAction();

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      evaluatePolicy(entries, action);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / 1000;

    console.log(`evaluatePolicy: ${perCall.toFixed(4)}ms per call`);
    expect(perCall).toBeLessThan(1);
  });

  it("a scoped allow matches its exact verb only", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "send-allow", service: "email", verb: "send", noun: "inbox", decision: "allow", priority: 5 }),
    ];
    expect(evaluatePolicy(entries, makeAction({ verb: "send" })).decision).toBe("allow");
    expect(evaluatePolicy(entries, makeAction({ verb: "delete" })).decision).toBe("deny");
  });

  it("a scoped allow matches its exact noun only (case-insensitive)", () => {
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({ id: "inbox-allow", service: "email", verb: "list", noun: "INBOX", decision: "allow", priority: 5 }),
    ];
    expect(evaluatePolicy(entries, makeAction({ noun: "INBOX" })).decision).toBe("allow");
    expect(evaluatePolicy(entries, makeAction({ noun: "SENT" })).decision).toBe("deny");
  });

  it("a session-sourced grant matches on service/verb/noun like any other (sessionId is inert here)", () => {
    // Session scoping is the CALLER's precondition (the engine SQL filter), not
    // evaluatePolicy's job: a `source: "session"` entry matches purely on
    // service/verb/noun, and its sessionId is never read.
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({
        id: "session-grant",
        source: "session",
        sessionId: "my-session",
        service: "email",
        verb: "list",
        noun: "inbox",
        decision: "allow",
        priority: 5,
      }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });

  it("does NOT filter by session or expiry — a foreign, long-expired grant is still honored (caller precondition)", () => {
    // Guards the published contract (Hard Invariant #2): expiry/session filtering
    // lives in the engine's selectActivePolicyEntries SQL, NOT here. Passed an
    // unfiltered set, evaluatePolicy honors a stale/foreign allow — so an OSS
    // consumer must run that filter first and never read this as enforcing
    // session scope. (If a future change makes the evaluator session-aware, this
    // test flips and forces the contract/doc to be revisited deliberately.)
    const entries: PolicyEntry[] = [
      makeEntry({ id: WILDCARD_DENY_ID, decision: "deny", priority: 0 }),
      makeEntry({
        id: "foreign-expired-grant",
        source: "session",
        sessionId: "some-other-session",
        expiresAt: "2000-01-01T00:00:00.000Z", // long past
        service: "email",
        verb: "list",
        noun: "inbox",
        decision: "allow",
        priority: 5,
      }),
    ];
    expect(evaluatePolicy(entries, makeAction()).decision).toBe("allow");
  });
});
