// Behavioral suite for the decision-closure check:
// owesCloser's clause order (the rule itself — the spend-supersede and
// ledger-failure rows are the cases a reordered predicate silently inverts),
// the four range answers, both openKind values, the agreement label, and the
// two-range carry. Tested the way evaluate-policy and verify-chain are: many
// inputs, no I/O, assertions on the returned verdict. Closure never reads
// hashes, so fixtures carry placeholder hash fields.
import { describe, expect, it } from "vitest";
import type { ChainEntry } from "../src/verify-chain";
import {
  LIFECYCLE_TOOLS,
  checkDecisionClosure,
  owesCloser,
  type ClosureVerdict,
} from "../src/decision-closure";

function entry(id: string, over: Partial<ChainEntry> = {}): ChainEntry {
  return {
    epochId: "2026-07-01",
    sequenceNum: 0,
    prevHash: "prev",
    id,
    timestamp: "2026-07-01T09:00:00.000Z",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    origin: "human",
    service: "mock_email",
    verb: "list",
    noun: "INBOX",
    toolName: "mock_email_list",
    parametersMetadata: "{}",
    decision: "allow",
    outcome: "success",
    errorMessage: null,
    decisionEntryId: null,
    latencyMs: 0,
    costUsd: null,
    hash: "hash",
    epochPrevHash: null,
    ...over,
  };
}

/** Ascending chain order: sequence numbers by position, oldest first. */
function chain(entries: ChainEntry[]): ChainEntry[] {
  return entries.map((e, i) => ({ ...e, sequenceNum: i }));
}

function closed(entries: ChainEntry[]): ClosureVerdict {
  return checkDecisionClosure(entries, { upperEdgeClosed: true });
}

describe("owesCloser — the clause order is the rule", () => {
  it("clause 1: a row carrying a referent owes nothing, whatever its decision word says", () => {
    // The spend-supersede row: decision "pending" AND a referent. A
    // pending-first predicate answers true here — and the row can never
    // receive a closer (every later closer names the FRESH pending entry the
    // same transaction wrote), so it would read unresolved for the life of
    // the log. Clause 1 catches it first.
    const supersede = entry("supersede", {
      decision: "pending",
      outcome: "success",
      errorMessage: "Superseded by a spending confirmation",
      decisionEntryId: "old-pending",
    });
    expect(owesCloser(supersede)).toBe(false);
    // The same row without its referent DOES owe one — which pins the order:
    // it is the referent clause, not the decision word, that decided.
    expect(owesCloser({ ...supersede, decisionEntryId: null })).toBe(true);
    // The ledger-failure row: decision "allow" with a referent — same rule.
    expect(
      owesCloser(entry("ledger-fail", { outcome: "error", decisionEntryId: "outcome-1" })),
    ).toBe(false);
  });

  it("clause 2: all three lifecycle tool names are non-decisions", () => {
    expect([...LIFECYCLE_TOOLS].sort()).toEqual(["session.end", "session.start", "task.cancel"]);
    for (const toolName of LIFECYCLE_TOOLS) {
      // session.end stamps deny/timeout, session.start and task.cancel stamp
      // allow/success — placeholders either way, never an owed decision.
      expect(owesCloser(entry("lc", { toolName, decision: "allow" }))).toBe(false);
      expect(owesCloser(entry("lc", { toolName, decision: "deny" }))).toBe(false);
      expect(owesCloser(entry("lc", { toolName, decision: "pending" }))).toBe(false);
    }
  });

  it("clause 3: a deny is terminal by itself; clauses 4-5: pending and allow owe one", () => {
    expect(owesCloser(entry("d", { decision: "deny", outcome: "error" }))).toBe(false);
    expect(owesCloser(entry("p", { decision: "pending" }))).toBe(true);
    expect(owesCloser(entry("a", { decision: "allow" }))).toBe(true);
  });
});

describe("checkDecisionClosure — the four range answers", () => {
  it("clean: a decision plus one closer under a closed edge — counted, not listed", () => {
    const verdict = closed(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("closer-1", { decision: "allow", decisionEntryId: "pending-1" }),
      ]),
    );
    expect(verdict.decisionsChecked).toBe(1);
    expect(verdict.conflicted).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.unchecked).toEqual([]);
    expect(verdict.carry.unmatchedClosers).toEqual([]);
  });

  it("conflicted/contradictory: a timeout sweep row against a real success closer", () => {
    const verdict = closed(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("real", { decision: "allow", outcome: "success", decisionEntryId: "pending-1" }),
        entry("swept", { decision: "deny", outcome: "timeout", decisionEntryId: "pending-1" }),
      ]),
    );
    expect(verdict.conflicted).toHaveLength(1);
    const finding = verdict.conflicted[0]!;
    expect(finding.id).toBe("pending-1");
    expect(finding.agreement).toBe("contradictory");
    expect(finding.closers.map((c) => c.id).sort()).toEqual(["real", "swept"]);
  });

  it("conflicted/duplicated: two identical allow/error recovery rows are not a contradiction", () => {
    const verdict = closed(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("rec-1", { decision: "allow", outcome: "error", decisionEntryId: "pending-1" }),
        entry("rec-2", { decision: "allow", outcome: "error", decisionEntryId: "pending-1" }),
      ]),
    );
    expect(verdict.conflicted).toHaveLength(1);
    expect(verdict.conflicted[0]!.agreement).toBe("duplicated");
  });

  it("the agreement label reads decision and outcome and nothing else", () => {
    // The expiry sweep writes deny/timeout and the cancel sweep deny/error:
    // a timeout-versus-cancel collision is contradictory without consulting
    // either message.
    const verdict = closed(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("expiry", { decision: "deny", outcome: "timeout", decisionEntryId: "pending-1" }),
        entry("cancel", { decision: "deny", outcome: "error", decisionEntryId: "pending-1" }),
      ]),
    );
    expect(verdict.conflicted[0]!.agreement).toBe("contradictory");
    // Identical decision/outcome with different prose stays duplicated.
    const prose = closed(
      chain([
        entry("pending-2", { decision: "pending" }),
        entry("c1", {
          decision: "allow",
          outcome: "error",
          errorMessage: "one wording",
          decisionEntryId: "pending-2",
        }),
        entry("c2", {
          decision: "allow",
          outcome: "error",
          errorMessage: "another wording",
          decisionEntryId: "pending-2",
        }),
      ]),
    );
    expect(prose.conflicted[0]!.agreement).toBe("duplicated");
  });

  it("unresolved/awaiting: a pending decision with no closer — the ordinary open prompt", () => {
    const verdict = closed(chain([entry("pending-1", { decision: "pending" })]));
    expect(verdict.unresolved).toHaveLength(1);
    expect(verdict.unresolved[0]!.openKind).toBe("awaiting");
  });

  it("unresolved/dispatched: an allow decision with no closer — the executeTool orphan", () => {
    const verdict = closed(chain([entry("allow-1", { decision: "allow" })]));
    expect(verdict.unresolved).toHaveLength(1);
    expect(verdict.unresolved[0]!.openKind).toBe("dispatched");
  });

  it("unchecked: an open upper edge makes every decision unchecked — one range cannot prove absence", () => {
    const verdict = checkDecisionClosure(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("closer-1", { decision: "allow", decisionEntryId: "pending-1" }),
      ]),
      { upperEdgeClosed: false },
    );
    expect(verdict.unchecked).toHaveLength(1);
    expect(verdict.unchecked[0]!.id).toBe("pending-1");
    expect(verdict.conflicted).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
  });

  it("a deny decision owes nothing and is not counted or listed", () => {
    const verdict = closed(
      chain([entry("deny-1", { decision: "deny", outcome: "error" })]),
    );
    expect(verdict.decisionsChecked).toBe(0);
    expect(verdict.conflicted).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
  });

  it("lifecycle rows are not decisions in a range", () => {
    const verdict = closed(
      chain([
        entry("s-start", { toolName: "session.start", service: "session", verb: "start" }),
        entry("s-end", {
          toolName: "session.end",
          service: "session",
          verb: "end",
          decision: "deny",
          outcome: "timeout",
        }),
        entry("t-cancel", { toolName: "task.cancel", service: "task", verb: "cancel" }),
      ]),
    );
    expect(verdict.decisionsChecked).toBe(0);
    expect(verdict.unresolved).toEqual([]);
  });
});

describe("checkDecisionClosure — the write inventory's two turning rows", () => {
  it("the spend-supersede row is a closer of the entry below it and never unresolved itself", () => {
    // The real sequence: the superseded permission pending, the supersede row
    // naming it, the FRESH spending pending, and a closer naming the fresh
    // entry. One clean decision (the old pending), one clean decision (the
    // fresh pending), never a conflict with itself.
    const full = closed(
      chain([
        entry("old-pending", { decision: "pending" }),
        entry("supersede", {
          decision: "pending",
          outcome: "success",
          errorMessage: "Superseded by a spending confirmation",
          decisionEntryId: "old-pending",
        }),
        entry("fresh-pending", { decision: "pending", costUsd: 11.5 }),
        entry("fresh-closer", { decision: "allow", decisionEntryId: "fresh-pending" }),
      ]),
    );
    expect(full.decisionsChecked).toBe(2);
    expect(full.conflicted).toEqual([]);
    expect(full.unresolved).toEqual([]);
    expect(full.carry.unmatchedClosers).toEqual([]);

    // Withhold the fresh entry's closer: exactly ONE open decision — the
    // fresh pending, awaiting — and the supersede row is still not it. This
    // is the assertion a pending-first predicate fails (it reports the
    // supersede row unresolved forever, on a row that is correctly closed).
    const withheld = closed(
      chain([
        entry("old-pending", { decision: "pending" }),
        entry("supersede", {
          decision: "pending",
          outcome: "success",
          errorMessage: "Superseded by a spending confirmation",
          decisionEntryId: "old-pending",
        }),
        entry("fresh-pending", { decision: "pending", costUsd: 11.5 }),
      ]),
    );
    expect(withheld.unresolved).toHaveLength(1);
    expect(withheld.unresolved[0]!.id).toBe("fresh-pending");
    expect(withheld.unresolved[0]!.openKind).toBe("awaiting");
  });

  it("the ledger-failure row is never a closer of a decision, and its outcome referent never owes", () => {
    const verdict = closed(
      chain([
        entry("decision-1", { decision: "allow" }),
        entry("outcome-1", { decision: "allow", decisionEntryId: "decision-1" }),
        entry("ledger-fail", {
          decision: "allow",
          outcome: "error",
          errorMessage: "spend_ledger write failed — spend uncounted",
          decisionEntryId: "outcome-1",
        }),
      ]),
    );
    // One decision, closed once. The ledger-failure closer's referent (the
    // outcome row) appeared and owes nothing, so it is discarded, not
    // carried — and the outcome row is never reported as unresolved.
    expect(verdict.decisionsChecked).toBe(1);
    expect(verdict.conflicted).toEqual([]);
    expect(verdict.unresolved).toEqual([]);
    expect(verdict.carry.unmatchedClosers).toEqual([]);
  });
});

describe("checkDecisionClosure — the carry", () => {
  it("a closer whose referent is below the range passes into the carry and resolves in the older range", () => {
    // Newest-first pages: page one holds the closer, page two (older) holds
    // the decision. Both ranges are handed ascending.
    const pageOne = chain([
      entry("closer-1", { decision: "allow", decisionEntryId: "pending-1" }),
    ]);
    const pageTwo = chain([entry("pending-1", { decision: "pending" })]);

    const first = checkDecisionClosure(pageOne, { upperEdgeClosed: true });
    // The decision it names is never reported from this range.
    expect(first.decisionsChecked).toBe(0);
    expect(first.carry.unmatchedClosers).toHaveLength(1);
    expect(first.carry.unmatchedClosers[0]!.referentId).toBe("pending-1");

    const second = checkDecisionClosure(pageTwo, {
      carry: first.carry,
      upperEdgeClosed: true,
    });
    // Clean on the aggregate: the carried closer met its decision.
    expect(second.decisionsChecked).toBe(1);
    expect(second.unresolved).toEqual([]);
    expect(second.conflicted).toEqual([]);
    expect(second.carry.unmatchedClosers).toEqual([]);
  });

  it("a walk that never hands the older range over leaves the closer unmatched — unchecked coverage", () => {
    const first = checkDecisionClosure(
      chain([entry("closer-1", { decision: "allow", decisionEntryId: "pending-1" })]),
      { upperEdgeClosed: true },
    );
    expect(first.carry.unmatchedClosers).toHaveLength(1);
  });

  it("a carried closer joins in-range closers to make a conflict across a page edge", () => {
    const first = checkDecisionClosure(
      chain([entry("swept", { decision: "deny", outcome: "timeout", decisionEntryId: "pending-1" })]),
      { upperEdgeClosed: true },
    );
    const second = checkDecisionClosure(
      chain([
        entry("pending-1", { decision: "pending" }),
        entry("real", { decision: "allow", outcome: "success", decisionEntryId: "pending-1" }),
      ]),
      { carry: first.carry, upperEdgeClosed: true },
    );
    expect(second.conflicted).toHaveLength(1);
    expect(second.conflicted[0]!.agreement).toBe("contradictory");
    expect(second.conflicted[0]!.closers.map((c) => c.id).sort()).toEqual(["real", "swept"]);
  });
});
