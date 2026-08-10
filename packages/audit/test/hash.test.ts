// Unit suite for `wellFormed`, the write-path conditioning a writer applies
// before it both hashes and stores a value. Framing and the entry hash itself
// are covered by hash.property.test.ts next door and by the published vectors;
// this covers the one input class that has no UTF-8 encoding at all, and so
// cannot survive a text column as the bytes that were hashed.
import { describe, expect, it } from "vitest";
import { computeEntryHash, wellFormed } from "../src/hash";

const HIGH = "\ud800"; // an unpaired high surrogate
const LOW = "\udc00"; // an unpaired low surrogate
const PAIR = "😀"; // U+1F600 — a legitimate pair, must not be touched

/** What a UTF-8 text column hands back: encode, then decode. */
function utf8RoundTrip(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

describe("wellFormed", () => {
  it("replaces an unpaired high surrogate", () => {
    expect(wellFormed(`a${HIGH}b`)).toBe("a�b");
  });

  it("replaces an unpaired low surrogate", () => {
    expect(wellFormed(`a${LOW}b`)).toBe("a�b");
  });

  it("leaves a valid surrogate pair intact", () => {
    expect(wellFormed(`a${PAIR}b`)).toBe(`a${PAIR}b`);
  });

  it("returns an already-well-formed string unchanged", () => {
    // Includes the framing-adjacent shapes the property suite leans on, so a
    // future implementation that reached for a broader normalisation (case,
    // NFC, whitespace) fails here rather than silently changing hash inputs.
    for (const value of ["", "email_list_messages", "héllo", "0:", "a:b", "日本語", "GENESIS"]) {
      expect(wellFormed(value)).toBe(value);
    }
  });

  it("is idempotent", () => {
    const once = wellFormed(`${HIGH}${LOW}x`);
    expect(wellFormed(once)).toBe(once);
  });

  it("produces a string that re-reads from a UTF-8 column as itself", () => {
    // The whole point, in one assertion pair. The conditioned value survives
    // the encode/decode a text column performs; the raw value does not, which
    // is why hashing it and storing it disagree.
    const raw = `a${HIGH}b`;
    expect(utf8RoundTrip(wellFormed(raw))).toBe(wellFormed(raw));
    expect(utf8RoundTrip(raw)).not.toBe(raw);
  });

  it("changes no digest — it changes only what can be stored", () => {
    // Conditioning is invisible to the hash. `computeEntryHash` converts its
    // input to UTF-8 (both in `frameField`'s byte count and in the digest
    // itself), and that conversion already collapses an unpaired surrogate to
    // one U+FFFD — the same substitution `wellFormed` makes. So every entry
    // hashes to what it always would have.
    //
    // Which locates the defect precisely: the hash side was never the problem.
    // The text column is, because its round trip does NOT agree with UTF-8
    // conversion, and the row therefore reads back as something else. That
    // half is checked against real SQLite in the engine's audit-log suite,
    // which is the only place that can honestly claim it.
    const fields = {
      epochId: "2026-08-03",
      sequenceNum: 0,
      prevHash: "GENESIS",
      id: "entry-1",
      timestamp: "2026-08-03T00:00:00.000Z",
      userId: "u",
      agentId: "a",
      sessionId: "s",
      origin: "human",
      service: "unknown",
      verb: "execute",
      noun: "unknown",
      toolName: `a${HIGH}b`,
      parametersMetadata: "{}",
      decision: "deny",
      outcome: "error",
      errorMessage: null,
      decisionEntryId: null,
      latencyMs: 0,
      costUsd: null,
    };

    const conditioned = { ...fields, toolName: wellFormed(fields.toolName) };
    expect(computeEntryHash(conditioned)).toBe(computeEntryHash(fields));
  });
});
