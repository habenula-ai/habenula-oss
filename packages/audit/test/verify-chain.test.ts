// Behavioral suite for the canonical chain verifier core (verifyChainRange).
// Covers intact single- and multi-epoch ranges, each break kind with its
// expected location, the two positional rules the published format doc
// states (a null epoch link is a break only where a predecessor epoch is
// present; an absent predecessor is a range boundary, never a break),
// boundary-entry seam closure, seam-straddling gaps, and the empty range.
// The property suite in hash.property.test.ts keeps its own local chain
// helper on purpose: it tests the primitives, this suite tests the shipped
// verifier.
import { describe, expect, it } from "vitest";
import { GENESIS_SENTINEL, computeEntryHash, type EntryHashFields } from "../src/hash";
import { verifyChainRange, type ChainEntry } from "../src/verify-chain";

type Authored = Omit<EntryHashFields, "epochId" | "sequenceNum" | "prevHash">;

function authored(n: number): Authored {
  return {
    id: `entry-${String(n).padStart(4, "0")}`,
    timestamp: `2026-07-01T09:${String(n % 60).padStart(2, "0")}:00.000Z`,
    userId: "user-1",
    agentId: "agent-mail",
    sessionId: "session-1",
    origin: "human",
    service: "gmail",
    verb: "read",
    noun: "messages",
    toolName: "gmail_list_messages",
    parametersMetadata: '{"maxResults":{"type":"number"}}',
    decision: "allow",
    outcome: n % 2 === 0 ? "success" : "held",
    errorMessage: null,
    decisionEntryId: null,
    latencyMs: 40 + n,
    // Exercises the exponential-notation float the format doc calls out.
    costUsd: n % 3 === 0 ? 5e-7 : null,
  };
}

interface EpochSpec {
  epochId: string;
  count: number;
  /** Override the genesis row's prev_hash (default GENESIS_SENTINEL). The
   *  hash is computed over the override, so the tamper is isolated to the
   *  sentinel rule rather than also breaking the entry hash. */
  genesisPrevHash?: string;
}

// Build a chain the way the audit log writes one: sequence numbers from 0 per
// epoch, prev_hash carrying the prior entry's hash, each epoch's genesis
// carrying the prior epoch's final hash in epoch_prev_hash (null for the
// log's first epoch, or `priorEpochFinalHash` for a chain that models a
// bounded range).
function buildEpochs(
  spec: EpochSpec[],
  options?: { priorEpochFinalHash?: string | null },
): ChainEntry[] {
  const out: ChainEntry[] = [];
  let lastEpochFinalHash: string | null = options?.priorEpochFinalHash ?? null;
  let n = 0;
  for (const { epochId, count, genesisPrevHash } of spec) {
    let prevHash = genesisPrevHash ?? GENESIS_SENTINEL;
    for (let sequenceNum = 0; sequenceNum < count; sequenceNum++) {
      const fields: EntryHashFields = { ...authored(n++), epochId, sequenceNum, prevHash };
      const hash = computeEntryHash(fields);
      out.push({ ...fields, hash, epochPrevHash: sequenceNum === 0 ? lastEpochFinalHash : null });
      prevHash = hash;
    }
    lastEpochFinalHash = prevHash;
  }
  return out;
}

function at(entries: readonly ChainEntry[], index: number): ChainEntry {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`no entry at index ${index}`);
  return entry;
}

describe("verifyChainRange — intact ranges", () => {
  it("verifies an intact single-epoch range ending genesis-shaped", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 4 }]);
    const verdict = verifyChainRange(chain);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.entriesChecked).toBe(4);
    expect(verdict.epochsCovered).toEqual(["2026-07-01"]);
    expect(verdict.lowerEdge).toEqual({ kind: "genesis_shaped" });
    expect(verdict.upperEdge).toEqual({
      kind: "unchecked",
      epochId: "2026-07-01",
      sequenceNum: 3,
    });
  });

  it("verifies an intact multi-epoch range, epochs covered oldest first", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
      { epochId: "2026-07-03", count: 3 },
    ]);
    const verdict = verifyChainRange(chain);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.entriesChecked).toBe(8);
    expect(verdict.epochsCovered).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(verdict.lowerEdge).toEqual({ kind: "genesis_shaped" });
  });

  it("returns the empty verdict on an empty range", () => {
    const verdict = verifyChainRange([]);
    expect(verdict).toEqual({
      entriesChecked: 0,
      epochsCovered: [],
      lowerEdge: { kind: "unchecked" },
      upperEdge: { kind: "unchecked" },
      breaks: [],
    });
  });
});

describe("verifyChainRange — break kinds and locations", () => {
  it("reports a mutated field as entry_hash at the mutated row, and only there", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 4 }]);
    const victim = at(chain, 2);
    const tampered = chain.map((e, i) => (i === 2 ? { ...e, noun: "drafts" } : e));
    const verdict = verifyChainRange(tampered);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("entry_hash");
    expect(brk.epochId).toBe("2026-07-01");
    expect(brk.sequenceNum).toBe(2);
    expect(brk.actual).toBe(victim.hash);
    expect(brk.expected).toBe(computeEntryHash({ ...victim, noun: "drafts" }));
    expect(brk.rowsMissing).toBe(false);
  });

  it("reports a rewritten stored hash as entry_hash there plus prev_hash at the successor", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 4 }]);
    const tampered = chain.map((e, i) => (i === 1 ? { ...e, hash: "0".repeat(64) } : e));
    const verdict = verifyChainRange(tampered);
    expect(verdict.breaks.map((b) => [b.kind, b.sequenceNum])).toEqual([
      ["entry_hash", 1],
      ["prev_hash", 2],
    ]);
    const seam = verdict.breaks[1]!;
    expect(seam.expected).toBe("0".repeat(64));
    expect(seam.actual).toBe(at(chain, 1).hash);
    expect(seam.rowsMissing).toBe(false);
  });

  it("classifies a deleted interior row as prev_hash with rowsMissing", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 5 }]);
    const withoutRow2 = chain.filter((e) => e.sequenceNum !== 2);
    const verdict = verifyChainRange(withoutRow2);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("prev_hash");
    expect(brk.sequenceNum).toBe(3);
    expect(brk.expected).toBe(at(chain, 1).hash);
    expect(brk.actual).toBe(at(chain, 2).hash);
    expect(brk.rowsMissing).toBe(true);
  });

  it("reports a genesis row without the sentinel as genesis_sentinel", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 2 },
      { epochId: "2026-07-02", count: 2, genesisPrevHash: "NOT_GENESIS" },
    ]);
    const verdict = verifyChainRange(chain);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("genesis_sentinel");
    expect(brk.epochId).toBe("2026-07-02");
    expect(brk.sequenceNum).toBe(0);
    expect(brk.expected).toBe(GENESIS_SENTINEL);
    expect(brk.actual).toBe("NOT_GENESIS");
  });

  it("reports a tampered epoch link as epoch_link — no entry hash breaks, the column is outside the hash", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
    ]);
    const tampered = chain.map((e) =>
      e.epochId === "2026-07-02" && e.sequenceNum === 0 ? { ...e, epochPrevHash: "f".repeat(64) } : e,
    );
    const verdict = verifyChainRange(tampered);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("epoch_link");
    expect(brk.epochId).toBe("2026-07-02");
    expect(brk.sequenceNum).toBe(0);
    expect(brk.expected).toBe(at(chain, 2).hash);
    expect(brk.actual).toBe("f".repeat(64));
  });

  it("reports a nulled epoch link as epoch_link_null when the predecessor epoch is present", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
    ]);
    const tampered = chain.map((e) =>
      e.epochId === "2026-07-02" && e.sequenceNum === 0 ? { ...e, epochPrevHash: null } : e,
    );
    const verdict = verifyChainRange(tampered);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("epoch_link_null");
    expect(brk.expected).toBe(at(chain, 2).hash);
    expect(brk.actual).toBeNull();
  });

  it("reports a missing whole epoch as a cross-epoch break at the next epoch's genesis", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 2 },
      { epochId: "2026-07-02", count: 2 },
      { epochId: "2026-07-03", count: 2 },
    ]);
    const withoutMiddleEpoch = chain.filter((e) => e.epochId !== "2026-07-02");
    const verdict = verifyChainRange(withoutMiddleEpoch);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("epoch_link");
    expect(brk.epochId).toBe("2026-07-03");
    expect(brk.expected).toBe(at(chain, 1).hash);
    expect(brk.actual).toBe(at(chain, 3).hash);
  });

  it("reports an epoch whose genesis is missing as prev_hash with rowsMissing and no expectation", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 2 },
      { epochId: "2026-07-02", count: 3 },
    ]);
    const withoutGenesis = chain.filter(
      (e) => !(e.epochId === "2026-07-02" && e.sequenceNum === 0),
    );
    const verdict = verifyChainRange(withoutGenesis);
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("prev_hash");
    expect(brk.epochId).toBe("2026-07-02");
    expect(brk.sequenceNum).toBe(1);
    expect(brk.expected).toBeNull();
    expect(brk.actual).toBe(at(chain, 2).hash);
    expect(brk.rowsMissing).toBe(true);
  });

  it("does not stop at the first break: every break is reported, oldest first", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 3 },
    ]);
    const tampered = chain.map((e) => {
      if (e.epochId === "2026-07-01" && e.sequenceNum === 1) return { ...e, verb: "send" };
      if (e.epochId === "2026-07-02" && e.sequenceNum === 2) return { ...e, latencyMs: 9999 };
      return e;
    });
    const verdict = verifyChainRange(tampered);
    expect(verdict.breaks.map((b) => [b.kind, b.epochId, b.sequenceNum])).toEqual([
      ["entry_hash", "2026-07-01", 1],
      ["entry_hash", "2026-07-02", 2],
    ]);
  });
});

describe("verifyChainRange — positional rules at the lower edge", () => {
  it("accepts a null epoch link on the range's oldest genesis as genesis-shaped, never a break", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 2 }]);
    const verdict = verifyChainRange(chain);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.lowerEdge).toEqual({ kind: "genesis_shaped" });
  });

  it("reports a real epoch link on the range's oldest genesis as an unchecked edge, never a break", () => {
    // Models a bounded or post-retention range: the oldest epoch in the input
    // links to a predecessor the verifier was never handed.
    const chain = buildEpochs([{ epochId: "2026-07-02", count: 3 }], {
      priorEpochFinalHash: "a".repeat(64),
    });
    const verdict = verifyChainRange(chain);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.lowerEdge).toEqual({
      kind: "unchecked",
      epochId: "2026-07-02",
      sequenceNum: 0,
    });
  });

  it("reports a mid-epoch range start as an unchecked edge, never a break", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 5 }]);
    const verdict = verifyChainRange(chain.slice(2));
    expect(verdict.breaks).toEqual([]);
    expect(verdict.lowerEdge).toEqual({
      kind: "unchecked",
      epochId: "2026-07-01",
      sequenceNum: 2,
    });
  });
});

describe("verifyChainRange — boundary entry and the page seam", () => {
  it("closes the seam against a same-epoch boundary entry", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 6 }]);
    const olderPage = chain.slice(0, 3);
    const boundary = at(chain, 3); // the entry that follows the range's newest
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks).toEqual([]);
    expect(verdict.upperEdge).toEqual({ kind: "closed" });
  });

  it("closes the seam against a boundary entry that opens the next epoch", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
    ]);
    const olderPage = chain.slice(0, 3); // exactly epoch 1
    const boundary = at(chain, 3); // epoch 2's genesis
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks).toEqual([]);
    expect(verdict.upperEdge).toEqual({ kind: "closed" });
  });

  it("reports a seam mismatch as prev_hash at the boundary entry, edge still closed", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 6 }]);
    const olderPage = chain.slice(0, 3);
    const boundary = { ...at(chain, 3), prevHash: "b".repeat(64) };
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("prev_hash");
    expect(brk.sequenceNum).toBe(3);
    expect(brk.expected).toBe(at(chain, 2).hash);
    expect(brk.actual).toBe("b".repeat(64));
    expect(brk.rowsMissing).toBe(false);
    expect(verdict.upperEdge).toEqual({ kind: "closed" });
  });

  it("catches a row missing at the page seam: the gap check spans the boundary", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 6 }]);
    const olderPage = chain.slice(0, 3); // newest is sequence 2
    const boundary = at(chain, 4); // sequence 4 — row 3 is missing at the seam
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("prev_hash");
    expect(brk.sequenceNum).toBe(4);
    expect(brk.expected).toBe(at(chain, 2).hash);
    expect(brk.actual).toBe(at(chain, 3).hash);
    expect(brk.rowsMissing).toBe(true);
  });

  it("reports an epoch-link break at a boundary that opens the next epoch with a bad link", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
    ]);
    const olderPage = chain.slice(0, 3);
    const boundary = { ...at(chain, 3), epochPrevHash: "c".repeat(64) };
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks.map((b) => b.kind)).toEqual(["epoch_link"]);
    expect(verdict.upperEdge).toEqual({ kind: "closed" });
  });

  it("reports a boundary that opens its epoch mid-sequence as rows missing at the seam", () => {
    const chain = buildEpochs([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 3 },
    ]);
    const olderPage = chain.slice(0, 3); // exactly epoch 1
    const boundary = at(chain, 4); // epoch 2, sequence 1 — its genesis is missing
    const verdict = verifyChainRange(olderPage, { boundaryEntry: boundary });
    expect(verdict.breaks).toHaveLength(1);
    const brk = verdict.breaks[0]!;
    expect(brk.kind).toBe("prev_hash");
    expect(brk.epochId).toBe("2026-07-02");
    expect(brk.sequenceNum).toBe(1);
    expect(brk.expected).toBeNull();
    expect(brk.rowsMissing).toBe(true);
  });

  it("leaves the upper edge unchecked without a boundary entry", () => {
    const chain = buildEpochs([{ epochId: "2026-07-01", count: 2 }]);
    const verdict = verifyChainRange(chain);
    expect(verdict.upperEdge).toEqual({
      kind: "unchecked",
      epochId: "2026-07-01",
      sequenceNum: 1,
    });
  });
});
