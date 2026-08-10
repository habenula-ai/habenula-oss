// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shared paged walk over `GET /api/audit` and
 * `summarizeWalk`, the ONE place the exit-code precedence for all three `log`
 * commands is decided.
 *
 * The route descends (newest first) and the verifier core ascends, so the
 * walk reverses each page and carries the previous page's oldest entry
 * forward as the next call's boundary — one page and one boundary entry in
 * memory at a time; the chain is never held whole. `log verify` runs it with
 * `verify: true`; `log dump` runs the same loop with `verify: false` and
 * writes each page through `onPage` instead of hashing it.
 */

import { verifyChainRange } from "@habenula-ai/audit/verify-chain";
import type { ChainBreak, ChainEntry, ChainVerdict } from "@habenula-ai/audit/verify-chain";
import { checkDecisionClosure } from "@habenula-ai/audit/decision-closure";
import type {
  CloserRef,
  ClosureCarry,
  ClosureVerdict,
  DecisionClosure,
} from "@habenula-ai/audit/decision-closure";
import type { ApiClient, AuditChainEntry } from "../api-client";
import { EXIT_CANCELLED } from "../commands/connect";

/** A broken chain — the verdict that warrants treating the log as an incident. */
export const EXIT_BROKEN_CHAIN = 3;
/** Every link covered is intact, but an edge of the range is unchecked. */
export const EXIT_UNCHECKED_EDGE = 4;
/**
 * A decision entry carries two or more closers — a located, positive finding
 * about the log's content, distinct from every neighbour: not `3`,
 * because a script reading every non-zero verify as mutation would read a
 * correction as an attack; not `4`, because the range WAS checked and the
 * finding is positive; not `0`, because a finding no script can see is a
 * finding nobody acts on. Unresolved decisions never reach this code — a
 * `pending` awaiting confirmation and an `allow` on the wire are both
 * healthy, so a rung keyed on them would fire from a healthy engine.
 */
export const EXIT_CONFLICTED_CLOSER = 5;

/**
 * Hard ceiling on the walk, in pages. It is a backstop for the one runaway
 * the positional stall check cannot see, never a policy limit on how much a
 * user may verify: sized against audit volume (two rows per governed action)
 * so no real user reaches it inside a retention window — 10,000 pages at the
 * 200-row server cap covers two million rows, ~6.7 years at a heavy-use
 * model. A ceiling a user can reach would turn exit 4 into the steady state
 * and drain the code of signal.
 */
export const AUDIT_MAX_PAGES = 10_000;

/**
 * The `limit` the walk requests: deliberately larger than any server cap, so
 * the DO's clamp decides the page size. Raising the cap server-side widens
 * the range a ceiling-bounded walk covers with no CLI change.
 */
const WALK_REQUEST_LIMIT = 1_000_000;

/** Why the walk stopped where it did — a property of the WALK, not of any
 * range, which is why the verifier core never reports it. */
export type WalkStopReason =
  | "exhausted" // the cursor closed: the engine handed over its oldest retained row
  | "page_ceiling" // AUDIT_MAX_PAGES reached with the cursor still open
  | "cursor_stalled" // a page failed to advance past the previous page's last row
  | "cancelled"; // the injected signal aborted at a page boundary

/** Why an edge of the aggregate range is unchecked, for the verdict text.
 * `partial_file` arises only on the `--file` path (dump.ts). */
export type UncheckedReason =
  | "page_ceiling"
  | "cursor_stalled"
  | "head_not_genesis"
  | "cancelled"
  | "partial_file";

export interface ChainLocation {
  epochId: string;
  sequenceNum: number;
}

export interface WalkResult {
  /** Per-page verdicts in walk order (newest page first); empty when
   *  `verify` is false — dump computes nothing. */
  pages: ChainVerdict[];
  /** Per-page closure verdicts, same order as `pages`; empty when `verify`
   *  is false. */
  closures: ClosureVerdict[];
  /** The closure carry left after the last page: closers whose decision the
   *  walk never reached. Leftovers are unchecked coverage. */
  closureCarry: ClosureCarry;
  entriesSeen: number;
  pagesFetched: number;
  newest: ChainLocation | null;
  oldest: ChainLocation | null;
  /** True only when the engine's cursor closed — the walk saw the oldest
   *  retained row. False on the ceiling, a stall, or a cancel. */
  cursorExhausted: boolean;
  stopReason: WalkStopReason;
}

export interface WalkOptions {
  /** Verify each page as it arrives (`log verify`) or only stream pages
   *  through `onPage` (`log dump`). */
  verify: boolean;
  /** Receives each page in the route's own order (newest first) — the order
   *  a dump file preserves. May write; a thrown error (ENOSPC) propagates. */
  onPage?: (page: readonly AuditChainEntry[]) => void | Promise<void>;
  /** Checked at page boundaries only, never mid-page — a cancelled dump
   *  closes on a whole page, at the cost of at most one page of extra work. */
  cancelSignal?: AbortSignal;
  /** Fired once, on the first page whose verdict carries a break. The only
   *  channel by which the force-exit path (index.ts) learns a break exists,
   *  because it fires while the walk is still running. */
  onBreakFound?: () => void;
  /** Fired once, on the first page whose closure verdict holds a conflict —
   *  the exact shape and position of `onBreakFound`, for the same one
   *  caller: the force-exit path cannot read the accumulated verdict. */
  onConflictFound?: () => void;
}

function location(entry: AuditChainEntry): ChainLocation {
  return { epochId: entry.epochId, sequenceNum: entry.sequenceNum };
}

/** Strict descending order on `(epochId, sequenceNum)` — the chain's own
 * total order, which is what makes the stall check positional. */
function sortsStrictlyBelow(a: AuditChainEntry, b: AuditChainEntry): boolean {
  return a.epochId < b.epochId || (a.epochId === b.epochId && a.sequenceNum < b.sequenceNum);
}

export async function walkAuditChain(
  client: ApiClient,
  options: WalkOptions,
): Promise<WalkResult> {
  const pages: ChainVerdict[] = [];
  const closures: ClosureVerdict[] = [];
  let boundary: ChainEntry | undefined;
  // The closure carry, page to page: closers whose decision sits on an older
  // page than the one that held them. Threaded here AND in dump.ts's batch
  // loop — the two loops must find the same conflicts.
  let closureCarry: ClosureCarry = { unmatchedClosers: [] };
  let previousOldest: AuditChainEntry | undefined;
  let cursor: string | null = null;
  let entriesSeen = 0;
  let pagesFetched = 0;
  let newest: ChainLocation | null = null;
  let oldest: ChainLocation | null = null;
  let breakFound = false;
  let conflictFound = false;
  let cursorExhausted = false;
  let stopReason: WalkStopReason = "exhausted";

  for (;;) {
    if (options.cancelSignal?.aborted) {
      stopReason = "cancelled";
      break;
    }
    if (pagesFetched >= AUDIT_MAX_PAGES) {
      stopReason = "page_ceiling";
      break;
    }
    const response = await client.listAuditEntries({ limit: WALK_REQUEST_LIMIT, cursor });
    const page = response.entries;
    if (page.length === 0) {
      // An empty log, or a cursor that ran out exactly on a page edge.
      cursorExhausted = response.nextCursor === null || cursorExhausted;
      break;
    }
    const first = page[0] as AuditChainEntry;
    if (previousOldest !== undefined && !sortsStrictlyBelow(first, previousOldest)) {
      // A non-advancing cursor: caught positionally on page two, so the page
      // ceiling stays a backstop for what this check cannot see. The stalled
      // page is discarded — its rows were already covered.
      stopReason = "cursor_stalled";
      break;
    }

    pagesFetched += 1;
    entriesSeen += page.length;
    if (newest === null) newest = location(first);
    const pageOldest = page[page.length - 1] as AuditChainEntry;
    oldest = location(pageOldest);

    await options.onPage?.(page);

    if (options.verify) {
      const ascending = [...page].reverse();
      const verdict = verifyChainRange(
        ascending,
        boundary !== undefined ? { boundaryEntry: boundary } : undefined,
      );
      pages.push(verdict);
      if (verdict.breaks.length > 0 && !breakFound) {
        breakFound = true;
        options.onBreakFound?.();
      }
      // The closure check rides the same ascending array. Every page's upper
      // edge is closed: page one's is the chain tip (the same fact the
      // summarizer relies on for exit 4), and every later page's newer rows
      // have all been seen — their unmet closers are in the carry.
      const closure = checkDecisionClosure(ascending, {
        carry: closureCarry,
        upperEdgeClosed: true,
      });
      closures.push(closure);
      closureCarry = closure.carry;
      if (closure.conflicted.length > 0 && !conflictFound) {
        conflictFound = true;
        options.onConflictFound?.();
      }
      boundary = pageOldest;
    }

    previousOldest = pageOldest;
    if (response.nextCursor === null) {
      cursorExhausted = true;
      break;
    }
    cursor = response.nextCursor;
  }

  return {
    pages,
    closures,
    closureCarry,
    entriesSeen,
    pagesFetched,
    newest,
    oldest,
    cursorExhausted,
    stopReason,
  };
}

export interface WalkSummaryInput {
  cursorExhausted: boolean;
  /** The walk's stop reason, or `partial_file` from the dump-file reader. */
  stopReason: WalkStopReason | "partial_file";
  /**
   * Per-page closure verdicts, newest page first — REQUIRED, not optional,
   * because an optional field lets a new caller default into "no findings"
   * silently, which is the failure this exit code exists to end. `log dump`
   * answers `[]` explicitly, the same way it already answers `[]` for pages.
   */
  closures: readonly ClosureVerdict[];
}

export interface WalkSummary {
  exitCode: number;
  /** Every break found, oldest first, across all pages. */
  breaks: ChainBreak[];
  entriesChecked: number;
  epochsCovered: string[]; // oldest first
  /** The walk closed at a genesis-shaped head — necessary for calling the
   *  oldest break "the chain's first", never proof the log begins there. */
  genesisShapedHead: boolean;
  uncheckedReasons: UncheckedReason[];
  /** Decisions carrying two or more closers, oldest first — the exit-5
   *  finding. */
  conflicted: DecisionClosure[];
  /** Decisions owing a closer with none, oldest first. Reportable text,
   *  never a rung: an open prompt and a call on the wire are both healthy. */
  unresolved: DecisionClosure[];
  /** Closers whose decision the walk never reached (the final carry) —
   *  unchecked coverage, the same story exit 4 tells. */
  uncheckedClosures: CloserRef[];
}

/**
 * Aggregate the per-page verdicts into the command verdict — the only place
 * the exit-code precedence is decided, for all three commands. The ladder,
 * explicit rather than left to fall out of a chain of `if`s:
 *
 *   breaks.length > 0                         → 3
 *   else conflicted.length > 0                → 5
 *   else stopReason === "cancelled"           → 130
 *   else !cursorExhausted                     → 4
 *   else a page verdict has an unchecked edge → 4
 *   else                                      → 0
 *
 * Breaks outrank cancel deliberately: cancel withdraws a coverage claim, not
 * a finding — a located break stays true however the walk ended. `5` sits
 * above `130` and `4` for the same reason: a located conflict stays true
 * however the walk ended. `3` sits above `5` because integrity outranks
 * semantics — on a mutated chain the closure findings are readings of rows
 * that cannot be trusted. Cancel never yields 4, because a boundary the user
 * chose to leave unchecked is not a finding about the chain. The two 4 rungs
 * are separate because `log dump` hands this an EMPTY pages array (it
 * verifies nothing) and reaches only the first — a ladder written over
 * verdicts alone would return 0 from a ceiling-stopped dump, a partial file
 * reported as whole.
 *
 * Only the LAST page's lower edge decides closure — every earlier page's
 * lower edge was closed by the call after it. And page one's absent upper
 * edge is the chain tip (on the wire because the engine was asked for the
 * newest page; in a file because the first data line is the tip), so it never
 * counts as unchecked — getting that wrong yields a command that returns 4
 * forever.
 *
 * This precedence is written a SECOND time in index.ts's SIGINT handler,
 * which cannot call this function; a change to the ladder changes both.
 */
export function summarizeWalk(
  pages: readonly ChainVerdict[],
  input: WalkSummaryInput,
): WalkSummary {
  const oldestFirst = [...pages].reverse();
  const breaks = oldestFirst.flatMap((page) => page.breaks);
  const entriesChecked = pages.reduce((sum, page) => sum + page.entriesChecked, 0);
  const epochsCovered = oldestFirst
    .flatMap((page) => page.epochsCovered)
    .filter((epoch, i, all) => all.indexOf(epoch) === i);
  const closuresOldestFirst = [...input.closures].reverse();
  const conflicted = closuresOldestFirst.flatMap((verdict) => verdict.conflicted);
  const unresolved = closuresOldestFirst.flatMap((verdict) => verdict.unresolved);
  // The LAST verdict (the oldest page checked) holds the walk's final carry:
  // closers whose decision was never reached.
  const finalClosure = input.closures[input.closures.length - 1];
  const uncheckedClosures = [...(finalClosure?.carry.unmatchedClosers ?? [])];

  const lastPage = pages[pages.length - 1];
  const genesisShapedHead = lastPage !== undefined && lastPage.lowerEdge.kind === "genesis_shaped";
  const headUnchecked = lastPage !== undefined && lastPage.lowerEdge.kind === "unchecked";

  const uncheckedReasons: UncheckedReason[] = [];
  if (input.stopReason === "page_ceiling" || input.stopReason === "cursor_stalled") {
    uncheckedReasons.push(input.stopReason);
  } else if (input.stopReason === "cancelled") {
    uncheckedReasons.push("cancelled");
  } else if (input.stopReason === "partial_file") {
    uncheckedReasons.push("partial_file");
  } else if (headUnchecked) {
    // The cursor closed but the head is not genesis-shaped: a pruned or
    // bounded head. [deferred: key a retention-aware verdict off
    // `head_not_genesis` once retention and R2 archival land]
    uncheckedReasons.push("head_not_genesis");
  }

  let exitCode: number;
  if (breaks.length > 0) {
    exitCode = EXIT_BROKEN_CHAIN;
  } else if (conflicted.length > 0) {
    exitCode = EXIT_CONFLICTED_CLOSER;
  } else if (input.stopReason === "cancelled") {
    exitCode = EXIT_CANCELLED;
  } else if (!input.cursorExhausted) {
    exitCode = EXIT_UNCHECKED_EDGE;
  } else if (headUnchecked || input.stopReason === "partial_file") {
    exitCode = EXIT_UNCHECKED_EDGE;
  } else {
    exitCode = 0;
  }

  return {
    exitCode,
    breaks,
    entriesChecked,
    epochsCovered,
    genesisShapedHead,
    uncheckedReasons,
    conflicted,
    unresolved,
    uncheckedClosures,
  };
}
