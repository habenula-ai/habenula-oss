// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import {
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import type { EnginePaths } from "./paths";
import type { PortClass } from "./probe";

/**
 * The run record, `<root>/engine.json` — who *started* the daemon. A different
 * fact from src/engine-state.ts, which tracks whether the engine is
 * *answering* for the REPL; the two never merge and neither imports the other.
 *
 * The record doubles as the run slot: its exclusive create is what keeps two
 * `up` runs seconds apart from landing two daemons on one persist root, and
 * the claim comes before secret generation, so a run that does not hold the
 * slot never reaches the credential key.
 */
export interface RunRecord {
  port: number;
  url: string;
  startedAt: number;
  logPath: string;
  pid?: number;
  pgid?: number;
  servedAt?: number;
}

/**
 * A claim with no pid is another `up` mid-spawn until the widest readiness
 * bound has passed; anything older is stale. One value shared with the npx
 * readiness bound, so the two rules cannot disagree.
 */
export const STALE_RECORD_MS = 120_000;

declare const brand: unique symbol;
/**
 * Proof of holding the run slot. `claimRunSlot` is the only constructor, and
 * `checkGenerationGuards` requires one as an argument it never reads — so
 * moving secret generation above the claim, or reaching it from a branch that
 * starts nothing, is a type error rather than a review note.
 */
export type SlotClaim = {
  readonly port: number;
  readonly startedAt: number;
  readonly [brand]: "slot";
};

export type OwnershipProof =
  | { kind: "ours"; record: RunRecord }
  | { kind: "no-record" }
  | { kind: "claim-pending"; record: RunRecord } // no pid, younger than the bound
  | { kind: "stale"; record: RunRecord | null } // dead pid, no pid past the bound, or unparseable
  | { kind: "pid-alive-port-silent"; record: RunRecord; served: boolean }
  | { kind: "foreign" }; // port answers, proof fails

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/**
 * Read the run record. Returns the record, `null` for an absent file, and
 * `null` for a present file that is not a parseable record — a zero-byte or
 * truncated engine.json from an `up` killed mid-write, or a shape a later
 * version wrote. An unparseable record is a *stale* record, not an error:
 * throwing would put every `up` and `down` permanently out of action over a
 * file that holds nothing which cannot be rebuilt. (The opposite of
 * readConfigFile, which propagates every error but ENOENT — an unreadable
 * config may hold the only copy of a credential key.)
 */
export function readRunRecord(paths: EnginePaths): RunRecord | null {
  let text: string;
  try {
    text = readFileSync(paths.recordPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
  return parseRecord(text);
}

function parseRecord(text: string): RunRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.port !== "number" ||
    typeof r.url !== "string" ||
    typeof r.startedAt !== "number" ||
    typeof r.logPath !== "string"
  ) {
    return null;
  }
  for (const optional of ["pid", "pgid", "servedAt"]) {
    if (r[optional] !== undefined && typeof r[optional] !== "number") {
      return null;
    }
  }
  return value as unknown as RunRecord;
}

/**
 * Claim the run slot: an exclusive create (`wx`) of engine.json, cross-process
 * whichever kind of second caller arrives. The loser gets back the record it
 * collided with (or `null` for an unparseable one) so it branches on a value
 * it holds rather than re-reading later.
 */
export function claimRunSlot(
  paths: EnginePaths,
  opts: { port: number; logPath: string; now: () => number },
): { won: true; claim: SlotClaim; record: RunRecord } | { won: false; record: RunRecord | null } {
  const record: RunRecord = {
    port: opts.port,
    url: `http://localhost:${opts.port}`,
    startedAt: opts.now(),
    logPath: opts.logPath,
  };
  try {
    writeFileSync(paths.recordPath, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (err) {
    if (errorCode(err) === "EEXIST") {
      return { won: false, record: readRunRecord(paths) };
    }
    throw err;
  }
  const claim = {
    port: record.port,
    startedAt: record.startedAt,
  } as SlotClaim;
  return { won: true, claim, record };
}

/**
 * Rewrite the record through a temp name and a rename, so a reader never sees
 * half a record. Random suffix, not a pid — this module may not read
 * `process`.
 */
export function writeRunRecord(paths: EnginePaths, record: RunRecord): void {
  const tmpPath = `${paths.recordPath}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmpPath, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(tmpPath, paths.recordPath);
}

/**
 * Remove the record only if it is still the one that was read (matched on
 * startedAt), so a run can never unlink a claim another run made in the
 * meantime. Returns whether the record was removed.
 */
export function removeRunRecordIfUnchanged(
  paths: EnginePaths,
  startedAt: number,
): boolean {
  const current = readRunRecord(paths);
  if (current === null || current.startedAt !== startedAt) return false;
  try {
    unlinkSync(paths.recordPath);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
  return true;
}

/**
 * The unparseable-record variant of the conditional removal: unlink only when
 * the file is still present and still not a parseable record, keeping the
 * never-unlink-another's-claim property for the one case startedAt cannot
 * match against.
 */
export function removeUnparseableRunRecord(paths: EnginePaths): boolean {
  let text: string;
  try {
    text = readFileSync(paths.recordPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
  if (parseRecord(text) !== null) return false;
  try {
    unlinkSync(paths.recordPath);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
  return true;
}

/**
 * Whether a pid is alive AND ours to signal. `kill(pid, 0)` throws ESRCH for a
 * pid that does not exist and EPERM for a live process the caller may not
 * signal; only a clean return proves a pid this CLI both sees and may act on.
 * EPERM is "not ours" — the honest reading, since a signal would fail anyway
 * and the process is by definition not the daemon this CLI spawned.
 */
export function pidIsOurs(
  pid: number,
  kill: (pid: number, signal: number | string) => void,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The two-part ownership proof `down` acts on and `up`'s found-engine rows
 * consult: the recorded pid is alive and ours, AND the recorded port answers a
 * shape-matching health probe. A failed proof never reaches a signal.
 */
export async function proveOwnership(
  paths: EnginePaths,
  deps: {
    kill: (pid: number, signal: number | string) => void;
    classify: (port: number) => Promise<PortClass>;
    now: () => number;
    staleMs?: number;
  },
): Promise<OwnershipProof> {
  let text: string;
  try {
    text = readFileSync(paths.recordPath, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "no-record" };
    throw err;
  }
  const record = parseRecord(text);
  if (record === null) return { kind: "stale", record: null };

  const staleMs = deps.staleMs ?? STALE_RECORD_MS;
  if (record.pid === undefined) {
    return deps.now() - record.startedAt < staleMs
      ? { kind: "claim-pending", record }
      : { kind: "stale", record };
  }

  const alive = pidIsOurs(record.pid, deps.kill);
  const portClass = await deps.classify(record.port);
  if (alive && portClass === "engine") return { kind: "ours", record };
  if (alive) {
    return {
      kind: "pid-alive-port-silent",
      record,
      served: record.servedAt !== undefined,
    };
  }
  if (portClass === "engine") return { kind: "foreign" };
  return { kind: "stale", record };
}

/**
 * Whether a live daemon started from this config is holding `port`. The
 * question the config layer asks on every command, to scope the file-held
 * drive token: a loopback address on the recorded port names an address and
 * not an engine, and any local process can own one — an `ssh -L` forward to
 * another host included. The record names the pid that claimed the port, and a
 * pid this CLI may signal is a process on this machine, so a record whose port
 * matches and whose pid is alive rules the forward out. A live daemon holding
 * 8787 makes a second listener on 8787 impossible.
 *
 * The synchronous half of `proveOwnership`, and deliberately so: `loadConfig`
 * runs on every command and cannot await a probe. The health probe belongs to
 * `up` and `down`, which have somewhere to report a failed proof.
 *
 * A missing record, a record for a different port, or a record still mid-claim
 * (no pid yet) all answer false — each is a state in which nothing has been
 * proven, and the fail-closed direction withholds the secret.
 */
export function localDaemonHoldsPort(
  paths: EnginePaths,
  port: number,
  kill: (pid: number, signal: number | string) => void,
): boolean {
  let record: RunRecord | null;
  try {
    record = readRunRecord(paths);
  } catch {
    // An unreadable record proves nothing either. Withhold rather than raise:
    // this runs on every command, and a permissions problem on engine.json is
    // not a reason to take the whole CLI out.
    return false;
  }
  if (record === null || record.port !== port) return false;
  if (record.pid === undefined) return false;
  return pidIsOurs(record.pid, kill);
}
