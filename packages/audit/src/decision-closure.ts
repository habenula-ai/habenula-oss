//! SPDX-FileCopyrightText: 2026 Habenula, Inc.
//! SPDX-License-Identifier: MIT

// The decision-closure check: a range of chain entries in,
// a verdict out naming each decision as clean, conflicted, unresolved, or
// unchecked. Pure by the discipline verify-chain.ts holds — no I/O, no
// logging, no clock, no timers (a per-file eslint block enforces it; see
// eslint.config.mjs). Unlike verify-chain.ts it imports nothing at all, so
// for this file the node:* ban has no transitive exception.
//
// It lives BESIDE verifyChainRange, not inside it: `BreakKind` stays closed
// around "was the chain mutated", and a semantic conflict — two closers on
// one decision — is not a tamper signal. The one duplicate the engine
// deliberately writes (two identical dispatch-recovery closers) and the one
// correction it permits (a truthful closer landing after a wrong one) are
// both real rows with intact hashes.

import type { ChainEntry } from "./verify-chain.js";

/**
 * Lifecycle rows record something that happened to the SYSTEM, not a governed
 * tool call: synthetic `service`/`verb` outside the tool registry, fixed
 * `decision`/`outcome` placeholders, the real disposition in `errorMessage`.
 * Matched on `toolName` because the record carries no column saying "this row
 * is a lifecycle event". This is the one definition (moved here from the CLI
 * render); `packages/engine/src/dev-model/page.ts` keeps an inline copy only
 * because that file is client JavaScript inside a template string and can
 * import nothing — keep the two in step until the record gains an explicit
 * discriminator. The engine writers are `createSessionInTxn`,
 * `writeSessionEnd`, and `writeTaskCancelAudit`.
 */
export const LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "session.start",
  "session.end",
  "task.cancel",
]);

/**
 * Whether the log still owes this entry a closer. One predicate, implemented
 * once — and THE CLAUSE ORDER IS THE RULE, not a style choice:
 *
 *   1. a row that carries a referent of its own is an outcome row and owes
 *      nothing, whatever its `decision` word says;
 *   2. of the rest, a lifecycle row is not a decision at all, so it owes
 *      nothing;
 *   3. a `deny` entry is terminal by itself and owes nothing;
 *   4. a `pending` entry owes one;
 *   5. an `allow` entry owes one — the `executeTool` decision written before
 *      dispatch.
 *
 * Clause 1 first is what the two rows in the write inventory turn on. The
 * spend-supersede row carries `decision: "pending"` AND a referent: under a
 * pending-first order it would owe a closer it can never receive (the same
 * transaction writes a FRESH `pending` entry for the spending hold and
 * relinks the held row to it, so every later closer names the fresh entry),
 * and would read unresolved for the life of the log. Under clause 1 it is a
 * closer of the entry below it and owes nothing itself. The ledger-failure
 * row names an OUTCOME entry; clause 1 on the referent side is what keeps
 * that outcome entry from being read as a decision that owes one.
 */
export function owesCloser(entry: ChainEntry): boolean {
  if (entry.decisionEntryId !== null) return false;
  if (LIFECYCLE_TOOLS.has(entry.toolName)) return false;
  if (entry.decision === "deny") return false;
  return entry.decision === "pending" || entry.decision === "allow";
}

/**
 * The finding, not the wording. Four members, and a surface may print more
 * words than there are members: `habenula log` splits `unresolved` into
 * `unresolved` (a decision that dispatched) and `awaiting` (a prompt still
 * open). Which case it is comes from `openKind` below — the check decides the
 * FACT, the surface picks the WORD. Adding a status member per phrasing would
 * put a rendering choice inside the pure function every surface shares;
 * leaving the fact to each surface would put `owesCloser`'s tail there
 * instead, in as many copies as there are readers.
 */
export type ClosureStatus = "clean" | "conflicted" | "unresolved" | "unchecked";

/**
 * How a conflicted decision's closers relate. `duplicated`: their `decision`
 * and `outcome` match — the one duplicate the design permits writes the same
 * `allow`/`error` twice, so calling it a contradiction would be false.
 * `contradictory`: they differ. The label reads `decision` and `outcome` and
 * nothing else: the pairs that can disagree in prose already disagree in
 * `outcome` (the expiry sweep writes `deny`/`timeout`, the cancel sweep
 * `deny`/`error`), and folding `errorMessage`/`costUsd` in would make the
 * label sensitive to prose an engine author may reword. Where a difference
 * does need to be seen, the reader shows it: both surfaces list every closer.
 */
export type CloserAgreement = "duplicated" | "contradictory";

/** Which open case an `unresolved` decision is. `dispatched`: an `allow`
 *  decision with no closer — the call ran and recorded nothing. `awaiting`: a
 *  `pending` decision with no closer — a prompt is open, the ordinary state. */
export type OpenKind = "dispatched" | "awaiting";

export interface CloserRef {
  id: string;
  epochId: string;
  sequenceNum: number;
  decision: string;
  outcome: string;
  /** The entry this row names. */
  referentId: string;
}

export interface DecisionClosure {
  id: string;
  epochId: string;
  sequenceNum: number;
  status: ClosureStatus;
  /** Present only on `conflicted`. */
  agreement?: CloserAgreement;
  /** Present only on `unresolved`. */
  openKind?: OpenKind;
  closers: CloserRef[];
}

export interface ClosureCarry {
  /** Closers from newer ranges whose referent has not yet been seen. */
  unmatchedClosers: readonly CloserRef[];
}

export interface ClosureVerdict {
  /** Decisions that owe a closer, encountered in this range. */
  decisionsChecked: number;
  conflicted: DecisionClosure[];
  unresolved: DecisionClosure[];
  unchecked: DecisionClosure[];
  /** Hand to the next (older) range. Leftovers at the end of a walk are
   *  unchecked coverage — the same story exit 4 already tells. */
  carry: ClosureCarry;
}

/**
 * Check the closure of every decision in one contiguous range.
 *
 * `entries` arrive ascending, oldest first — the same order `verifyChainRange`
 * consumes, so a walk reverses each page once and hands the same array to
 * both. The check itself walks newest to oldest: a closer is always written
 * after its decision, so walking that way a closer is seen before or with its
 * decision, never after, and the carry moves in one direction only — closers
 * whose referent did not appear in this range pass down to the next (older)
 * range via `carry`. A closer whose referent DID appear and does not owe a
 * closer (an outcome row, a lifecycle row, a `deny`) is discarded rather than
 * carried. In a healthy log a decision and its closer sit within a few rows
 * of each other, so the carry stays near-empty.
 *
 * `upperEdgeClosed` defaults to `false`: with an open upper edge every
 * decision in the range is `unchecked`, because a second closer can always
 * sit above an open edge and one range can never prove its absence. `clean`
 * requires the range to hold the decision and the upper edge to be closed.
 */
export function checkDecisionClosure(
  entries: readonly ChainEntry[],
  options?: { carry?: ClosureCarry; upperEdgeClosed?: boolean },
): ClosureVerdict {
  const upperEdgeClosed = options?.upperEdgeClosed ?? false;

  // Closers awaiting their referent, keyed by the entry they name. Seeded
  // from the carry (closers from newer ranges), in arrival order.
  const unmatched = new Map<string, CloserRef[]>();
  for (const closer of options?.carry?.unmatchedClosers ?? []) {
    const list = unmatched.get(closer.referentId);
    if (list === undefined) unmatched.set(closer.referentId, [closer]);
    else list.push(closer);
  }

  let decisionsChecked = 0;
  const conflicted: DecisionClosure[] = [];
  const unresolved: DecisionClosure[] = [];
  const unchecked: DecisionClosure[] = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as ChainEntry;
    // Resolve any closers naming THIS entry, whatever kind it is: if it owes
    // a closer they count, otherwise they are discarded (never carried).
    const closers = unmatched.get(entry.id) ?? [];
    unmatched.delete(entry.id);

    if (entry.decisionEntryId !== null) {
      // Clause 1: an outcome row, whatever its `decision` word says. It is a
      // closer of the entry it names and never a decision that owes one.
      const referentId = entry.decisionEntryId;
      const ref: CloserRef = {
        id: entry.id,
        epochId: entry.epochId,
        sequenceNum: entry.sequenceNum,
        decision: entry.decision,
        outcome: entry.outcome,
        referentId,
      };
      const list = unmatched.get(referentId);
      if (list === undefined) unmatched.set(referentId, [ref]);
      else list.push(ref);
      continue;
    }
    if (!owesCloser(entry)) continue; // lifecycle or deny: nothing owed

    decisionsChecked += 1;
    const base = {
      id: entry.id,
      epochId: entry.epochId,
      sequenceNum: entry.sequenceNum,
      closers,
    };
    if (!upperEdgeClosed) {
      unchecked.push({ ...base, status: "unchecked" });
    } else if (closers.length === 0) {
      unresolved.push({
        ...base,
        status: "unresolved",
        // Set off the same referent-free `decision` value owesCloser just
        // tested — the fact the surfaces key their wording on.
        openKind: entry.decision === "pending" ? "awaiting" : "dispatched",
      });
    } else if (closers.length >= 2) {
      const [first] = closers as [CloserRef, ...CloserRef[]];
      const agreement: CloserAgreement = closers.every(
        (c) => c.decision === first.decision && c.outcome === first.outcome,
      )
        ? "duplicated"
        : "contradictory";
      conflicted.push({ ...base, status: "conflicted", agreement });
    }
    // Exactly one closer under a closed edge: clean — counted, not listed.
  }

  // Findings oldest first, matching ChainVerdict.breaks. The walk above ran
  // newest to oldest, so each list reverses once.
  conflicted.reverse();
  unresolved.reverse();
  unchecked.reverse();

  const unmatchedClosers: CloserRef[] = [];
  for (const list of unmatched.values()) unmatchedClosers.push(...list);

  return {
    decisionsChecked,
    conflicted,
    unresolved,
    unchecked,
    carry: { unmatchedClosers },
  };
}
