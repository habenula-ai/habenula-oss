// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dump-file format: JSONL. Line one is a
 * manifest; every later line is one `AuditChainEntry` in the route's order —
 * newest first, genesis last — so the verifier reads a file exactly as it
 * reads the wire. The chain tip, epoch range, and row count are all derivable
 * from the rows, so the manifest carries only what the rows cannot: the dump
 * format version and the hash-format identifier.
 *
 * A dump file is UNTRUSTED input: `log verify --file` reads files this CLI
 * did not write. The `readChainEntryLine` shape guard is a security control,
 * not tidiness — `computeEntryHash` calls String() on every field, so a line
 * carrying `latencyMs: null` would frame as "null", recompute to a different
 * digest, and surface as a broken CHAIN (exit 3, the verdict an operator
 * treats as an incident) when the defect is a corrupt FILE. Any line the
 * guard rejects is a file defect and never reaches the verifier.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { AUDIT_HASH_FORMAT } from "@habenula-ai/audit/hash";
import { verifyChainRange } from "@habenula-ai/audit/verify-chain";
import type { ChainEntry, ChainVerdict } from "@habenula-ai/audit/verify-chain";
import { checkDecisionClosure } from "@habenula-ai/audit/decision-closure";
import type { ClosureCarry, ClosureVerdict } from "@habenula-ai/audit/decision-closure";
import type { AuditChainEntry } from "../api-client";
import type { ChainLocation } from "./walk";

export const DUMP_FORMAT_VERSION = 1;

/** A defect of the FILE (bad manifest, interior corruption) — a command
 * failure, exit 1 via `wrap()`. Never a verdict about a chain. */
export class DumpFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpFileError";
  }
}

export function dumpManifestLine(): string {
  return JSON.stringify({ habenulaAuditDump: DUMP_FORMAT_VERSION, hashFormat: AUDIT_HASH_FORMAT });
}

/** One row, written through verbatim — the wire shape is the file shape.
 * JSON.stringify preserves null distinctly from "", which the hash cannot
 * ("both frame as `0:`") but the round trip must. */
export function dumpEntryLine(entry: AuditChainEntry): string {
  return JSON.stringify(entry);
}

const STRING_FIELDS = [
  "epochId",
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
  "hash",
] as const;

const NULLABLE_STRING_FIELDS = ["errorMessage", "decisionEntryId", "epochPrevHash"] as const;
const INTEGER_FIELDS = ["sequenceNum", "latencyMs"] as const;

const CHAIN_ENTRY_KEY_COUNT =
  STRING_FIELDS.length + NULLABLE_STRING_FIELDS.length + INTEGER_FIELDS.length + 1; // + costUsd

/**
 * Parse one dump line into the verifier's input type, or null for any line
 * that is not shaped like an entry: non-JSON, non-object, a missing or extra
 * key, or a field of the wrong type (`sequenceNum`/`latencyMs` must be
 * integers). Null feeds the trailing-versus-interior rule in
 * `verifyDumpLines` exactly as a parse failure does.
 *
 * Hand-written rather than a zod schema because no zod runtime enters the CLI
 * (api-client.ts states that constraint). It returns the audit package's
 * `ChainEntry` rather than the wire type deliberately: its only consumer is
 * `verifyChainRange`, so it produces the verifier's input type directly.
 */
export function readChainEntryLine(line: string): ChainEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== CHAIN_ENTRY_KEY_COUNT) return null;
  for (const key of STRING_FIELDS) {
    if (typeof record[key] !== "string") return null;
  }
  for (const key of NULLABLE_STRING_FIELDS) {
    const value = record[key];
    if (value !== null && typeof value !== "string") return null;
  }
  for (const key of INTEGER_FIELDS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value)) return null;
  }
  const costUsd = record["costUsd"];
  if (costUsd !== null && typeof costUsd !== "number") return null;
  return record as unknown as ChainEntry;
}

/** Batch size for the file walk — the reader never holds a dump whole. Sized
 * like the server's page cap; any value works, since the boundary carry
 * closes every seam. */
export const READ_BATCH_SIZE = 200;

export interface DumpVerifyResult {
  /** Batch verdicts in read order (newest batch first) — the same shape the
   *  wire walk produces, so `summarizeWalk` aggregates both identically. */
  pages: ChainVerdict[];
  /** Per-batch closure verdicts, same order as `pages` — the wire walk's
   *  shape again, so `--file` reaches the same exit-5 finding. */
  closures: ClosureVerdict[];
  /** The closure carry left after the last batch. A truncated file leaves
   *  its carry unmatched — unchecked coverage, the story `partial_file`'s
   *  exit 4 already tells. */
  closureCarry: ClosureCarry;
  entriesSeen: number;
  newest: ChainLocation | null;
  oldest: ChainLocation | null;
  /** `partial_file`: the final line was malformed — truncation (a torn write,
   *  SIGKILL, full disk, broken pipe). Everything before it was verified. */
  stopReason: "exhausted" | "partial_file" | "cancelled";
}

/**
 * Stream a dump and verify it in bounded batches. File order is the wire
 * order (newest first), so each batch is reversed into ascending order and
 * the batch's oldest entry carries forward as the next batch's boundary —
 * the wire walk's exact shape. The closure carry is threaded the same way:
 * this is the second of the two loops that must find the same conflicts
 * (walk.ts is the first) — a carry threaded through the wire walk alone
 * would leave `--file` printing OK over a file that holds one, and the file
 * path is the one an operator reaches for when investigating an incident.
 *
 * Malformed lines split by position, and the split is load-bearing. A bad
 * LAST line is truncation: drop it, verify everything before it, report
 * `partial_file` (an unchecked edge, exit 4 upstream). A bad INTERIOR line is
 * corruption truncation cannot explain: a `DumpFileError`, exit 1. Without
 * the split a torn file either reads as a normal bounded range or fails
 * outright, and neither is the truth.
 */
export async function verifyDumpLines(
  lines: AsyncIterable<string>,
  options?: {
    cancelSignal?: AbortSignal;
    onBreakFound?: () => void;
    onConflictFound?: () => void;
  },
): Promise<DumpVerifyResult> {
  const pages: ChainVerdict[] = [];
  const closures: ClosureVerdict[] = [];
  let entriesSeen = 0;
  let newest: ChainLocation | null = null;
  let oldest: ChainLocation | null = null;
  let boundary: ChainEntry | undefined;
  let closureCarry: ClosureCarry = { unmatchedClosers: [] };
  let breakFound = false;
  let conflictFound = false;
  let batch: ChainEntry[] = [];
  let sawManifest = false;
  let pendingMalformed = false;
  let stopReason: DumpVerifyResult["stopReason"] = "exhausted";

  const flushBatch = (): void => {
    if (batch.length === 0) return;
    const ascending = [...batch].reverse();
    const verdict = verifyChainRange(
      ascending,
      boundary !== undefined ? { boundaryEntry: boundary } : undefined,
    );
    pages.push(verdict);
    if (verdict.breaks.length > 0 && !breakFound) {
      breakFound = true;
      options?.onBreakFound?.();
    }
    // A dump's first data line is the tip (the fact exit 4 already relies
    // on), so every batch's upper edge is closed — batch one by the tip,
    // every later batch by the carry from the batch above it. A conflict
    // straddling a READ_BATCH_SIZE edge is exactly what the carry covers.
    const closure = checkDecisionClosure(ascending, {
      carry: closureCarry,
      upperEdgeClosed: true,
    });
    closures.push(closure);
    closureCarry = closure.carry;
    if (closure.conflicted.length > 0 && !conflictFound) {
      conflictFound = true;
      options?.onConflictFound?.();
    }
    boundary = batch[batch.length - 1] as ChainEntry; // the batch's oldest
    batch = [];
  };

  for await (const line of lines) {
    // Checked per line, as the wire walk checks per pass: a file smaller than
    // one batch — or a stalled stdin pipe still short of one — must observe a
    // cancel too. A batch-boundary-only check would let a sub-batch file run
    // to completion and report exit 0 where the wire walk reports 130. The
    // batch read so far is flushed first: an abort discards no work already
    // done, so the verdict still covers every line consumed.
    if (options?.cancelSignal?.aborted) {
      flushBatch();
      stopReason = "cancelled";
      break;
    }
    if (!sawManifest) {
      readDumpManifest(line);
      sawManifest = true;
      continue;
    }
    if (pendingMalformed) {
      // The malformed line has a successor, so it was interior — corruption,
      // not truncation.
      throw new DumpFileError(
        "malformed line inside the dump (not at the end) — the file is corrupt, not truncated",
      );
    }
    const entry = readChainEntryLine(line);
    if (entry === null) {
      pendingMalformed = true;
      continue;
    }
    entriesSeen += 1;
    if (newest === null) newest = { epochId: entry.epochId, sequenceNum: entry.sequenceNum };
    oldest = { epochId: entry.epochId, sequenceNum: entry.sequenceNum };
    batch.push(entry);
    if (batch.length >= READ_BATCH_SIZE) flushBatch();
  }

  if (stopReason !== "cancelled") {
    flushBatch();
    if (!sawManifest) {
      throw new DumpFileError("empty file — a dump starts with its manifest line");
    }
    if (pendingMalformed) stopReason = "partial_file";
  }

  return { pages, closures, closureCarry, entriesSeen, newest, oldest, stopReason };
}

/** Parse and check the manifest. An unrecognised format version or hash
 * format is a command failure — this reader cannot know what the rows mean,
 * so it must refuse rather than report a verdict. */
function readDumpManifest(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DumpFileError("first line is not a dump manifest (expected JSON)");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DumpFileError("first line is not a dump manifest");
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.habenulaAuditDump !== DUMP_FORMAT_VERSION) {
    throw new DumpFileError(
      `unrecognised dump format version ${JSON.stringify(manifest.habenulaAuditDump)} (this build reads version ${DUMP_FORMAT_VERSION})`,
    );
  }
  if (manifest.hashFormat !== AUDIT_HASH_FORMAT) {
    throw new DumpFileError(
      `unrecognised hash format ${JSON.stringify(manifest.hashFormat)} (this build verifies ${AUDIT_HASH_FORMAT})`,
    );
  }
}

/** Line stream over a dump file, or stdin for `-` — the pipe half of
 * `log dump - | log verify --file -`. */
export function dumpFileLines(path: string): AsyncIterable<string> {
  const input = path === "-" ? process.stdin : createReadStream(path);
  return createInterface({ input, terminal: false });
}
