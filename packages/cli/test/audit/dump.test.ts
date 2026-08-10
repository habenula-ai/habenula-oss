import { describe, expect, it } from "vitest";
import {
  DUMP_FORMAT_VERSION,
  DumpFileError,
  READ_BATCH_SIZE,
  dumpEntryLine,
  dumpManifestLine,
  readChainEntryLine,
  verifyDumpLines,
} from "../../src/audit/dump";
import {
  summarizeWalk,
  EXIT_CONFLICTED_CLOSER,
  EXIT_UNCHECKED_EDGE,
} from "../../src/audit/walk";
import { buildWireChain, descending } from "../helpers/audit-chain";
import type { AuditChainEntry } from "../../src/api-client";

async function* stream(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

/** Yield lines, aborting the controller just before line index `n` — a
 * Ctrl-C landing mid-read. */
async function* abortAfter(
  lines: string[],
  n: number,
  controller: AbortController,
): AsyncIterable<string> {
  for (const [i, line] of lines.entries()) {
    if (i === n) controller.abort();
    yield line;
  }
}

function dumpLines(entries: AuditChainEntry[]): string[] {
  return [dumpManifestLine(), ...entries.map((e) => dumpEntryLine(e))];
}

describe("dump round trip", () => {
  it("a written dump verifies clean back through the reader", async () => {
    const chain = buildWireChain([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 2 },
    ]);
    const result = await verifyDumpLines(stream(dumpLines(descending(chain))));

    expect(result.stopReason).toBe("exhausted");
    expect(result.entriesSeen).toBe(5);
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
    expect(result.newest).toEqual({ epochId: "2026-07-02", sequenceNum: 1 });
    expect(result.oldest).toEqual({ epochId: "2026-07-01", sequenceNum: 0 });
    const summary = summarizeWalk(result.pages, {
      cursorExhausted: true,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(summary.exitCode).toBe(0);
    expect(summary.genesisShapedHead).toBe(true);
  });

  it("spans multiple reader batches with the boundary carried across each seam", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: READ_BATCH_SIZE + 50 }]);
    const result = await verifyDumpLines(stream(dumpLines(descending(chain))));
    expect(result.pages).toHaveLength(2);
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
    expect(
      summarizeWalk(result.pages, {
        cursorExhausted: true,
        stopReason: result.stopReason,
        closures: result.closures,
      }).exitCode,
    ).toBe(0);
  });

  it("preserves null distinctly from empty string through the line format", async () => {
    // Both frame identically INSIDE the hash (`0:`), so only the JSON round
    // trip can corrupt them — a reader that coerced one into the other, or
    // null into the string "null", would still verify here but fail the
    // field-identity assertions.
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 2 }], {
      override: (_e, seq, fields) => ({
        ...fields,
        errorMessage: seq === 0 ? null : "",
      }),
    });
    const lines = descending(chain).map((e) => dumpEntryLine(e));
    const newest = readChainEntryLine(lines[0] as string);
    const genesis = readChainEntryLine(lines[1] as string);
    expect(newest?.errorMessage).toBe("");
    expect(genesis?.errorMessage).toBeNull();

    const result = await verifyDumpLines(stream([dumpManifestLine(), ...lines]));
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
  });

  it("a mid-stream cancel keeps every batch and partial batch already read", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: READ_BATCH_SIZE + 50 }]);
    const controller = new AbortController();
    // Abort while the second (partial) batch is filling: manifest is line 0,
    // so READ_BATCH_SIZE + 10 lines in means one full batch plus 9 entries.
    const result = await verifyDumpLines(
      abortAfter(dumpLines(descending(chain)), READ_BATCH_SIZE + 10, controller),
      { cancelSignal: controller.signal },
    );
    expect(result.stopReason).toBe("cancelled");
    expect(result.pages).toHaveLength(2); // the full batch AND the partial one keep their verdicts
    expect(result.entriesSeen).toBe(READ_BATCH_SIZE + 9);
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
  });

  it("a cancel is observed on a file smaller than one batch — never a silent complete", async () => {
    // The check runs per line, like the wire walk's per-pass check: a
    // batch-boundary-only check would let a sub-batch file run to completion
    // and report a whole walk (exit 0) where the wire walk reports 130.
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 5 }]);
    const controller = new AbortController();
    const result = await verifyDumpLines(
      abortAfter(dumpLines(descending(chain)), 3, controller), // manifest + 2 entries read
      { cancelSignal: controller.signal },
    );
    expect(result.stopReason).toBe("cancelled");
    expect(result.entriesSeen).toBe(2);
    expect(result.pages).toHaveLength(1); // the partial batch was verified, not discarded
  });
});

describe("the file-path closure carry — the loop the runbook reader uses", () => {
  /** A chain whose genesis decision carries two contradictory closers at the
   * given sequence numbers. */
  function conflictedChain(count: number, closerSeqs: [number, number]): AuditChainEntry[] {
    return buildWireChain([{ epochId: "2026-07-01", count }], {
      override: (_epoch, seq, fields) =>
        seq === closerSeqs[0]
          ? { ...fields, decisionEntryId: "entry-00000" }
          : seq === closerSeqs[1]
            ? { ...fields, decision: "deny", outcome: "timeout", decisionEntryId: "entry-00000" }
            : fields,
    });
  }

  it("the same conflict read from a dump file returns 5, not 0", async () => {
    const chain = conflictedChain(4, [2, 3]);
    let fired = 0;
    const result = await verifyDumpLines(stream(dumpLines(descending(chain))), {
      onConflictFound: () => {
        fired += 1;
      },
    });
    const summary = summarizeWalk(result.pages, {
      cursorExhausted: true,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
    expect(summary.conflicted).toHaveLength(1);
    expect(summary.conflicted[0]!.id).toBe("entry-00000");
    expect(fired).toBe(1); // on the batch that holds the conflict
  });

  it("a conflict straddling a READ_BATCH_SIZE edge is still found — the carry closes the seam", async () => {
    // The decision is the genesis entry; its closers are the two NEWEST
    // entries. With count > READ_BATCH_SIZE the closers land in batch one and
    // the decision in batch two, so only the carry connects them.
    const count = READ_BATCH_SIZE + 50;
    const chain = conflictedChain(count, [count - 2, count - 1]);
    const result = await verifyDumpLines(stream(dumpLines(descending(chain))));
    expect(result.pages).toHaveLength(2);
    const summary = summarizeWalk(result.pages, {
      cursorExhausted: true,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
    expect(summary.conflicted[0]!.id).toBe("entry-00000");
    expect(result.closureCarry.unmatchedClosers).toEqual([]);
  });

  it("a truncated file keeps its partial_file exit 4, and the torn-off closer stays unmatched", async () => {
    // Tear the FINAL line — the genesis decision itself. Its closers are now
    // closers of an entry the file no longer holds: unchecked coverage, the
    // same story partial_file's exit 4 tells.
    const chain = conflictedChain(4, [2, 3]);
    const lines = dumpLines(descending(chain));
    const torn = (lines[lines.length - 1] as string).slice(0, 20);
    const result = await verifyDumpLines(stream([...lines.slice(0, -1), torn]));
    expect(result.stopReason).toBe("partial_file");
    const summary = summarizeWalk(result.pages, {
      cursorExhausted: true,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(summary.exitCode).toBe(EXIT_UNCHECKED_EDGE);
    expect(summary.uncheckedClosures.map((c) => c.referentId)).toEqual([
      "entry-00000",
      "entry-00000",
    ]);
  });
});

describe("manifest handling", () => {
  const entries = descending(buildWireChain([{ epochId: "2026-07-01", count: 1 }]));

  it("rejects an unrecognised dump format version as a command failure", async () => {
    const lines = [
      JSON.stringify({ habenulaAuditDump: DUMP_FORMAT_VERSION + 1, hashFormat: "fieldwise-sha256-v1" }),
      ...entries.map((e) => dumpEntryLine(e)),
    ];
    await expect(verifyDumpLines(stream(lines))).rejects.toThrow(DumpFileError);
  });

  it("rejects an unrecognised hash format as a command failure", async () => {
    const lines = [
      JSON.stringify({ habenulaAuditDump: DUMP_FORMAT_VERSION, hashFormat: "something-v9" }),
      ...entries.map((e) => dumpEntryLine(e)),
    ];
    await expect(verifyDumpLines(stream(lines))).rejects.toThrow(/unrecognised hash format/);
  });

  it("rejects a non-manifest first line and an empty file", async () => {
    await expect(verifyDumpLines(stream(["not json", ...entries.map((e) => dumpEntryLine(e))]))).rejects.toThrow(
      DumpFileError,
    );
    await expect(verifyDumpLines(stream([]))).rejects.toThrow(/empty file/);
  });
});

describe("torn trailing line vs bad interior line", () => {
  const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);

  it("classifies a malformed FINAL line as truncation: verified up to it, partial_file, exit 4", async () => {
    const lines = dumpLines(descending(chain));
    const torn = (lines[lines.length - 1] as string).slice(0, 20);
    const result = await verifyDumpLines(stream([...lines.slice(0, -1), torn]));

    expect(result.stopReason).toBe("partial_file");
    expect(result.entriesSeen).toBe(3);
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
    expect(
      summarizeWalk(result.pages, {
        cursorExhausted: true,
        stopReason: result.stopReason,
        closures: result.closures,
      }).exitCode,
    ).toBe(EXIT_UNCHECKED_EDGE);
  });

  it("classifies a malformed INTERIOR line as corruption: DumpFileError, never a verdict", async () => {
    const lines = dumpLines(descending(chain));
    lines[2] = '{"torn":';
    await expect(verifyDumpLines(stream(lines))).rejects.toThrow(/corrupt, not truncated/);
  });
});

describe("readChainEntryLine — the shape guard, field by field", () => {
  const entry = descending(buildWireChain([{ epochId: "2026-07-01", count: 2 }]))[0] as AuditChainEntry;
  const line = dumpEntryLine(entry);

  it("parses a well-formed line into the verifier's input type", () => {
    const parsed = readChainEntryLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.hash).toBe(entry.hash);
    expect(parsed?.sequenceNum).toBe(1);
  });

  it("rejects non-JSON, non-object, and array lines", () => {
    expect(readChainEntryLine("nope")).toBeNull();
    expect(readChainEntryLine('"a string"')).toBeNull();
    expect(readChainEntryLine("[1,2]")).toBeNull();
    expect(readChainEntryLine("null")).toBeNull();
  });

  it("rejects a line with a missing key, an extra key, or both", () => {
    for (const key of Object.keys(entry)) {
      const clone = { ...(JSON.parse(line) as Record<string, unknown>) };
      delete clone[key];
      expect(readChainEntryLine(JSON.stringify(clone)), `missing ${key}`).toBeNull();
    }
    expect(readChainEntryLine(JSON.stringify({ ...entry, extra: 1 }))).toBeNull();
  });

  it("rejects a wrong-typed value on every field", () => {
    const wrong: Record<string, unknown> = {
      epochId: 7,
      sequenceNum: "1",
      prevHash: null,
      id: 1,
      timestamp: false,
      userId: [],
      agentId: {},
      sessionId: 0,
      origin: 1,
      service: null,
      verb: 2,
      noun: 3,
      toolName: 4,
      parametersMetadata: { parsed: true }, // must stay the stored STRING
      decision: 5,
      outcome: 6,
      errorMessage: 7,
      decisionEntryId: 8,
      latencyMs: "12",
      costUsd: "0.5",
      hash: 9,
      epochPrevHash: 10,
    };
    for (const [key, value] of Object.entries(wrong)) {
      const tampered = { ...(JSON.parse(line) as Record<string, unknown>), [key]: value };
      expect(readChainEntryLine(JSON.stringify(tampered)), `wrong-typed ${key}`).toBeNull();
    }
  });

  it("rejects the String()-coercion hazards: null and non-integer numerics", () => {
    // latencyMs: null would frame as "null", recompute to a different digest,
    // and report a corrupt FILE as a broken CHAIN (exit 3) — the guard is
    // what keeps those two verdicts apart.
    for (const value of [null, 1.5, Number.NaN]) {
      const tampered = { ...(JSON.parse(line) as Record<string, unknown>), latencyMs: value };
      expect(readChainEntryLine(JSON.stringify(tampered))).toBeNull();
    }
    const badSeq = { ...(JSON.parse(line) as Record<string, unknown>), sequenceNum: 1.5 };
    expect(readChainEntryLine(JSON.stringify(badSeq))).toBeNull();
  });

  it("accepts the legitimate nulls (errorMessage, decisionEntryId, costUsd, epochPrevHash)", () => {
    const nulls = {
      ...(JSON.parse(line) as Record<string, unknown>),
      errorMessage: null,
      decisionEntryId: null,
      costUsd: null,
      epochPrevHash: null,
    };
    expect(readChainEntryLine(JSON.stringify(nulls))).not.toBeNull();
  });
});
