import { describe, expect, it } from "vitest";
import type { ChainVerdict } from "@habenula-ai/audit/verify-chain";
import type { ClosureVerdict, DecisionClosure } from "@habenula-ai/audit/decision-closure";
import {
  AUDIT_MAX_PAGES,
  EXIT_BROKEN_CHAIN,
  EXIT_CONFLICTED_CLOSER,
  EXIT_UNCHECKED_EDGE,
  summarizeWalk,
  walkAuditChain,
} from "../../src/audit/walk";
import { EXIT_CANCELLED } from "../../src/commands/connect";
import {
  buildWireChain,
  descending,
  fakeAuditClient,
  pagesOf,
} from "../helpers/audit-chain";
import type { ApiClient, AuditChainEntry, AuditListResponse } from "../../src/api-client";

describe("walkAuditChain", () => {
  it("reverses each page and carries the boundary: an intact chain paged mid-epoch verifies clean", async () => {
    // 3 pages of 2 over two epochs; the page seams fall mid-epoch and on the
    // epoch boundary, so a dropped reversal or boundary carry breaks a link.
    const chain = buildWireChain([
      { epochId: "2026-07-01", count: 3 },
      { epochId: "2026-07-02", count: 3 },
    ]);
    const { client } = fakeAuditClient(pagesOf(descending(chain), 2));

    const result = await walkAuditChain(client, { verify: true });

    expect(result.stopReason).toBe("exhausted");
    expect(result.cursorExhausted).toBe(true);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.flatMap((p) => p.breaks)).toEqual([]);
    expect(result.entriesSeen).toBe(6);
    expect(result.newest).toEqual({ epochId: "2026-07-02", sequenceNum: 2 });
    expect(result.oldest).toEqual({ epochId: "2026-07-01", sequenceNum: 0 });

    const summary = summarizeWalk(result.pages, {
      cursorExhausted: result.cursorExhausted,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(summary.exitCode).toBe(0);
    expect(summary.entriesChecked).toBe(6);
    expect(summary.epochsCovered).toEqual(["2026-07-01", "2026-07-02"]);
    expect(summary.genesisShapedHead).toBe(true);
  });

  it("hands onPage each page in the route's order (newest first) — the dump order", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
    const { client } = fakeAuditClient(pagesOf(descending(chain), 2));
    const seen: number[][] = [];

    await walkAuditChain(client, {
      verify: false,
      onPage: (page) => {
        seen.push(page.map((e) => e.sequenceNum));
      },
    });

    expect(seen).toEqual([
      [3, 2],
      [1, 0],
    ]);
  });

  it("stops on a non-advancing cursor: stall detected positionally on page two", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 2 }]);
    const page: AuditListResponse = {
      entries: descending(chain),
      nextCursor: "cursor-0", // points back at itself — the walk must not spin
    };
    const { client, calls } = fakeAuditClient([page]);

    const result = await walkAuditChain(client, { verify: true });

    expect(result.stopReason).toBe("cursor_stalled");
    expect(result.cursorExhausted).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(calls).toHaveLength(2);
    expect(
      summarizeWalk(result.pages, {
        cursorExhausted: result.cursorExhausted,
        stopReason: result.stopReason,
        closures: result.closures,
      }),
    ).toMatchObject({ exitCode: EXIT_UNCHECKED_EDGE, uncheckedReasons: ["cursor_stalled"] });
  });

  it("stops at the page ceiling with the cursor still open — a backstop, never exit 0", async () => {
    // A synthetic ever-descending stream that never exhausts. verify: false
    // (the dump mode) — the ceiling is about the loop, not the hashes.
    let next = 10_000_000;
    const client = {
      listAuditEntries: async () => {
        const entry = {
          ...buildWireChain([{ epochId: "2026-01-01", count: 1 }])[0],
          sequenceNum: next--,
        } as AuditChainEntry;
        return { entries: [entry], nextCursor: "more" } as AuditListResponse;
      },
    } as unknown as ApiClient;

    const result = await walkAuditChain(client, { verify: false });

    expect(result.pagesFetched).toBe(AUDIT_MAX_PAGES);
    expect(result.stopReason).toBe("page_ceiling");
    expect(result.cursorExhausted).toBe(false);
    // The dump ladder: empty pages, so ONLY cursorExhausted can catch this —
    // a ladder over verdicts alone would report a partial dump as whole.
    expect(
      summarizeWalk([], {
        cursorExhausted: result.cursorExhausted,
        stopReason: result.stopReason,
        closures: [],
      }).exitCode,
    ).toBe(EXIT_UNCHECKED_EDGE);
  });

  it("cancels at a page boundary: completed pages keep their verdicts, no further fetch", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
    const controller = new AbortController();
    const { client, calls } = fakeAuditClient(pagesOf(descending(chain), 2));

    const result = await walkAuditChain(client, {
      verify: true,
      cancelSignal: controller.signal,
      onPage: () => controller.abort(), // Ctrl-C lands while page one renders
    });

    expect(result.stopReason).toBe("cancelled");
    expect(calls).toHaveLength(1);
    expect(result.pages).toHaveLength(1); // an abort discards no work already done
    expect(result.entriesSeen).toBe(2);
  });

  it("fires onBreakFound exactly once, on the first page whose verdict carries a break", async () => {
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
    // Tamper two rows on what will be pages two and three (descending pages
    // of 2: [5,4], [3,2], [1,0]).
    const tampered = chain.map((e) =>
      e.sequenceNum === 3 || e.sequenceNum === 0 ? { ...e, noun: "drafts" } : e,
    );
    const { client } = fakeAuditClient(pagesOf(descending(tampered), 2));
    let fired = 0;

    const result = await walkAuditChain(client, {
      verify: true,
      onBreakFound: () => {
        fired += 1;
      },
    });

    expect(fired).toBe(1);
    expect(result.pages.flatMap((p) => p.breaks).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// The exit-code precedence ladder — the one place it is decided, tested as a
// pure function over crafted verdicts.
// ---------------------------------------------------------------------------

function verdict(over: Partial<ChainVerdict> = {}): ChainVerdict {
  return {
    entriesChecked: 2,
    epochsCovered: ["2026-07-01"],
    lowerEdge: { kind: "genesis_shaped" },
    upperEdge: { kind: "closed" },
    breaks: [],
    ...over,
  };
}

const A_BREAK = {
  kind: "entry_hash" as const,
  epochId: "2026-07-01",
  sequenceNum: 1,
  expected: "aa",
  actual: "bb",
  rowsMissing: false,
};

describe("summarizeWalk — the precedence ladder", () => {
  it("a break outranks cancel: a cancelled walk that found a break returns 3, never 130", () => {
    const summary = summarizeWalk(
      [verdict({ breaks: [A_BREAK], upperEdge: { kind: "unchecked" }, lowerEdge: { kind: "unchecked" } })],
      { cursorExhausted: false, stopReason: "cancelled", closures: [] },
    );
    expect(summary.exitCode).toBe(EXIT_BROKEN_CHAIN);
  });

  it("a cancelled walk with no break returns 130 — and never 4", () => {
    const summary = summarizeWalk(
      [verdict({ upperEdge: { kind: "unchecked" }, lowerEdge: { kind: "unchecked" } })],
      { cursorExhausted: false, stopReason: "cancelled", closures: [] },
    );
    expect(summary.exitCode).toBe(EXIT_CANCELLED);
    expect(summary.uncheckedReasons).toEqual(["cancelled"]);
  });

  it("an unexhausted cursor returns 4 even with every page verdict clean", () => {
    const summary = summarizeWalk(
      [verdict({ upperEdge: { kind: "unchecked" } })],
      { cursorExhausted: false, stopReason: "page_ceiling", closures: [] },
    );
    expect(summary.exitCode).toBe(EXIT_UNCHECKED_EDGE);
    expect(summary.uncheckedReasons).toEqual(["page_ceiling"]);
  });

  it("an exhausted walk whose head is not genesis-shaped returns 4 (head_not_genesis)", () => {
    const pages = [
      verdict({ upperEdge: { kind: "unchecked" }, lowerEdge: { kind: "closed" } }),
      verdict({ lowerEdge: { kind: "unchecked", epochId: "2026-07-01", sequenceNum: 3 } }),
    ];
    const summary = summarizeWalk(pages, { cursorExhausted: true, stopReason: "exhausted", closures: [] });
    expect(summary.exitCode).toBe(EXIT_UNCHECKED_EDGE);
    expect(summary.uncheckedReasons).toEqual(["head_not_genesis"]);
  });

  it("page one's absent upper edge is the chain tip and never counts as unchecked", () => {
    const pages = [
      verdict({ upperEdge: { kind: "unchecked", epochId: "2026-07-02", sequenceNum: 9 } }),
      verdict({ lowerEdge: { kind: "genesis_shaped" } }),
    ];
    const summary = summarizeWalk(pages, { cursorExhausted: true, stopReason: "exhausted", closures: [] });
    expect(summary.exitCode).toBe(0);
    expect(summary.genesisShapedHead).toBe(true);
  });

  it("only the LAST page's lower edge decides closure — interior pages were closed by the next call", () => {
    const pages = [
      verdict({ upperEdge: { kind: "unchecked" }, lowerEdge: { kind: "unchecked", epochId: "x", sequenceNum: 5 } }),
      verdict({ lowerEdge: { kind: "genesis_shaped" } }),
    ];
    // The first (newest) page reports its own lower edge unchecked, as every
    // page does; the second page's call is what closed it.
    expect(
      summarizeWalk(pages, { cursorExhausted: true, stopReason: "exhausted", closures: [] }).exitCode,
    ).toBe(0);
  });

  it("a torn dump file returns 4 as partial_file", () => {
    const summary = summarizeWalk([verdict({ upperEdge: { kind: "unchecked" } })], {
      cursorExhausted: true,
      stopReason: "partial_file",
      closures: [],
    });
    expect(summary.exitCode).toBe(EXIT_UNCHECKED_EDGE);
    expect(summary.uncheckedReasons).toEqual(["partial_file"]);
  });

  it("dump hands in an EMPTY pages array: the cursor rung alone decides 4 vs 0", () => {
    expect(
      summarizeWalk([], { cursorExhausted: false, stopReason: "page_ceiling", closures: [] }).exitCode,
    ).toBe(EXIT_UNCHECKED_EDGE);
    expect(summarizeWalk([], { cursorExhausted: true, stopReason: "exhausted", closures: [] }).exitCode).toBe(0);
  });

  it("aggregates breaks oldest first across pages (pages arrive newest first)", () => {
    const newerBreak = { ...A_BREAK, epochId: "2026-07-02" };
    const pages = [
      verdict({ breaks: [newerBreak], upperEdge: { kind: "unchecked" } }),
      verdict({ breaks: [A_BREAK], lowerEdge: { kind: "genesis_shaped" } }),
    ];
    const summary = summarizeWalk(pages, { cursorExhausted: true, stopReason: "exhausted", closures: [] });
    expect(summary.breaks.map((b) => b.epochId)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(summary.exitCode).toBe(EXIT_BROKEN_CHAIN);
  });
});

// ---------------------------------------------------------------------------
// The exit-5 rungs: a located conflict is a finding (it survives cancel and
// the ceiling), integrity outranks it, and unresolved never moves the code.
// ---------------------------------------------------------------------------

function closureVerdict(over: Partial<ClosureVerdict> = {}): ClosureVerdict {
  return {
    decisionsChecked: 1,
    conflicted: [],
    unresolved: [],
    unchecked: [],
    carry: { unmatchedClosers: [] },
    ...over,
  };
}

const A_CONFLICT: DecisionClosure = {
  id: "entry-00001",
  epochId: "2026-07-01",
  sequenceNum: 1,
  status: "conflicted",
  agreement: "contradictory",
  closers: [
    {
      id: "entry-00002",
      epochId: "2026-07-01",
      sequenceNum: 2,
      decision: "allow",
      outcome: "success",
      referentId: "entry-00001",
    },
    {
      id: "entry-00003",
      epochId: "2026-07-01",
      sequenceNum: 3,
      decision: "deny",
      outcome: "timeout",
      referentId: "entry-00001",
    },
  ],
};

const AN_OPEN_DECISION: DecisionClosure = {
  id: "entry-00004",
  epochId: "2026-07-01",
  sequenceNum: 4,
  status: "unresolved",
  openKind: "awaiting",
  closers: [],
};

describe("summarizeWalk — the exit-5 rungs", () => {
  it("a conflict alone returns 5", () => {
    const summary = summarizeWalk([verdict()], {
      cursorExhausted: true,
      stopReason: "exhausted",
      closures: [closureVerdict({ conflicted: [A_CONFLICT] })],
    });
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
    expect(summary.conflicted).toEqual([A_CONFLICT]);
  });

  it("a break outranks a conflict: integrity outranks semantics", () => {
    const summary = summarizeWalk([verdict({ breaks: [A_BREAK] })], {
      cursorExhausted: true,
      stopReason: "exhausted",
      closures: [closureVerdict({ conflicted: [A_CONFLICT] })],
    });
    expect(summary.exitCode).toBe(EXIT_BROKEN_CHAIN);
  });

  it("a conflict outranks cancel: a located finding stays true however the walk ended", () => {
    const summary = summarizeWalk(
      [verdict({ upperEdge: { kind: "unchecked" }, lowerEdge: { kind: "unchecked" } })],
      {
        cursorExhausted: false,
        stopReason: "cancelled",
        closures: [closureVerdict({ conflicted: [A_CONFLICT] })],
      },
    );
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
    // The coverage caveat is not withdrawn by the finding.
    expect(summary.uncheckedReasons).toEqual(["cancelled"]);
  });

  it("a conflict outranks the unchecked edge: the range WAS checked and the finding is positive", () => {
    const summary = summarizeWalk([verdict({ upperEdge: { kind: "unchecked" } })], {
      cursorExhausted: false,
      stopReason: "page_ceiling",
      closures: [closureVerdict({ conflicted: [A_CONFLICT] })],
    });
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
  });

  it("unresolved decisions leave the code at 0 — a healthy engine has open prompts", () => {
    const summary = summarizeWalk([verdict()], {
      cursorExhausted: true,
      stopReason: "exhausted",
      closures: [closureVerdict({ unresolved: [AN_OPEN_DECISION] })],
    });
    expect(summary.exitCode).toBe(0);
    expect(summary.unresolved).toEqual([AN_OPEN_DECISION]);
  });

  it("the LAST closure verdict's carry surfaces as uncheckedClosures", () => {
    const leftover = A_CONFLICT.closers[0]!;
    const summary = summarizeWalk([verdict(), verdict()], {
      cursorExhausted: false,
      stopReason: "page_ceiling",
      closures: [closureVerdict(), closureVerdict({ carry: { unmatchedClosers: [leftover] } })],
    });
    expect(summary.uncheckedClosures).toEqual([leftover]);
    expect(summary.exitCode).toBe(EXIT_UNCHECKED_EDGE);
  });

  it("aggregates conflicts oldest first across pages (pages arrive newest first)", () => {
    const newerConflict = { ...A_CONFLICT, epochId: "2026-07-02" };
    const summary = summarizeWalk([verdict(), verdict()], {
      cursorExhausted: true,
      stopReason: "exhausted",
      closures: [
        closureVerdict({ conflicted: [newerConflict] }),
        closureVerdict({ conflicted: [A_CONFLICT] }),
      ],
    });
    expect(summary.conflicted.map((c) => c.epochId)).toEqual(["2026-07-01", "2026-07-02"]);
  });
});

// ---------------------------------------------------------------------------
// The wire walk's closure carry: a conflict whose closers and decision sit on
// different pages is still found, and onConflictFound fires once.
// ---------------------------------------------------------------------------

describe("walkAuditChain — the closure carry", () => {
  it("finds a conflict straddling page edges and fires onConflictFound once", async () => {
    // Six entries paged by 2: pages [5,4], [3,2], [1,0]. The decision is the
    // genesis entry (id entry-00000); its two contradictory closers sit on
    // pages one and two — only the carry connects them to it.
    const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }], {
      override: (_epoch, seq, fields) =>
        seq === 3
          ? { ...fields, decisionEntryId: "entry-00000" }
          : seq === 5
            ? { ...fields, decision: "deny", outcome: "timeout", decisionEntryId: "entry-00000" }
            : fields,
    });
    const { client } = fakeAuditClient(pagesOf(descending(chain), 2));
    let fired = 0;

    const result = await walkAuditChain(client, {
      verify: true,
      onConflictFound: () => {
        fired += 1;
      },
    });

    const summary = summarizeWalk(result.pages, {
      cursorExhausted: result.cursorExhausted,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    expect(fired).toBe(1);
    expect(summary.exitCode).toBe(EXIT_CONFLICTED_CLOSER);
    expect(summary.conflicted).toHaveLength(1);
    expect(summary.conflicted[0]!.id).toBe("entry-00000");
    expect(summary.conflicted[0]!.agreement).toBe("contradictory");
    expect(summary.conflicted[0]!.closers).toHaveLength(2);
    // No leftovers: every closer met its decision.
    expect(result.closureCarry.unmatchedClosers).toEqual([]);
  });
});
