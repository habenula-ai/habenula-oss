// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { closeSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import type { FetchFn } from "../api-client";
import {
  createConfigFile,
  mergeAbsentKeys,
  readConfigFile,
} from "../engine/config-file";
import { parseEnvFile } from "../engine/env-file";
import { openEngineLog, rotateEngineLog } from "../engine/engine-log";
import { ensureRoot, resolveEnginePaths, type EnginePaths } from "../engine/paths";
import {
  classifyPort,
  driveTokenAccepted,
  visualModelServed,
  PROBE_TIMEOUT_MS,
} from "../engine/probe";
import { resolveEngineCommand } from "../engine/resolve-engine-command";
import {
  claimRunSlot,
  pidIsOurs,
  readRunRecord,
  removeRunRecordIfUnchanged,
  removeUnparseableRunRecord,
  writeRunRecord,
  STALE_RECORD_MS,
  type RunRecord,
  type SlotClaim,
} from "../engine/run-record";
import { checkGenerationGuards } from "../engine/secrets";
import { stated } from "../engine/stated";

/**
 * `habenula up`: start the local engine if it is not already running, wait for
 * it to serve, and report the URL it bound. Two acts, and the order is
 * load-bearing: act one settles the port and what is on it, and every exit
 * from it leaves the disk untouched (one exception: a foreign engine whose
 * drive token answers records its port, and only its port). Act two resolves
 * spawn inputs, and the run-slot claim is its first statement — a run that
 * does not hold the slot never reaches secret generation.
 *
 * This module may not read `process` (see eslint.config.mjs): every effect
 * arrives through UpDeps, wired at the composition root in index.ts.
 */

/** The daemon's documented default port — wrangler dev's default too. */
export const DEFAULT_ENGINE_PORT = 8787;

/**
 * First-run selection's walk: the documented default plus nine above it.
 * Past the range `up` refuses rather than wandering.
 */
export const SCAN_PORTS: readonly number[] = [
  8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796,
];

/** A cold npx resolution fetches roughly 150 MB before the daemon starts booting. */
export const READY_BOUND_NPX_MS = 120_000;
/** A binary already on the machine: only the boot is being waited on. */
export const READY_BOUND_LOCAL_MS = 30_000;
/** Fast enough that the reported URL is not visibly late. */
export const READY_POLL_MS = 250;
/** The first progress line lands before a user wonders; repeats name the wait. */
export const PROGRESS_AFTER_MS = 3_000;
export const PROGRESS_EVERY_MS = 10_000;

/** Test-tunable timings; the composition root passes none of these. */
export interface UpBounds {
  readyBoundNpxMs: number;
  readyBoundLocalMs: number;
  pollMs: number;
  probeTimeoutMs: number;
  progressAfterMs: number;
  progressEveryMs: number;
  staleRecordMs: number;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: (string | number)[];
    env: Record<string, string | undefined>;
    shell: false;
  },
) => ChildProcess;

export interface UpDeps {
  env: Record<string, string | undefined>;
  cwd: () => string;
  /** The running Node binary; the engine resolver runs a carried engine with it. */
  nodePath: string;
  spawn: SpawnFn;
  kill: (pid: number, signal: number | string) => void;
  fetchFn: FetchFn;
  now: () => number;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  bounds?: Partial<UpBounds>;
  /** Test override of the scan walk; defaults to SCAN_PORTS. */
  scanPorts?: readonly number[];
}

/**
 * What the caller asked for on the command line, as distinct from UpDeps —
 * which carries effects. One member so far.
 */
export interface UpOptions {
  /**
   * `--visual-model`: start the engine with the read-only visual model page
   * served, and report its URL.
   *
   * It is a property of the engine `up` starts, not of the CLI run: the engine
   * reads `VISUAL_MODEL` at boot, so the flag reaches an engine only by
   * spawning one. It is deliberately not recorded in the config file either.
   * The port is an established fact about a persist root; whether you wanted
   * to watch the graph this time is not.
   */
  visualModel?: boolean;
}

function boundsOf(deps: UpDeps): UpBounds {
  return {
    readyBoundNpxMs: READY_BOUND_NPX_MS,
    readyBoundLocalMs: READY_BOUND_LOCAL_MS,
    pollMs: READY_POLL_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    progressAfterMs: PROGRESS_AFTER_MS,
    progressEveryMs: PROGRESS_EVERY_MS,
    staleRecordMs: STALE_RECORD_MS,
    ...deps.bounds,
  };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The CLI's copy of the daemon's HABENULA_PORT semantics (digits only, 1
 * through 65535, 0 refused). Re-stated rather than shared because the
 * published CLI declares no runtime dependencies and must not start; both
 * sides refuse rather than guess on a bad value, so a disagreement costs one
 * refusal on one side rather than a bad start.
 */
function parsePortValue(
  raw: string | undefined,
): { port: number } | { refusal: string } | { unset: true } {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { unset: true };
  if (!/^\d+$/.test(trimmed)) {
    return { refusal: `must be a whole number, got "${raw}"` };
  }
  const port = Number(trimmed);
  if (port === 0) {
    return { refusal: "cannot be 0 (port 0 binds a random free port)" };
  }
  if (port > 65535) {
    return { refusal: `must be between 1 and 65535, got ${port}` };
  }
  return { port };
}

/** A port from a file `up` does not own: a bad value reads as unset. */
function lenientPort(raw: string | undefined): number | null {
  const parsed = parsePortValue(raw);
  return "port" in parsed ? parsed.port : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runUp(deps: UpDeps, opts: UpOptions = {}): Promise<number> {
  const b = boundsOf(deps);
  const paths = resolveEnginePaths(deps.env);
  // A malformed or environment-only config line throws ConfigFileError here,
  // which wrap() renders as the one-line refusal and exit 1.
  const fileVars = readConfigFile(paths.configPath);

  // The HABENULA_API_URL check is two checks at two moments. The host half
  // needs nothing but the variable: a non-loopback target means the CLI is
  // configured to talk to an engine somewhere else, and no port `up` could
  // resolve would change that.
  const statedApiUrl = stated(deps.env.HABENULA_API_URL);
  const apiUrl = parseApiUrl(statedApiUrl);
  if (apiUrl !== null && "refusal" in apiUrl) {
    deps.writeErr(apiUrl.refusal);
    return 1;
  }

  // The working-directory .env, read once and passed to both guard 4 and the
  // scan. Absent OR malformed reads as absent: it is not our file, and
  // refusing on it would block a start for a syntax error in a file `up`
  // does not own.
  const cwdEnvVars = readCwdEnv(join(deps.cwd(), ".env"));

  // Port resolution: the environment, else the recorded port, else the scan.
  const resolved = await resolvePort(deps, b, paths, fileVars, cwdEnvVars);
  if ("code" in resolved) return resolved.code;
  const { port, source } = resolved;

  // The port half of the HABENULA_API_URL check compares against the port
  // `up` RESOLVED — not the recorded one, which a first run does not have.
  if (apiUrl !== null && apiUrl.port !== port) {
    deps.writeErr(
      `habenula up: HABENULA_API_URL is ${statedApiUrl}, and ${describePortSource(source, paths)} is ${port}. ` +
        `Unset HABENULA_API_URL to use that port, or set it to http://localhost:${port}.`,
    );
    return 1;
  }

  const cls = await classifyPort(port, {
    fetchFn: deps.fetchFn,
    timeoutMs: b.probeTimeoutMs,
  });
  if (cls === "engine") {
    return reportFoundEngine(deps, paths, port, opts);
  }
  if (cls === "listener") {
    deps.writeErr(
      `habenula up: something that is not a habenula engine is listening on port ${port}` +
        (source === "recorded"
          ? `, the port recorded in ${paths.configPath}. Stop it, or move the engine by editing HABENULA_PORT in that file — a new port is a new OAuth origin, so registered redirect URLs move with it.`
          : source === "env"
            ? ` (from HABENULA_PORT). Set HABENULA_PORT to a free port.`
            : `. Set HABENULA_PORT to a free port.`),
    );
    return 1;
  }

  // Nothing on the port: act two.
  return spawnBranch(deps, b, paths, fileVars, cwdEnvVars, port, source, opts);
}

type PortSource = "env" | "recorded" | "scan";

function describePortSource(source: PortSource, paths: EnginePaths): string {
  switch (source) {
    case "env":
      return "HABENULA_PORT in your environment";
    case "recorded":
      return `the port recorded in ${paths.configPath}`;
    case "scan":
      return "the port habenula up resolved";
  }
}

/**
 * Parse HABENULA_API_URL for the two-moment check; null when unset. The caller
 * passes the `stated` value, so a blank export falls through to the local
 * engine rather than reaching `new URL("")` and refusing as a malformed URL.
 */
function parseApiUrl(
  raw: string | undefined,
): { port: number } | { refusal: string } | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      refusal: `habenula up: HABENULA_API_URL (${raw}) is not a valid URL. Unset it to use the local engine.`,
    };
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return {
      refusal:
        `habenula up: HABENULA_API_URL points at ${raw}, so this CLI is configured to talk to an engine somewhere else. ` +
        "habenula up manages the local engine only — unset HABENULA_API_URL to use it.",
    };
  }
  return { port: url.port === "" ? 80 : Number(url.port) };
}

function readCwdEnv(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseEnvFile(text, path, { pathVariables: "allow" });
  } catch {
    return null;
  }
}

async function resolvePort(
  deps: UpDeps,
  b: UpBounds,
  paths: EnginePaths,
  fileVars: Record<string, string> | null,
  cwdEnvVars: Record<string, string> | null,
): Promise<{ port: number; source: PortSource } | { code: number }> {
  const fromEnv = parsePortValue(deps.env.HABENULA_PORT);
  if ("refusal" in fromEnv) {
    deps.writeErr(`habenula up: HABENULA_PORT ${fromEnv.refusal}. Unset it to use the default ${DEFAULT_ENGINE_PORT}.`);
    return { code: 1 };
  }
  if ("port" in fromEnv) return { port: fromEnv.port, source: "env" };

  const fromFile = parsePortValue(fileVars?.HABENULA_PORT);
  if ("refusal" in fromFile) {
    deps.writeErr(
      `habenula up: the HABENULA_PORT recorded in ${paths.configPath} ${fromFile.refusal}. Fix that line and run habenula up again.`,
    );
    return { code: 1 };
  }
  if ("port" in fromFile) return { port: fromFile.port, source: "recorded" };

  // First-run selection — but a persist root that already holds a store with
  // no recorded port is a refusal, not a selection: starting on a different
  // port breaks every OAuth redirect registered against the old one.
  if (existsSync(join(paths.root, "do"))) {
    deps.writeErr(
      `habenula up: ${paths.root} holds engine state, and no port is recorded for it. ` +
        `Set HABENULA_PORT to the port that engine served on, or record it in ${paths.configPath}. ` +
        "Starting on a different port breaks every OAuth redirect registered against the old one.",
    );
    return { code: 1 };
  }

  // The scan walks the whole range looking for an engine first — an engine
  // ends the scan, because walking past one is how a container self-hoster
  // ends up with a second engine over a second store. Only if no engine is
  // anywhere in the range does the first refused (free) port become the
  // selection. A working-directory .env's declared port is probed first:
  // detection only, guard 4's file read serving its second purpose.
  const walk = deps.scanPorts ?? SCAN_PORTS;
  const envFilePort = lenientPort(cwdEnvVars?.HABENULA_PORT ?? undefined);
  const probeList =
    envFilePort !== null && !walk.includes(envFilePort)
      ? [envFilePort, ...walk]
      : walk;
  let firstFree: number | null = null;
  for (const candidate of probeList) {
    const cls = await classifyPort(candidate, {
      fetchFn: deps.fetchFn,
      timeoutMs: b.probeTimeoutMs,
    });
    if (cls === "engine") return { port: candidate, source: "scan" };
    if (cls === "refused" && firstFree === null && walk.includes(candidate)) {
      firstFree = candidate;
    }
  }
  if (firstFree === null) {
    deps.writeErr(
      `habenula up: every port from ${walk[0]} to ${walk[walk.length - 1]} is held by something else. ` +
        "Set HABENULA_PORT to a free port.",
    );
    return { code: 1 };
  }
  return { port: firstFree, source: "scan" };
}

/**
 * Both found-engine rows: an engine is serving the port. A found engine is
 * not a usable engine, so both rows check the drive token before reporting —
 * "your next command will work" is the promise `up` makes.
 *
 * The config is re-read here rather than threaded through: a run that lost
 * the claim read the file before the winner generated into it, and reporting
 * the winner's engine with the pre-generation (empty) token would 401 an
 * engine that is perfectly reachable.
 */
async function reportFoundEngine(
  deps: UpDeps,
  paths: EnginePaths,
  port: number,
  opts: UpOptions,
): Promise<number> {
  const fileVars = readConfigFile(paths.configPath);
  const record = readRunRecord(paths);
  const owned =
    record !== null &&
    record.port === port &&
    record.pid !== undefined &&
    pidIsOurs(record.pid, deps.kill);

  const tokenFromEnv = stated(deps.env.HABENULA_INTERNAL_MCP_TOKEN);
  const token = tokenFromEnv ?? stated(fileVars?.INTERNAL_MCP_TOKEN);
  const userId = resolveUserId(deps, fileVars);
  const drive = await driveTokenAccepted(
    port,
    { token, userId },
    { fetchFn: deps.fetchFn },
  );
  const url = `http://localhost:${port}`;

  if (drive === "accepted") {
    if (owned) {
      deps.write(`Engine already running at ${url} (pid ${record.pid}).`);
      await reportVisualModelOnFoundEngine(deps, port, userId, opts, true);
      return 0;
    }
    deps.write(
      `An engine is already serving ${url}, and this CLI did not start it. ` +
        "It accepted the drive token, so habenula commands will reach it. Nothing was started.",
    );
    // The drive-token answer is the proof that records a port — and only the
    // port. The redirect base belongs to whoever runs that engine.
    recordEstablished(paths, { HABENULA_PORT: String(port) });
    await reportVisualModelOnFoundEngine(deps, port, userId, opts, false);
    return 0;
  }

  const tokenDescription =
    tokenFromEnv !== undefined
      ? "the HABENULA_INTERNAL_MCP_TOKEN in your environment"
      : token !== undefined
        ? `the drive token in ${paths.configPath}`
        : "an empty drive token (none is configured)";
  const verdict =
    drive === "rejected"
      ? `It rejected ${tokenDescription}`
      : "It answered the health probe and not the drive surface";

  if (owned) {
    deps.writeErr(
      `habenula up: the engine already running at ${url} (pid ${record.pid}) is one this CLI started, but ${verdict.charAt(0).toLowerCase()}${verdict.slice(1)}, ` +
        "so habenula commands will not reach it. The running engine holds a different INTERNAL_MCP_TOKEN than your config does — " +
        "run habenula down, then habenula up again.",
    );
    return 1;
  }
  deps.writeErr(
    `habenula up: an engine is already serving ${url}, and this CLI did not start it. ${verdict}, ` +
      "so habenula commands will not reach it. If that engine is your container, export its INTERNAL_MCP_TOKEN " +
      "as HABENULA_INTERNAL_MCP_TOKEN, or stop it and run habenula up again.",
  );
  return 1;
}

/**
 * The user the page observes, resolved the way every other command resolves
 * it. `/dev/model` defaults to `cli-user` on its own, but the URL is printed
 * for a human to open, and a URL that names the DO is one less thing to know.
 */
function resolveUserId(
  deps: UpDeps,
  fileVars: Record<string, string> | null,
): string {
  return (
    stated(deps.env.HABENULA_USER_ID) ??
    stated(fileVars?.HABENULA_USER_ID) ??
    "cli-user"
  );
}

/**
 * The page's URL and the two facts an operator has to hold about it: it reads
 * and never writes, and it is unauthenticated on loopback like the rest of the
 * local engine. Printed on the run that turned it on, so the caveat travels
 * with the invitation rather than living only in a doc.
 */
function reportVisualModel(deps: UpDeps, port: number, userId: string): void {
  deps.write(
    `Visual model at http://localhost:${port}/dev/model?userId=${encodeURIComponent(userId)}`,
  );
  deps.write("  ! Read-only, and unauthenticated on loopback like the rest of the local");
  deps.write("    engine. It goes away when the engine stops.");
}

/**
 * `--visual-model` against an engine that is already serving. The flag reaches
 * an engine through its environment at boot, so this run cannot turn the page
 * on — but the engine may already have it, and telling someone to restart an
 * engine that is already serving the page would be wrong. So ask it.
 */
async function reportVisualModelOnFoundEngine(
  deps: UpDeps,
  port: number,
  userId: string,
  opts: UpOptions,
  owned: boolean,
): Promise<void> {
  if (opts.visualModel !== true) return;
  const served = await visualModelServed(port, {
    fetchFn: deps.fetchFn,
    timeoutMs: boundsOf(deps).probeTimeoutMs,
  });
  if (served) {
    reportVisualModel(deps, port, userId);
    return;
  }
  deps.write("  ! That engine was started without the visual model, and the page is");
  deps.write(
    owned
      ? "    served or not from boot. Run habenula down, then habenula up --visual-model."
      : "    served or not from boot. Restart that engine with VISUAL_MODEL=true set.",
  );
}

/** Record established config facts: create the file, or add only absent keys. */
function recordEstablished(
  paths: EnginePaths,
  vars: Record<string, string>,
): void {
  ensureRoot(paths);
  if (readConfigFile(paths.configPath) === null) {
    if (createConfigFile(paths.configPath, vars)) return;
  }
  mergeAbsentKeys(paths.configPath, vars);
}

async function spawnBranch(
  deps: UpDeps,
  b: UpBounds,
  paths: EnginePaths,
  fileVars: Record<string, string> | null,
  cwdEnvVars: Record<string, string> | null,
  port: number,
  source: PortSource,
  opts: UpOptions,
): Promise<number> {
  ensureRoot(paths);

  // Only one run reaches the spawn: the run slot is claimed before the child
  // is. Every loss goes through loseClaim, on both attempts — a second loss is
  // ordinary contention whenever the first one was a stale-record reclaim. Two
  // runs that start together over one stale record both remove it and both
  // retry, so the loser of the retry is colliding with a claim that is fresh
  // and live, and the answer to that is to wait on it rather than to call it
  // corruption. Only a loss that reads STALE twice is the shape of a bug:
  // something is recreating the record as fast as it is removed.
  let claim: SlotClaim | null = null;
  let claimRecord: RunRecord | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = claimRunSlot(paths, {
      port,
      logPath: paths.logPath,
      now: deps.now,
    });
    if (result.won) {
      claim = result.claim;
      claimRecord = result.record;
      break;
    }
    const outcome = await loseClaim(deps, b, paths, result.record, opts);
    if (outcome !== "reclaim") return outcome;
    if (attempt === 2) {
      deps.writeErr(
        `habenula up: the run-slot record read as stale twice in one run. Something keeps recreating ${paths.recordPath} — ` +
          "inspect it, and run habenula up again.",
      );
      return 1;
    }
  }
  if (claim === null || claimRecord === null) return 1; // unreachable; satisfies the checker

  // Engine command before secrets: a version-gate refusal should not leave
  // freshly generated secrets behind it.
  const command = resolveEngineCommand(deps.env, deps.nodePath);
  if ("refusal" in command) {
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    deps.writeErr(command.refusal);
    return 1;
  }
  const argv = command.argv;
  const executable = argv[0];
  if (executable === undefined || executable === "") {
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    deps.writeErr("habenula up: HABENULA_ENGINE_CMD is empty. Set it to a command line, or unset it.");
    return 1;
  }

  const guards = checkGenerationGuards(claim, {
    env: deps.env,
    fileVars,
    root: paths.root,
    configPath: paths.configPath,
    cwdEnvVars,
  });
  if ("refusal" in guards) {
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    deps.writeErr(guards.refusal);
    return 1;
  }

  // Write the generated secrets before the spawn — the daemon reads the
  // credential key from its environment at boot. The exclusive create is the
  // second line of defense (the slot claim is the first); a run that loses it
  // merges only absent keys and continues from the values that won.
  let effectiveFileVars = fileVars;
  const generated: Record<string, string> = {};
  if (guards.values.credentialKey !== undefined) {
    generated.CREDENTIAL_ENCRYPTION_KEY = guards.values.credentialKey;
  }
  if (guards.values.driveToken !== undefined) {
    generated.INTERNAL_MCP_TOKEN = guards.values.driveToken;
  }
  if (Object.keys(generated).length > 0) {
    if (createConfigFile(paths.configPath, generated)) {
      if (generated.CREDENTIAL_ENCRYPTION_KEY !== undefined) {
        deps.write(`No config found. Generated your engine secrets → ${paths.configPath}`);
        deps.write("  ! Back this file up. Without the encryption key, stored credentials");
        deps.write("    cannot be read again.");
      } else {
        deps.write(`Generated a drive token → ${paths.configPath}`);
      }
    } else {
      mergeAbsentKeys(paths.configPath, generated);
    }
    effectiveFileVars = readConfigFile(paths.configPath);
  }

  const credentialKey =
    stated(deps.env.CREDENTIAL_ENCRYPTION_KEY) ??
    stated(effectiveFileVars?.CREDENTIAL_ENCRYPTION_KEY);
  const driveToken =
    stated(deps.env.INTERNAL_MCP_TOKEN) ??
    stated(effectiveFileVars?.INTERNAL_MCP_TOKEN);
  if (credentialKey === undefined || driveToken === undefined) {
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    deps.writeErr(
      `habenula up: the engine secrets could not be resolved from ${paths.configPath} after writing them. ` +
        "Inspect the file and run habenula up again.",
    );
    return 1;
  }

  // The derived redirect base has two moments and one value: passed to the
  // child now, recorded only after the daemon answers. An environment or
  // file-held base wins and is never re-derived.
  const derivedBase = `http://localhost:${port}`;
  const includeBase =
    stated(deps.env.OAUTH_REDIRECT_BASE_URL) === undefined &&
    stated(effectiveFileVars?.OAUTH_REDIRECT_BASE_URL) === undefined;

  // Precedence by spread order: the file first so its variables reach the
  // child, the process environment second so an export wins, the resolved
  // values last. The engine's FORWARDED_BINDINGS allowlist decides what
  // reaches the Worker.
  //
  // The environment layer carries only its STATED variables, by the same rule
  // the CLI's own layering follows: a blank export is not a decision, and a
  // stray `ANTHROPIC_API_KEY=` in the shell must not shadow the file's key for
  // the daemon either. A stated value travels verbatim, untrimmed.
  //
  // Null prototype, like the env-file parser's record: `statedEnv.__proto__ =`
  // on a plain object hits the prototype setter and stores nothing, so an
  // environment variable of that name would vanish between the two spreads.
  const statedEnv: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(deps.env)) {
    if (value !== undefined && stated(value) !== undefined) statedEnv[key] = value;
  }

  // `--visual-model` lands after both inherited layers on purpose: a typed
  // flag is a clearer decision than a VISUAL_MODEL line left in the config
  // file or exported in the shell, so it wins over either. Its absence decides
  // nothing — a bare `up` leaves whatever those layers carry, which is how an
  // operator who set the variable keeps the page without repeating the flag.
  const childEnv: Record<string, string | undefined> = {
    ...(effectiveFileVars ?? {}),
    ...statedEnv,
    ...(opts.visualModel === true ? { VISUAL_MODEL: "true" } : {}),
    CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    INTERNAL_MCP_TOKEN: driveToken,
    HABENULA_PORT: String(port),
    // Explicit even when it resolved from the default: two defaults that
    // agree today are still two defaults.
    HABENULA_PERSIST_ROOT: paths.root,
    ...(includeBase ? { OAUTH_REDIRECT_BASE_URL: derivedBase } : {}),
  };

  // Only the branch that spawns rotates the log, and only in this order.
  rotateEngineLog(paths);
  const fd = openEngineLog(paths);
  deps.write("Starting the engine...");
  let child: ChildProcess;
  try {
    child = deps.spawn(executable, argv.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: childEnv,
      shell: false,
    });
  } catch (err) {
    closeSync(fd);
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    deps.writeErr(
      `habenula up: failed to spawn the engine (${executable}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  // The child holds its own duplicate of the descriptor from spawn; the
  // parent's copy is dead weight.
  closeSync(fd);
  child.unref();

  let exited = false;
  let exitCode: number | null = null;
  let spawnFailure: string | null = null;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  child.on("error", (err) => {
    exited = true;
    spawnFailure = err instanceof Error ? err.message : String(err);
  });

  // detached makes the child a process-group leader, so pgid is its own pid.
  const record: RunRecord = { ...claimRecord };
  if (child.pid !== undefined) {
    record.pid = child.pid;
    record.pgid = child.pid;
    writeRunRecord(paths, record);
  }

  const isNpx = executable === "npx";
  const outcome = await waitForReady(deps, b, {
    port,
    bound: isNpx ? b.readyBoundNpxMs : b.readyBoundLocalMs,
    childExited: () => exited,
    progressLabel: isNpx
      ? "Still waiting: npx is resolving the engine (a first run downloads it, which can take a couple of minutes)"
      : `Still waiting for the engine to answer on http://localhost:${port}`,
  });

  if (outcome === "ready") {
    writeRunRecord(paths, { ...record, servedAt: deps.now() });
    // The port becomes a fact only now, proven by an engine answering on it —
    // whatever its source. The derived base is recorded only when neither the
    // environment nor the file supplied one.
    const establish: Record<string, string> = { HABENULA_PORT: String(port) };
    if (includeBase) establish.OAUTH_REDIRECT_BASE_URL = derivedBase;
    recordEstablished(paths, establish);

    const scanBase = (deps.scanPorts ?? SCAN_PORTS)[0];
    deps.write(
      `Engine ready at http://localhost:${port}` +
        (source === "scan" && port !== scanBase
          ? `   (${scanBase} was held by something else)`
          : ""),
    );
    if (port !== DEFAULT_ENGINE_PORT) {
      deps.write(
        `  ! This engine's OAuth origin is http://localhost:${port}, not the ${DEFAULT_ENGINE_PORT} the`,
      );
      deps.write("    connect guides show. Register callback URLs against the origin above.");
    }
    if (
      stated(deps.env.ANTHROPIC_API_KEY) === undefined &&
      stated(effectiveFileVars?.ANTHROPIC_API_KEY) === undefined
    ) {
      deps.write("  ! No model key is set. The engine is up, but a conversation will fail");
      deps.write(`    until ANTHROPIC_API_KEY is in ${paths.configPath} or your environment.`);
    }
    if (opts.visualModel === true) {
      reportVisualModel(deps, port, resolveUserId(deps, effectiveFileVars));
    }
    deps.write(`Logs: ${paths.logPath}`);
    return 0;
  }

  if (outcome === "exited") {
    // The daemon's contract is one actionable line; print it verbatim, then
    // name the numeric code in the CLI's own line (the child's codes mean
    // something else in `up`'s documented table).
    const tail = lastNonEmptyLine(paths.logPath);
    if (tail !== null) deps.writeErr(tail);
    deps.writeErr(
      spawnFailure !== null
        ? `habenula up: the engine failed to start (${spawnFailure}).`
        : `habenula up: the engine exited with code ${exitCode ?? "unknown"} before serving. The full log is ${paths.logPath}.`,
    );
    removeRunRecordIfUnchanged(paths, claim.startedAt);
    return 1;
  }

  // The bound elapsed: the daemon was spawned and may be seconds from ready.
  // Leave the record and the daemon alone — this is the one `up` outcome a
  // second run can change.
  deps.writeErr(
    `habenula up: the engine was started and is not answering yet on http://localhost:${port}. ` +
      `It may still be coming up — check ${paths.logPath}, and run habenula down to stop it.`,
  );
  return 2;
}

/**
 * A run that lost the claim branches on the record the failed create handed
 * back. Returns an exit code, or "reclaim" for the stale row (which removes
 * the record it read — never one written since — and retries exactly once).
 */
async function loseClaim(
  deps: UpDeps,
  b: UpBounds,
  paths: EnginePaths,
  record: RunRecord | null,
  opts: UpOptions,
): Promise<number | "reclaim"> {
  if (record === null) {
    removeUnparseableRunRecord(paths);
    return "reclaim";
  }

  if (record.pid !== undefined && pidIsOurs(record.pid, deps.kill)) {
    const cls = await classifyPort(record.port, {
      fetchFn: deps.fetchFn,
      timeoutMs: b.probeTimeoutMs,
    });
    if (cls === "engine") {
      return reportFoundEngine(deps, paths, record.port, opts);
    }
    // The winner wrote its pid and the daemon is still booting: wait on the
    // same health probe the winner is waiting on.
    return waitOnOtherRun(deps, b, paths, record, opts);
  }

  if (
    record.pid === undefined &&
    deps.now() - record.startedAt < b.staleRecordMs
  ) {
    return waitOnOtherRun(deps, b, paths, record, opts);
  }

  // Stale: a dead pid, or no pid past the bound.
  removeRunRecordIfUnchanged(paths, record.startedAt);
  return "reclaim";
}

/** The loser's wait: the winner's poll loop with a child that never exits. */
async function waitOnOtherRun(
  deps: UpDeps,
  b: UpBounds,
  paths: EnginePaths,
  record: RunRecord,
  opts: UpOptions,
): Promise<number> {
  const outcome = await waitForReady(deps, b, {
    port: record.port,
    // The widest bound: the loser cannot know which path the winner took.
    bound: b.readyBoundNpxMs,
    childExited: () => false,
    progressLabel: `Another habenula up is starting the engine — waiting for it to answer on http://localhost:${record.port}`,
  });
  if (outcome === "ready") {
    return reportFoundEngine(deps, paths, record.port, opts);
  }
  deps.writeErr(
    `habenula up: the engine was started and is not answering yet on http://localhost:${record.port}. ` +
      `It may still be coming up — check ${record.logPath}, and run habenula down to stop it.`,
  );
  return 2;
}

/**
 * The readiness race as a poll loop, not Promise.race: the child's exit code
 * and the last log line both have to be read after the loop, and a rejected
 * race would lose one of them. Shared by the winner (real childExited flag)
 * and the loser (a flag that never fires).
 */
async function waitForReady(
  deps: UpDeps,
  b: UpBounds,
  opts: {
    port: number;
    bound: number;
    childExited: () => boolean;
    progressLabel: string;
  },
): Promise<"ready" | "exited" | "bound"> {
  const start = deps.now();
  let nextProgress = start + b.progressAfterMs;
  for (;;) {
    if (opts.childExited()) return "exited";
    const cls = await classifyPort(opts.port, {
      fetchFn: deps.fetchFn,
      timeoutMs: b.probeTimeoutMs,
    });
    if (cls === "engine") return "ready";
    if (opts.childExited()) return "exited";
    const t = deps.now();
    if (t - start >= opts.bound) return "bound";
    if (t >= nextProgress) {
      deps.write(`${opts.progressLabel}...`);
      nextProgress = t + b.progressEveryMs;
    }
    await sleep(b.pollMs);
  }
}

function lastNonEmptyLine(logPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}
