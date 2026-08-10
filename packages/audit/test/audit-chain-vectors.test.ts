// Guard for the PUBLISHED test vectors: the values shipped beside
// audit-chain-format.md must keep matching the shipped implementation, or the
// published specification drifts from the code silently and a re-implementer
// inherits the drift. Recomputes every vector hash with computeEntryHash and
// runs the broken-chain vector through verifyChainRange, asserting the
// documented verdict byte for byte.
//
// The vectors live in the engine's docs tree — next to the format doc a
// re-implementer reads — and this test reaches them by relative path, so
// there is exactly one copy to drift.
import { describe, expect, it } from "vitest";
import { AUDIT_HASH_FORMAT, computeEntryHash } from "../src/hash";
import { verifyChainRange, type ChainEntry } from "../src/verify-chain";
import vectors from "../../engine/docs/architecture/audit-chain-vectors.json";

const CHAIN_ENTRY_KEYS = [
  "epochId",
  "sequenceNum",
  "prevHash",
  "id",
  "timestamp",
  "userId",
  "agentId",
  "sessionId",
  "origin",
  "service",
  "verb",
  "noun",
  "toolName",
  "parametersMetadata",
  "decision",
  "outcome",
  "errorMessage",
  "decisionEntryId",
  "latencyMs",
  "costUsd",
  "hash",
  "epochPrevHash",
] as const;

const intactEntries = vectors.intact.entries as ChainEntry[];
const brokenEntries = vectors.broken.entries as ChainEntry[];

describe("published audit-chain vectors stay true to the implementation", () => {
  it("carries the hash-format identifier the code ships", () => {
    expect(vectors.hashFormat).toBe(AUDIT_HASH_FORMAT);
  });

  it("every entry carries exactly the verifier's 22 fields", () => {
    for (const entry of [...intactEntries, ...brokenEntries]) {
      expect(Object.keys(entry).sort()).toEqual([...CHAIN_ENTRY_KEYS].sort());
    }
  });

  it("every intact vector hash recomputes with computeEntryHash", () => {
    for (const entry of intactEntries) {
      expect(computeEntryHash(entry), `entry ${entry.epochId}/${entry.sequenceNum}`).toBe(
        entry.hash,
      );
    }
  });

  it("the intact chain verifies clean, genesis-shaped, both epochs covered", () => {
    const verdict = verifyChainRange(intactEntries);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.entriesChecked).toBe(intactEntries.length);
    expect(verdict.lowerEdge).toEqual({ kind: "genesis_shaped" });
    expect(verdict.epochsCovered).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("one vector exercises the exponential-notation float hazard", () => {
    const carrier = intactEntries.find((e) => e.costUsd !== null);
    expect(carrier).toBeDefined();
    expect(String(carrier?.costUsd)).toBe("5e-7");
  });

  it("the broken chain produces exactly the documented verdict", () => {
    expect(verifyChainRange(brokenEntries)).toEqual(vectors.broken.expectedVerdict);
  });
});
