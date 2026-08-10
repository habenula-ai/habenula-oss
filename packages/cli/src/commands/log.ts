// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `habenula log` command surface: `log` (the newest
 * page, rendered), `log dump <path>` (the complete chain as JSONL), and
 * `log verify [--file]` (recompute every hash locally and report a located
 * verdict).
 *
 * Exit codes 3 (broken chain), 4 (unchecked edge), 5 (conflicted closers),
 * and 130 (cancelled, no finding) are RETURNED, never thrown: `wrap()` in
 * index.ts maps every thrown error to 1 or 2, so a runner that threw to
 * signal a broken chain would silently exit 1 and the whole verdict surface
 * would be inert. The
 * exit-2 reservation holds unchanged — an engine that dies mid-walk still
 * propagates `EngineUnavailableError`, because a walk that lost its source
 * has no verdict to report.
 *
 * The verify output prints only Habenula-minted identifiers — epoch ids,
 * sequence numbers, hashes — but on the `--file` path those come from an
 * untrusted file, so every interpolated value is byte-sanitized anyway. A
 * prompt-injected tool call (or a hostile file) cannot author a line of a
 * verdict.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { ApiClient, EngineUnavailableError } from "../api-client";
import { renderAuditPage } from "../render/audit";
import { clampSanitized, terminalWidth } from "../render/attribution";
import { detectColorDepth, type ColorDepth } from "../render/color";
import { EXIT_CANCELLED } from "./connect";
import {
  EXIT_BROKEN_CHAIN,
  summarizeWalk,
  walkAuditChain,
  type ChainLocation,
  type UncheckedReason,
  type WalkSummary,
} from "../audit/walk";
import {
  DumpFileError,
  dumpEntryLine,
  dumpFileLines,
  dumpManifestLine,
  verifyDumpLines,
} from "../audit/dump";
import type { ChainBreak } from "@habenula-ai/audit/verify-chain";

const utf8 = new TextEncoder();

/** `habenula log` — page one of the route, rendered. No cursor flag: an
 * entry older than one page is reached with `log dump` and a grep until
 * filtering ships. */
export async function runLog(
  client: ApiClient,
  options: { limit?: number } = {},
  depth: ColorDepth = detectColorDepth(),
): Promise<number> {
  const page = await client.listAuditEntries(
    options.limit !== undefined ? { limit: options.limit } : undefined,
  );
  const lines = renderAuditPage(page.entries, page.nextCursor, {
    now: new Date(),
    depth,
    width: terminalWidth(),
  });
  for (const line of lines) console.log(line);
  return 0;
}

/** Where a dump's bytes go. Injectable so tests drive the ENOSPC path and
 * inspect written chunks without a filesystem. */
export interface DumpSink {
  write(chunk: string): void;
  /** How the destination is named in progress and failure messages. */
  describe(): string;
}

function makeDumpSink(path: string): DumpSink {
  if (path === "-") {
    return {
      write: (chunk) => void process.stdout.write(chunk),
      describe: () => "stdout",
    };
  }
  // Truncate-then-append: each append is one whole page of whole lines, so a
  // cancel (which stops at a page boundary) never leaves a torn line.
  writeFileSync(path, "");
  return {
    write: (chunk) => appendFileSync(path, chunk),
    describe: () => path,
  };
}

export interface LogDumpOptions {
  cancelSignal?: AbortSignal;
  /** Test seams: the byte sink and the stderr line writer. */
  sink?: DumpSink;
  writeStderr?: (line: string) => void;
}

/**
 * `habenula log dump <path>` — the same guarded walk as `verify`, written
 * instead of hashed. Progress is a running page and byte count on STDERR —
 * never stdout, which on the `-` path is the dump itself — so a
 * ceiling-length dump's size is visible while it grows (a full walk can run
 * to hundreds of MB, ~2 GB at the ceiling).
 *
 * A walk stopped by the ceiling or the stall check leaves a partial file,
 * reports the unchecked boundary on stderr, and returns 4 — the same code a
 * verify over that file returns. A cancelled dump returns 130 and names the
 * path and size. Two mid-walk failures get the same courtesy and different
 * exits: an `EngineUnavailableError` names the partial file and propagates to
 * exit 2; an ENOSPC names it and rethrows to `wrap()`'s exit 1 — a full disk
 * is not a verdict about a chain.
 */
export async function runLogDump(
  client: ApiClient,
  path: string,
  options: LogDumpOptions = {},
): Promise<number> {
  const stderr = options.writeStderr ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const sink = options.sink ?? makeDumpSink(path);
  let bytesWritten = 0;
  let entriesWritten = 0;
  let pagesWritten = 0;
  const write = (chunk: string): void => {
    sink.write(chunk);
    bytesWritten += utf8.encode(chunk).length;
  };
  const partialNote = (cause: string): void => {
    stderr(
      `${cause} — partial dump at ${sink.describe()} (${entriesWritten} entries, ${bytesWritten} bytes)`,
    );
  };

  try {
    write(`${dumpManifestLine()}\n`);
    const result = await walkAuditChain(client, {
      verify: false,
      ...(options.cancelSignal !== undefined ? { cancelSignal: options.cancelSignal } : {}),
      onPage: (page) => {
        write(`${page.map((entry) => dumpEntryLine(entry)).join("\n")}\n`);
        pagesWritten += 1;
        entriesWritten += page.length;
        stderr(`page ${pagesWritten} · ${entriesWritten} entries · ${bytesWritten} bytes`);
      },
    });

    if (result.stopReason === "cancelled") {
      partialNote("cancelled");
      return EXIT_CANCELLED;
    }
    const summary = summarizeWalk([], {
      cursorExhausted: result.cursorExhausted,
      stopReason: result.stopReason,
      // Explicitly none: dump verifies nothing, the same [] it passes for
      // pages. The field is required so no caller defaults into it.
      closures: [],
    });
    if (summary.exitCode !== 0) {
      partialNote(
        result.stopReason === "page_ceiling"
          ? "page ceiling reached; the older boundary is unchecked"
          : "cursor stalled; the older boundary is unchecked",
      );
      return summary.exitCode;
    }
    stderr(
      `wrote ${sink.describe()}: ${entriesWritten} entries (${bytesWritten} bytes, ${pagesWritten} pages)`,
    );
    return 0;
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      partialNote("engine became unavailable mid-walk");
      throw err; // wrap() maps it to exit 2 — a walk that lost its source has no verdict
    }
    if (isDiskFull(err)) {
      partialNote("disk full (ENOSPC)");
      throw err; // wrap() maps it to exit 1 — a command failure, not a verdict
    }
    throw err;
  }
}

function isDiskFull(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOSPC"
  );
}

export interface LogVerifyOptions {
  file?: string;
  cancelSignal?: AbortSignal;
  /** Fired the moment the walk locates a break — the force-exit path's flag. */
  onBreakFound?: () => void;
  /** Fired the moment a closure verdict holds a conflict — the force-exit
   *  path's second flag, raised by both loops (wire and `--file`) alike. */
  onConflictFound?: () => void;
  /** Test seam for `--file`: an injected line stream replaces the file read. */
  lines?: AsyncIterable<string>;
}

const safe = (value: string): string => clampSanitized(value, 80).text;

function locationLabel(location: ChainLocation): string {
  return `${safe(location.epochId)}/${location.sequenceNum}`;
}

function rangeLabel(oldest: ChainLocation | null, newest: ChainLocation | null): string {
  if (oldest === null || newest === null) return "an empty range";
  return `${locationLabel(oldest)} → ${locationLabel(newest)}`;
}

function uncheckedLabel(reason: UncheckedReason): string {
  switch (reason) {
    case "page_ceiling":
      return "the walk stopped at its page ceiling";
    case "cursor_stalled":
      return "the walk stopped on a non-advancing cursor";
    case "head_not_genesis":
      return "the range's oldest edge links to history the walk was not handed";
    case "cancelled":
      return "the walk was cancelled";
    case "partial_file":
      return "the file's final line is torn (truncated dump)";
  }
}

function describeBreak(brk: ChainBreak): string {
  const where = `${safe(brk.epochId)}/${brk.sequenceNum}`;
  const missing = brk.rowsMissing ? " (sequence gap: a row is missing here)" : "";
  const expected = brk.expected === null ? "(none computable)" : safe(brk.expected);
  const actual = brk.actual === null ? "null" : safe(brk.actual);
  return `${brk.kind} at ${where}${missing} — expected ${expected}, found ${actual}`;
}

/** One conflicted decision: its location, then every closer the check saw,
 * with the agreement label. On the `--file` path every value here comes from
 * an untrusted file, so each goes through `safe()`. */
function describeConflict(finding: WalkSummary["conflicted"][number]): string {
  const where = `${safe(finding.epochId)}/${finding.sequenceNum}`;
  const closers = finding.closers
    .map((c) => `${safe(c.decision)}·${safe(c.outcome)} id ${safe(c.id)}`)
    .join("; ");
  return (
    `CONFLICTED: decision ${where} (id ${safe(finding.id)}) carries ` +
    `${finding.closers.length} closers (${finding.agreement ?? "conflicted"}): ${closers}`
  );
}

/**
 * The trailing closure notes: unresolved decisions and unchecked leftover
 * closers. Reportable text that never moves the exit code — the two open
 * cases are named apart off `openKind`, so a dispatched decision with
 * nothing recorded reads as the gap it is and an open prompt reads as
 * ordinary.
 */
function closureNotes(summary: WalkSummary): string[] {
  const notes: string[] = [];
  for (const open of summary.unresolved) {
    const where = `${safe(open.epochId)}/${open.sequenceNum}`;
    notes.push(
      open.openKind === "dispatched"
        ? `note: decision ${where} (id ${safe(open.id)}) is unresolved — the call dispatched and no outcome was recorded`
        : `note: decision ${where} (id ${safe(open.id)}) is awaiting confirmation — an open prompt, the ordinary state`,
    );
  }
  for (const closer of summary.uncheckedClosures) {
    const where = `${safe(closer.epochId)}/${closer.sequenceNum}`;
    notes.push(
      `note: closer ${where} (id ${safe(closer.id)}) names decision id ${safe(closer.referentId)}, which this range does not hold — its closure is unchecked`,
    );
  }
  return notes;
}

/**
 * `habenula log verify [--file <path>]` — the walk (or the file), then the
 * aggregate. Returns 0, 3, 4, 5, or 130 on the `summarizeWalk` ladder. A
 * cancelled verify prints the range it covered and says the walk was
 * cancelled — a verified range stays verified however the walk ended, and a
 * cancel that already found a finding returns that finding's code, never 130
 * (cancel withdraws a coverage claim, not a finding): 3 for a break, 5 for a
 * conflicted decision.
 */
export async function runLogVerify(
  client: ApiClient,
  options: LogVerifyOptions = {},
): Promise<number> {
  let summary: WalkSummary;
  let newest: ChainLocation | null;
  let oldest: ChainLocation | null;
  let entriesSeen: number;

  if (options.file !== undefined || options.lines !== undefined) {
    const lines = options.lines ?? dumpFileLines(options.file as string);
    const result = await verifyDumpLines(lines, {
      ...(options.cancelSignal !== undefined ? { cancelSignal: options.cancelSignal } : {}),
      ...(options.onBreakFound !== undefined ? { onBreakFound: options.onBreakFound } : {}),
      ...(options.onConflictFound !== undefined
        ? { onConflictFound: options.onConflictFound }
        : {}),
    });
    // No cursor on the file path: `cursorExhausted: true`, so the edge rung
    // of the ladder decides alone.
    summary = summarizeWalk(result.pages, {
      cursorExhausted: true,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    ({ newest, oldest, entriesSeen } = result);
  } else {
    const result = await walkAuditChain(client, {
      verify: true,
      ...(options.cancelSignal !== undefined ? { cancelSignal: options.cancelSignal } : {}),
      ...(options.onBreakFound !== undefined ? { onBreakFound: options.onBreakFound } : {}),
      ...(options.onConflictFound !== undefined
        ? { onConflictFound: options.onConflictFound }
        : {}),
    });
    summary = summarizeWalk(result.pages, {
      cursorExhausted: result.cursorExhausted,
      stopReason: result.stopReason,
      closures: result.closures,
    });
    ({ newest, oldest, entriesSeen } = result);
  }

  const range = rangeLabel(oldest, newest);

  if (summary.breaks.length > 0) {
    const [oldestBreak] = summary.breaks;
    // "The chain's first break" is claimable only when the walk also closed
    // at a genesis-shaped head; a bounded walk found only the oldest break IT
    // REACHED.
    const firstness =
      summary.genesisShapedHead && summary.uncheckedReasons.length === 0
        ? "the chain's first break"
        : "the oldest break the walk reached";
    const others =
      summary.breaks.length === 1 ? "" : ` (+${summary.breaks.length - 1} more after it)`;
    console.log(`BROKEN: ${firstness} is ${describeBreak(oldestBreak as ChainBreak)}${others}`);
    console.log(`Checked ${summary.entriesChecked} entries over ${range}.`);
    return EXIT_BROKEN_CHAIN;
  }

  // The conflict block sits ABOVE the cancel and PARTIAL blocks, and the
  // position is load-bearing: both blocks below test the CODE rather than
  // the finding, and with exit 5 outranking 130 and 4 a cancelled or
  // ceiling-stopped walk that found a conflict lands here. So this block
  // carries the coverage sentence itself — a finding never silently
  // withdraws the coverage caveat that came with it (the same rule the
  // BROKEN block applies with `genesisShapedHead`).
  if (summary.conflicted.length > 0) {
    for (const finding of summary.conflicted) console.log(describeConflict(finding));
    console.log(`Checked ${summary.entriesChecked} entries over ${range}.`);
    if (summary.uncheckedReasons.length > 0) {
      const reasons = summary.uncheckedReasons.map((r) => uncheckedLabel(r)).join("; ");
      console.log(`An edge of the range is unchecked — ${reasons}.`);
    }
    for (const note of closureNotes(summary)) console.log(note);
    return summary.exitCode;
  }

  if (summary.exitCode === EXIT_CANCELLED) {
    console.log(
      `Cancelled: the walk was stopped before it covered the chain. ` +
        `The ${summary.entriesChecked} entries it did check (${range}) verified intact.`,
    );
    for (const note of closureNotes(summary)) console.log(note);
    return EXIT_CANCELLED;
  }

  if (summary.exitCode !== 0) {
    const reasons = summary.uncheckedReasons.map((r) => uncheckedLabel(r)).join("; ");
    console.log(
      `PARTIAL: every link checked is intact, but an edge of the range is unchecked — ${reasons}.`,
    );
    console.log(`Checked ${summary.entriesChecked} entries over ${range}.`);
    for (const note of closureNotes(summary)) console.log(note);
    return summary.exitCode;
  }

  if (entriesSeen === 0) {
    console.log("OK: the audit log is empty — a zero-entry range has no links to check.");
    return 0;
  }
  console.log(
    `OK: ${summary.entriesChecked} entries verified over ${range}, ` +
      `${summary.epochsCovered.length} epoch(s), closed at a genesis-shaped head.`,
  );
  for (const note of closureNotes(summary)) console.log(note);
  return 0;
}

// Re-exported so index.ts's force-exit wiring and the tests share the same
// constant the ladder uses.
export { EXIT_BROKEN_CHAIN, DumpFileError };
