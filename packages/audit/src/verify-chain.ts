//! SPDX-FileCopyrightText: 2026 Habenula, Inc.
//! SPDX-License-Identifier: MIT

// The canonical audit-chain verifier core: ordered entries in, a located
// verdict out. Pure by the same discipline evaluate-policy.ts holds in
// @habenula-ai/governance — no I/O, no logging, no clock, no timers (a per-file
// eslint block enforces it; see eslint.config.mjs). It imports ./hash only, and
// so reaches node:crypto transitively — that is the point rather than a leak:
// recomputing a stored hash means calling the function that wrote it. The
// dependency is inherited, not held.
//
// The published specification of the format this verifies — field order,
// framing, serialization rules, link kinds, and the positional rules — is
// docs/architecture/audit-chain-format.md in the engine docs, with test vectors
// beside it. This module and that document must agree; audit-chain-vectors.test.ts
// recomputes the published vectors against both.

import { GENESIS_SENTINEL, computeEntryHash, type EntryHashFields } from "./hash.js";

/**
 * One audit row as a verifier consumes it: the 20 hashed fields plus the two
 * excluded columns a verifier needs — the stored `hash` to compare a
 * recomputation against, and `epochPrevHash` for the cross-epoch link.
 * Extending the hash input (EntryHashFields) therefore forces this shape to
 * grow with it.
 */
export type ChainEntry = EntryHashFields & {
  hash: string;
  epochPrevHash: string | null;
};

// Two edge types, not one shared union: `genesis_shaped` is a lower-edge state
// and an upper edge can never hold it. One union would make that state
// representable and force every reader to handle a case that cannot occur.
//
// The `unchecked` location fields name the entry at that edge; they are absent
// only on an empty range, which has no entry to name. `closed` on the lower
// edge is never produced by verifyChainRange itself — it exists for callers
// aggregating per-page verdicts, where the next page's call is what closes a
// page's lower edge.
export type LowerEdge =
  | { kind: "closed" }
  | { kind: "genesis_shaped" }
  | { kind: "unchecked"; epochId?: string; sequenceNum?: number };

export type UpperEdge =
  | { kind: "closed" }
  | { kind: "unchecked"; epochId?: string; sequenceNum?: number };

export type BreakKind =
  | "entry_hash" // recomputed hash ≠ stored hash — the row was mutated
  | "prev_hash" // prev_hash ≠ predecessor's stored hash
  | "genesis_sentinel" // an epoch's first row does not carry GENESIS_SENTINEL
  | "epoch_link" // genesis epoch_prev_hash ≠ prior epoch's final hash
  | "epoch_link_null"; // genesis epoch_prev_hash is null with a predecessor present

export interface ChainBreak {
  kind: BreakKind;
  epochId: string;
  sequenceNum: number;
  /** What the chain says the value should be; null when the reference row is
   *  absent from the input and no expectation can be computed. */
  expected: string | null;
  /** What is stored at this point; null when the stored value is null. */
  actual: string | null;
  /** True when sequence_num is discontinuous at this point: a row is missing
   *  rather than mutated. It never says why the row is absent. */
  rowsMissing: boolean;
}

export interface ChainVerdict {
  entriesChecked: number;
  epochsCovered: string[]; // oldest first
  lowerEdge: LowerEdge;
  upperEdge: UpperEdge;
  breaks: ChainBreak[]; // oldest first
}

/**
 * Verify one contiguous range of the audit chain.
 *
 * `entries` arrive in ascending chain order — `epochId` then `sequenceNum`,
 * oldest first: the direction the chain is written in, whatever direction the
 * transport delivered it. `boundaryEntry` is the entry that FOLLOWS the
 * range's newest, carried over from the page checked before it; given one,
 * the upper seam is closed against it. The verdict names the entries and
 * epochs covered, the state of each edge, and every break found, oldest
 * first — the walk is single-pass and does not stop at the first break, so
 * the verdict carries the extent of the damage rather than only its newest
 * edge.
 *
 * The core reports THAT an edge is unchecked and never WHY — stop reasons
 * (page ceiling, cancellation, a pruned head) are properties of a walk, not
 * of a range, and live with the caller.
 */
export function verifyChainRange(
  entries: readonly ChainEntry[],
  options?: { boundaryEntry?: ChainEntry },
): ChainVerdict {
  const breaks: ChainBreak[] = [];
  const epochsCovered: string[] = [];

  if (entries.length === 0) {
    return {
      entriesChecked: 0,
      epochsCovered,
      lowerEdge: { kind: "unchecked" },
      upperEdge: { kind: "unchecked" },
      breaks,
    };
  }

  const oldest = entries[0] as ChainEntry;

  // The range's lower edge: its predecessor is by definition not in the
  // input, so it is never a break. A sequenceNum-0 row with a null
  // epochPrevHash is genesis-SHAPED — the shape prefix truncation also leaves
  // behind, so it bounds the range without proving the log begins here.
  // Anything else is an unchecked edge.
  const lowerEdge: LowerEdge =
    oldest.sequenceNum === 0 && oldest.epochPrevHash === null
      ? { kind: "genesis_shaped" }
      : { kind: "unchecked", epochId: oldest.epochId, sequenceNum: oldest.sequenceNum };

  let prev: ChainEntry | undefined;
  for (const entry of entries) {
    if (epochsCovered[epochsCovered.length - 1] !== entry.epochId) {
      epochsCovered.push(entry.epochId);
    }

    // Rule 1 — recompute the entry hash from the stored fields.
    const recomputed = computeEntryHash(entry);
    if (recomputed !== entry.hash) {
      breaks.push({
        kind: "entry_hash",
        epochId: entry.epochId,
        sequenceNum: entry.sequenceNum,
        expected: recomputed,
        actual: entry.hash,
        rowsMissing: false,
      });
    }

    // Rule 2 — the intra-epoch link and the genesis sentinel. A genesis row
    // is a sequenceNum-0 row wherever it sits in the range; the sentinel is
    // part of its hashed content, so this is a positional check on the same
    // row, not a link to a predecessor.
    if (entry.sequenceNum === 0) {
      if (entry.prevHash !== GENESIS_SENTINEL) {
        breaks.push({
          kind: "genesis_sentinel",
          epochId: entry.epochId,
          sequenceNum: entry.sequenceNum,
          expected: GENESIS_SENTINEL,
          actual: entry.prevHash,
          rowsMissing: false,
        });
      }
    }

    if (prev !== undefined) {
      if (prev.epochId === entry.epochId) {
        // Within an epoch: the link must hold, and a sequence discontinuity
        // across the same point classifies the break as a missing row rather
        // than a mutated one. The classification never says WHY the row is
        // absent — a dropped page and a deleted row are observationally
        // identical.
        const gap = prev.sequenceNum + 1 !== entry.sequenceNum;
        if (entry.sequenceNum !== 0 && entry.prevHash !== prev.hash) {
          breaks.push({
            kind: "prev_hash",
            epochId: entry.epochId,
            sequenceNum: entry.sequenceNum,
            expected: prev.hash,
            actual: entry.prevHash,
            rowsMissing: gap,
          });
        }
      } else if (entry.sequenceNum === 0) {
        // Rule 3 — the cross-epoch link, on a genesis whose predecessor epoch
        // is present in the input. The reference value is the predecessor
        // epoch's final IN-INPUT hash; a row missing at that epoch's tail
        // surfaces here as an epoch_link mismatch. A null link with a
        // predecessor present is its own kind: the column sits outside the
        // entry hash, so one nulled cell would otherwise sever history
        // without breaking a single hash.
        if (entry.epochPrevHash === null) {
          breaks.push({
            kind: "epoch_link_null",
            epochId: entry.epochId,
            sequenceNum: entry.sequenceNum,
            expected: prev.hash,
            actual: null,
            rowsMissing: false,
          });
        } else if (entry.epochPrevHash !== prev.hash) {
          breaks.push({
            kind: "epoch_link",
            epochId: entry.epochId,
            sequenceNum: entry.sequenceNum,
            expected: prev.hash,
            actual: entry.epochPrevHash,
            rowsMissing: false,
          });
        }
      } else {
        // An epoch that opens mid-sequence with an earlier epoch present:
        // rows 0..sequenceNum-1 of this epoch are absent from the input.
        // There is no reference hash to expect — the predecessor row was
        // never handed to the function.
        breaks.push({
          kind: "prev_hash",
          epochId: entry.epochId,
          sequenceNum: entry.sequenceNum,
          expected: null,
          actual: entry.prevHash,
          rowsMissing: true,
        });
      }
    }

    prev = entry;
  }

  const newest = prev as ChainEntry;

  // The upper seam. The boundary entry's own hash was recomputed when its own
  // page was verified; here it only closes the seam. `closed` means the seam
  // was CHECKED — a seam break is reported in `breaks`, not by reopening the
  // edge.
  let upperEdge: UpperEdge;
  if (options?.boundaryEntry !== undefined) {
    const boundary = options.boundaryEntry;
    if (boundary.epochId === newest.epochId) {
      const gap = newest.sequenceNum + 1 !== boundary.sequenceNum;
      if (boundary.prevHash !== newest.hash) {
        breaks.push({
          kind: "prev_hash",
          epochId: boundary.epochId,
          sequenceNum: boundary.sequenceNum,
          expected: newest.hash,
          actual: boundary.prevHash,
          rowsMissing: gap,
        });
      }
    } else if (boundary.sequenceNum === 0) {
      if (boundary.epochPrevHash === null) {
        breaks.push({
          kind: "epoch_link_null",
          epochId: boundary.epochId,
          sequenceNum: boundary.sequenceNum,
          expected: newest.hash,
          actual: null,
          rowsMissing: false,
        });
      } else if (boundary.epochPrevHash !== newest.hash) {
        breaks.push({
          kind: "epoch_link",
          epochId: boundary.epochId,
          sequenceNum: boundary.sequenceNum,
          expected: newest.hash,
          actual: boundary.epochPrevHash,
          rowsMissing: false,
        });
      }
    } else {
      // The boundary opens its epoch mid-sequence: rows are missing between
      // the range's newest entry and the boundary.
      breaks.push({
        kind: "prev_hash",
        epochId: boundary.epochId,
        sequenceNum: boundary.sequenceNum,
        expected: null,
        actual: boundary.prevHash,
        rowsMissing: true,
      });
    }
    upperEdge = { kind: "closed" };
  } else {
    upperEdge = { kind: "unchecked", epochId: newest.epochId, sequenceNum: newest.sequenceNum };
  }

  return {
    entriesChecked: entries.length,
    epochsCovered,
    lowerEdge,
    upperEdge,
    breaks,
  };
}
