import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineUnavailableError } from "../../src/api-client";
import { runLog, runLogDump, runLogVerify, DumpFileError } from "../../src/commands/log";
import {
  EXIT_BROKEN_CHAIN,
  EXIT_CONFLICTED_CLOSER,
  EXIT_UNCHECKED_EDGE,
} from "../../src/audit/walk";
import { EXIT_CANCELLED } from "../../src/commands/connect";
import { dumpEntryLine, dumpManifestLine } from "../../src/audit/dump";
import {
  buildWireChain,
  descending,
  fakeAuditClient,
  pagesOf,
} from "../helpers/audit-chain";
import type { ApiClient, AuditListResponse } from "../../src/api-client";
import type { DumpSink } from "../../src/commands/log";

async function* stream(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function collectSink(failOnWrite?: number): { sink: DumpSink; chunks: string[] } {
  const chunks: string[] = [];
  const sink: DumpSink = {
    write: (chunk) => {
      if (failOnWrite !== undefined && chunks.length >= failOnWrite) {
        const err = new Error("no space left on device") as Error & { code: string };
        err.code = "ENOSPC";
        throw err;
      }
      chunks.push(chunk);
    },
    describe: () => "audit.jsonl",
  };
  return { sink, chunks };
}

describe("habenula log (runners return their exit codes — wrap() maps throws to 1/2)", () => {
  let logs: string[];
  let originalColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  });

  describe("runLog", () => {
    it("renders page one with id and parameters, returns 0", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 2 }]);
      const { client, calls } = fakeAuditClient(pagesOf(descending(chain), 10));

      const code = await runLog(client, {}, "none");

      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("Audit log — newest first:");
      expect(out).toContain("gmail · read");
      expect(out).toContain("entry-00001"); // the id incident-response step 3 quotes
      expect(out).toContain("maxResults"); // parametersMetadata (rendered quoted+escaped)
      expect(calls).toHaveLength(1);
    });

    it("passes --limit through and footers a truncated page", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const { client, calls } = fakeAuditClient(pagesOf(descending(chain), 2));

      const code = await runLog(client, { limit: 2 }, "none");

      expect(code).toBe(0);
      expect(calls[0]?.limit).toBe(2);
      expect(logs.join("\n")).toContain("older entries not shown");
    });

    it("renders the empty-log state", async () => {
      const { client } = fakeAuditClient([{ entries: [], nextCursor: null }]);
      const code = await runLog(client, {}, "none");
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Audit log is empty");
    });
  });

  describe("runLogVerify — live walk", () => {
    it("returns 0 on an intact chain, naming the range and the genesis-shaped head", async () => {
      const chain = buildWireChain([
        { epochId: "2026-07-01", count: 3 },
        { epochId: "2026-07-02", count: 3 },
      ]);
      const { client } = fakeAuditClient(pagesOf(descending(chain), 2));

      const code = await runLogVerify(client);

      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("OK: 6 entries verified");
      expect(out).toContain("2026-07-01/0 → 2026-07-02/2");
      expect(out).toContain("genesis-shaped head");
    });

    it("returns 0 and says so on an empty log — never a bare green", async () => {
      const { client } = fakeAuditClient([{ entries: [], nextCursor: null }]);
      const code = await runLogVerify(client);
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("zero-entry range");
    });

    it("returns 3 on a break, naming the oldest one and the count of others", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
      const tampered = chain.map((e) =>
        e.sequenceNum === 1 || e.sequenceNum === 4 ? { ...e, noun: "drafts" } : e,
      );
      const { client } = fakeAuditClient(pagesOf(descending(tampered), 3));

      const code = await runLogVerify(client);

      expect(code).toBe(EXIT_BROKEN_CHAIN);
      const out = logs.join("\n");
      expect(out).toContain("BROKEN");
      expect(out).toContain("entry_hash at 2026-07-01/1"); // the oldest, not the newest
      expect(out).toContain("(+1 more after it)");
      expect(out).toContain("the chain's first break"); // walk closed at genesis
    });

    it("calls the oldest break only 'the oldest the walk reached' on a bounded walk", async () => {
      // The oldest epoch links to history outside the walk (a pruned head),
      // so 'first break' is not claimable.
      const chain = buildWireChain([{ epochId: "2026-07-02", count: 4 }], {
        priorEpochFinalHash: "a".repeat(64),
      });
      const tampered = chain.map((e) => (e.sequenceNum === 2 ? { ...e, verb: "send" } : e));
      const { client } = fakeAuditClient(pagesOf(descending(tampered), 10));

      const code = await runLogVerify(client);

      expect(code).toBe(EXIT_BROKEN_CHAIN);
      const out = logs.join("\n");
      expect(out).toContain("the oldest break the walk reached");
      expect(out).not.toContain("the chain's first break");
    });

    it("returns 4 when the head is not genesis-shaped, naming the unchecked edge", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-02", count: 3 }], {
        priorEpochFinalHash: "b".repeat(64),
      });
      const { client } = fakeAuditClient(pagesOf(descending(chain), 10));

      const code = await runLogVerify(client);

      expect(code).toBe(EXIT_UNCHECKED_EDGE);
      const out = logs.join("\n");
      expect(out).toContain("PARTIAL");
      expect(out).toContain("links to history the walk was not handed");
    });

    it("returns 130 on a cancel with no break, still printing the range it covered", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
      const controller = new AbortController();
      const { client, calls } = fakeAuditClient(pagesOf(descending(chain), 2), (index) => {
        if (index === 0) controller.abort(); // lands during page one
      });

      const code = await runLogVerify(client, { cancelSignal: controller.signal });

      expect(code).toBe(EXIT_CANCELLED);
      expect(calls).toHaveLength(1);
      const out = logs.join("\n");
      expect(out).toContain("Cancelled");
      expect(out).toContain("2 entries it did check"); // the covered range is owed to the user
      expect(out).toContain("2026-07-01/4 → 2026-07-01/5");
    });

    it("returns 3, never 130, when a cancel arrives after a break was already found", async () => {
      // The precedence rule most likely to be lost in a refactor: cancel
      // withdraws a coverage claim, not a finding.
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
      const tampered = chain.map((e) => (e.sequenceNum === 5 ? { ...e, noun: "drafts" } : e));
      const controller = new AbortController();
      const { client } = fakeAuditClient(pagesOf(descending(tampered), 2), (index) => {
        if (index === 0) controller.abort();
      });

      const code = await runLogVerify(client, { cancelSignal: controller.signal });

      expect(code).toBe(EXIT_BROKEN_CHAIN);
      expect(logs.join("\n")).toContain("BROKEN");
    });

    it("fires onBreakFound while the walk is still running (the force-exit flag's channel)", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const tampered = chain.map((e) => (e.sequenceNum === 3 ? { ...e, noun: "x" } : e));
      const { client } = fakeAuditClient(pagesOf(descending(tampered), 2));
      let fired = 0;

      await runLogVerify(client, { onBreakFound: () => void (fired += 1) });

      expect(fired).toBe(1);
    });

    it("lets EngineUnavailableError propagate — a walk that lost its source has no verdict (exit 2 via wrap)", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const { client } = fakeAuditClient(pagesOf(descending(chain), 2), (index) => {
        if (index === 1) throw new EngineUnavailableError("http://api.test", "reject");
      });

      await expect(runLogVerify(client)).rejects.toBeInstanceOf(EngineUnavailableError);
    });
  });

  describe("runLogVerify — the conflict finding (exit 5)", () => {
    /** An intact chain whose genesis decision carries two contradictory
     * closers — hashes are real, only the closure semantics conflict. */
    function conflictedChain(count: number, closerSeqs: [number, number]) {
      return buildWireChain([{ epochId: "2026-07-01", count }], {
        override: (_epoch, seq, fields) =>
          seq === closerSeqs[0]
            ? { ...fields, decisionEntryId: "entry-00000" }
            : seq === closerSeqs[1]
              ? { ...fields, decision: "deny", outcome: "timeout", decisionEntryId: "entry-00000" }
              : fields,
      });
    }

    it("returns 5 and names the decision, every closer, and the agreement label", async () => {
      const { client } = fakeAuditClient(pagesOf(descending(conflictedChain(4, [2, 3])), 2));
      let fired = 0;

      const code = await runLogVerify(client, { onConflictFound: () => void (fired += 1) });

      expect(code).toBe(EXIT_CONFLICTED_CLOSER);
      expect(fired).toBe(1);
      const out = logs.join("\n");
      expect(out).toContain("CONFLICTED: decision 2026-07-01/0 (id entry-00000)");
      expect(out).toContain("contradictory");
      expect(out).toContain("allow·success id entry-00002");
      expect(out).toContain("deny·timeout id entry-00003");
      expect(out).not.toContain("PARTIAL");
    });

    it("a cancelled walk that found a conflict prints CONFLICTED with the coverage sentence — never PARTIAL, never 130", async () => {
      // The conflict is wholly inside page one (decision seq 4, closers 5 and
      // 6 of 8); the cancel lands during page one, so the walk stops with the
      // finding already located and the rest of the chain uncovered.
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 8 }], {
        override: (_epoch, seq, fields) =>
          seq === 5
            ? { ...fields, decisionEntryId: "entry-00004" }
            : seq === 6
              ? { ...fields, decision: "deny", outcome: "timeout", decisionEntryId: "entry-00004" }
              : fields,
      });
      const controller = new AbortController();
      const { client } = fakeAuditClient(pagesOf(descending(chain), 4), (index) => {
        if (index === 0) controller.abort();
      });

      const code = await runLogVerify(client, { cancelSignal: controller.signal });

      expect(code).toBe(EXIT_CONFLICTED_CLOSER);
      const out = logs.join("\n");
      expect(out).toContain("CONFLICTED: decision 2026-07-01/4");
      expect(out).toContain("the walk was cancelled"); // the coverage sentence rides the finding
      expect(out).not.toContain("PARTIAL");
      expect(out).not.toContain("Cancelled:"); // the cancel block below never catches a 5
    });

    it("the same conflict found through --file returns 5 — the path a runbook reader uses", async () => {
      const lines = [
        dumpManifestLine(),
        ...descending(conflictedChain(4, [2, 3])).map((e) => dumpEntryLine(e)),
      ];
      let fired = 0;

      const code = await runLogVerify({} as ApiClient, {
        file: "audit.jsonl",
        lines: stream(lines),
        onConflictFound: () => void (fired += 1),
      });

      expect(code).toBe(EXIT_CONFLICTED_CLOSER);
      expect(fired).toBe(1);
      expect(logs.join("\n")).toContain("CONFLICTED: decision 2026-07-01/0");
    });

    it("unresolved decisions print as trailing notes, named apart by openKind, and leave the code alone", async () => {
      // The fixture rows are referent-free `allow` decisions: dispatched
      // calls with no recorded outcome — the real gap. A pending row with no
      // closer is an open prompt — the ordinary state.
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 2 }], {
        override: (_epoch, seq, fields) =>
          seq === 1 ? { ...fields, decision: "pending" } : fields,
      });
      const { client } = fakeAuditClient(pagesOf(descending(chain), 10));

      const code = await runLogVerify(client);

      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("OK: 2 entries verified");
      expect(out).toContain("decision 2026-07-01/0 (id entry-00000) is unresolved");
      expect(out).toContain("no outcome was recorded");
      expect(out).toContain("decision 2026-07-01/1 (id entry-00001) is awaiting confirmation");
      expect(out).toContain("the ordinary state");
    });
  });

  describe("runLogVerify — --file", () => {
    const noClient = {} as ApiClient;

    it("verifies an injected line stream and returns 0", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 3 }]);
      const lines = [dumpManifestLine(), ...descending(chain).map((e) => dumpEntryLine(e))];

      const code = await runLogVerify(noClient, { file: "audit.jsonl", lines: stream(lines) });

      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("OK: 3 entries verified");
    });

    it("returns 4 with partial_file on a torn trailing line", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 3 }]);
      const lines = [dumpManifestLine(), ...descending(chain).map((e) => dumpEntryLine(e))];
      lines[lines.length - 1] = (lines[lines.length - 1] as string).slice(0, 15);

      const code = await runLogVerify(noClient, { file: "audit.jsonl", lines: stream(lines) });

      expect(code).toBe(EXIT_UNCHECKED_EDGE);
      expect(logs.join("\n")).toContain("truncated dump");
    });

    it("propagates a DumpFileError (bad manifest) — exit 1 via wrap, not a verdict", async () => {
      const lines = ['{"habenulaAuditDump":99,"hashFormat":"fieldwise-sha256-v1"}'];
      await expect(
        runLogVerify(noClient, { file: "audit.jsonl", lines: stream(lines) }),
      ).rejects.toBeInstanceOf(DumpFileError);
    });

    it("returns 130 on a cancelled --file verify even when the file is smaller than one batch", async () => {
      // The reader checks the signal per line, like the wire walk per pass —
      // a sub-batch file must not run to completion and report exit 0.
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const lines = [dumpManifestLine(), ...descending(chain).map((e) => dumpEntryLine(e))];
      const controller = new AbortController();
      async function* aborting(): AsyncIterable<string> {
        for (const [i, line] of lines.entries()) {
          if (i === 2) controller.abort(); // Ctrl-C lands two lines in
          yield line;
        }
      }

      const code = await runLogVerify(noClient, {
        file: "audit.jsonl",
        lines: aborting(),
        cancelSignal: controller.signal,
      });

      expect(code).toBe(EXIT_CANCELLED);
      expect(logs.join("\n")).toContain("Cancelled");
    });
  });

  describe("runLogDump", () => {
    it("writes the manifest first, then every page in route order; returns 0", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const { client } = fakeAuditClient(pagesOf(descending(chain), 2));
      const { sink, chunks } = collectSink();
      const stderrLines: string[] = [];

      const code = await runLogDump(client, "audit.jsonl", {
        sink,
        writeStderr: (line) => stderrLines.push(line),
      });

      expect(code).toBe(0);
      expect(chunks[0]).toBe(`${dumpManifestLine()}\n`);
      const body = chunks.join("");
      expect(body.endsWith("\n")).toBe(true);
      const dataLines = body.trimEnd().split("\n").slice(1);
      expect(dataLines).toHaveLength(4);
      // Route order preserved: newest first, genesis last.
      expect(JSON.parse(dataLines[0] as string).sequenceNum).toBe(3);
      expect(JSON.parse(dataLines[3] as string).sequenceNum).toBe(0);
      // Progress is a running page/byte count, and it never touches stdout.
      expect(stderrLines.some((l) => /page 1 · 2 entries · \d+ bytes/.test(l))).toBe(true);
      expect(stderrLines.at(-1)).toMatch(/wrote audit\.jsonl: 4 entries/);
      expect(logs).toEqual([]);
    });

    it("returns 130 on cancel, closing at a page boundary with the path and size on stderr", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 6 }]);
      const controller = new AbortController();
      const { client, calls } = fakeAuditClient(pagesOf(descending(chain), 2), (index) => {
        if (index === 0) controller.abort();
      });
      const { sink, chunks } = collectSink();
      const stderrLines: string[] = [];

      const code = await runLogDump(client, "audit.jsonl", {
        sink,
        cancelSignal: controller.signal,
        writeStderr: (line) => stderrLines.push(line),
      });

      expect(code).toBe(EXIT_CANCELLED);
      expect(calls).toHaveLength(1);
      // Whole pages of whole lines: a designed cancel never tears a line.
      expect(chunks.every((c) => c.endsWith("\n"))).toBe(true);
      expect(chunks.join("").trimEnd().split("\n")).toHaveLength(3); // manifest + one page of 2
      expect(stderrLines.at(-1)).toMatch(/cancelled — partial dump at audit\.jsonl \(2 entries, \d+ bytes\)/);
    });

    it("names the partial file and rethrows when the engine dies mid-walk (exit 2 via wrap)", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const { client } = fakeAuditClient(pagesOf(descending(chain), 2), (index) => {
        if (index === 1) throw new EngineUnavailableError("http://api.test", "reject");
      });
      const { sink } = collectSink();
      const stderrLines: string[] = [];

      await expect(
        runLogDump(client, "audit.jsonl", {
          sink,
          writeStderr: (line) => stderrLines.push(line),
        }),
      ).rejects.toBeInstanceOf(EngineUnavailableError);
      expect(stderrLines.at(-1)).toMatch(/engine became unavailable mid-walk — partial dump at audit\.jsonl/);
    });

    it("names the partial file and rethrows on ENOSPC — a full disk is not a verdict (exit 1 via wrap)", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 4 }]);
      const { client } = fakeAuditClient(pagesOf(descending(chain), 2));
      const { sink } = collectSink(2); // manifest + page 1 land; page 2 hits a full disk
      const stderrLines: string[] = [];

      await expect(
        runLogDump(client, "audit.jsonl", {
          sink,
          writeStderr: (line) => stderrLines.push(line),
        }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      expect(stderrLines.at(-1)).toMatch(/disk full \(ENOSPC\) — partial dump at audit\.jsonl/);
    });

    it("returns 4 on a stalled cursor, reporting the partial file on stderr", async () => {
      const chain = buildWireChain([{ epochId: "2026-07-01", count: 2 }]);
      const stalled: AuditListResponse = {
        entries: descending(chain),
        nextCursor: "cursor-0",
      };
      const { client } = fakeAuditClient([stalled]);
      const { sink } = collectSink();
      const stderrLines: string[] = [];

      const code = await runLogDump(client, "audit.jsonl", {
        sink,
        writeStderr: (line) => stderrLines.push(line),
      });

      expect(code).toBe(EXIT_UNCHECKED_EDGE);
      expect(stderrLines.at(-1)).toMatch(/cursor stalled/);
    });
  });
});
