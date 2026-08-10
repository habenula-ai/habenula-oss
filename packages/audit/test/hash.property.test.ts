// Property-based security suite for the audit hash-chain primitives
// (Hard Invariant #3). Generated
// entry sequences must always verify, and any single-field tamper — content
// fields, the prev-hash link, or the stored hash itself — must break
// verification. Chain build/verify is expressed here directly over the
// primitives this package owns (frameField / computeEntryHash /
// GENESIS_SENTINEL); the persisted-chain behavior lives in the engine's
// audit-log tests.
import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { GENESIS_SENTINEL, computeEntryHash, frameField } from "../src/hash";

type EntryFields = Parameters<typeof computeEntryHash>[0];
type AuthoredFields = Omit<EntryFields, "sequenceNum" | "prevHash">;

// Fixed seed: identical generation and shrink paths on every run (see
// evaluate-policy.property.test.ts).
const PROP = { seed: 34 } as const;

// Strings lean hostile on purpose: framing characters (`:`, digits), the
// genesis sentinel, empty strings, and arbitrary unicode — the classes that
// would shift field boundaries under a naive separator encoding.
const textArb = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.constantFrom("a:b", "12:", "0:", "::", "|", GENESIS_SENTINEL, ""),
);

const authoredArb: fc.Arbitrary<AuthoredFields> = fc.record({
  epochId: textArb,
  id: textArb,
  timestamp: textArb,
  userId: textArb,
  agentId: textArb,
  sessionId: textArb,
  origin: textArb,
  service: textArb,
  verb: textArb,
  noun: textArb,
  toolName: textArb,
  parametersMetadata: textArb,
  decision: fc.constantFrom("allow", "deny", "pending"),
  outcome: fc.constantFrom("success", "failure", "held", "denied"),
  errorMessage: fc.option(textArb, { nil: null }),
  decisionEntryId: fc.option(textArb, { nil: null }),
  latencyMs: fc.integer({ min: 0, max: 1_000_000 }),
  // Doubles include the exponential-notation floats (5e-7) the frameField doc
  // calls out; null models the no-cost entries.
  costUsd: fc.option(fc.double({ noNaN: true, noDefaultInfinity: true }), { nil: null }),
});

// Named PropertyChainEntry, not ChainEntry: the package exports a ChainEntry
// (verify-chain.ts) of a different shape, and a silent shadow one directory
// away is a trap. This suite deliberately keeps its own local chain shape and
// its own verifyChain helper — it tests the primitives, not the shipped
// verifier, and the two checks stay independent.
interface PropertyChainEntry {
  fields: EntryFields;
  hash: string;
}

// Build a chain the way the audit log does: sequence numbers in order, each
// entry's prevHash carrying the prior entry's hash, genesis carrying the
// sentinel.
function buildChain(authored: AuthoredFields[]): PropertyChainEntry[] {
  let prevHash = GENESIS_SENTINEL;
  return authored.map((fields, sequenceNum) => {
    const full: EntryFields = { ...fields, sequenceNum, prevHash };
    const hash = computeEntryHash(full);
    prevHash = hash;
    return { fields: full, hash };
  });
}

// Verify the way `habenula log verify` does at the primitive level: recompute
// every entry hash from its stored fields and walk the prev-hash links from
// the genesis sentinel.
function verifyChain(chain: PropertyChainEntry[]): boolean {
  let prevHash = GENESIS_SENTINEL;
  for (const entry of chain) {
    if (entry.fields.prevHash !== prevHash) return false;
    if (computeEntryHash(entry.fields) !== entry.hash) return false;
    prevHash = entry.hash;
  }
  return true;
}

// Total modulo-indexing under noUncheckedIndexedAccess: every pick below is
// into a non-empty array, so this can only throw on a test-authoring bug.
function pick<T>(values: readonly T[], choice: number): T {
  const value = values[choice % values.length];
  if (value === undefined) throw new Error("pick() on an empty array");
  return value;
}

const FIELD_KEYS = [
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
] as const;

describe("audit hash-chain properties (Hard Invariant #3)", () => {
  test.prop([fc.array(authoredArb, { minLength: 1, maxLength: 20 })], PROP)(
    "every well-formed chain verifies",
    (authored) => {
      expect(verifyChain(buildChain(authored))).toBe(true);
    },
  );

  test.prop(
    [fc.array(authoredArb, { minLength: 1, maxLength: 12 }), fc.nat(), fc.nat(), textArb],
    PROP,
  )("any single-field tamper on any entry breaks verification", (authored, entryPick, fieldPick, replacementText) => {
    const chain = buildChain(authored);
    const index = entryPick % chain.length;
    const key = pick(FIELD_KEYS, fieldPick);
    const original = pick(chain, index).fields[key];

    let replacement: string | number;
    if (typeof original === "number") {
      replacement = original + 1;
    } else if (original === null) {
      replacement = key === "costUsd" ? 0.5 : "tampered";
    } else {
      replacement = replacementText;
    }
    // Skip no-op "tampers" that frame identically to the original (e.g. the
    // generated replacement equals the original value): nothing changed, so
    // nothing should break.
    fc.pre(frameField(replacement) !== frameField(original ?? ""));

    const tampered = chain.map((entry, i) =>
      i === index
        ? { ...entry, fields: { ...entry.fields, [key]: replacement } as EntryFields }
        : entry,
    );
    expect(verifyChain(tampered)).toBe(false);
  });

  test.prop([fc.array(authoredArb, { minLength: 1, maxLength: 12 }), fc.nat()], PROP)(
    "rewriting a stored hash breaks verification even with untouched fields",
    (authored, entryPick) => {
      const chain = buildChain(authored);
      const index = entryPick % chain.length;
      const hash = pick(chain, index).hash;
      const flipped = (hash.startsWith("0") ? "f" : "0") + hash.slice(1);
      const tampered = chain.map((entry, i) => (i === index ? { ...entry, hash: flipped } : entry));
      expect(verifyChain(tampered)).toBe(false);
    },
  );

  // The collision class: the SAME character stream split at two
  // different field boundaries ("a|b" + "c" vs "a" + "b|c"). A bare separator
  // concatenation is identical for both splits; the length prefix must
  // distinguish every split. Constructed this way the property fails
  // deterministically if the prefix is ever dropped, rather than waiting for
  // four independent strings to collide by chance.
  test.prop([fc.string({ minLength: 1, maxLength: 24 }), fc.nat(), fc.nat()], PROP)(
    "length-prefix framing distinguishes every split of the same stream",
    (stream, first, second) => {
      const splitA = first % (stream.length + 1);
      const splitB = second % (stream.length + 1);
      fc.pre(splitA !== splitB);
      const framedA =
        frameField(stream.slice(0, splitA)) + frameField(stream.slice(splitA));
      const framedB =
        frameField(stream.slice(0, splitB)) + frameField(stream.slice(splitB));
      expect(framedA).not.toBe(framedB);
    },
  );
});
