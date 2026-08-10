// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Command, InvalidArgumentError } from "commander";
import { ApiClient, EngineUnavailableError } from "./api-client";
import { nodeFetch } from "./transport";
import { formatError } from "./errors";
import { runChatRepl } from "./commands/chat";
import { EXIT_CANCELLED, runConnect } from "./commands/connect";
import { runDisconnect } from "./commands/disconnect";
import { runKill } from "./commands/kill";
import { runLog, runLogDump, runLogVerify } from "./commands/log";
import { EXIT_BROKEN_CHAIN, EXIT_CONFLICTED_CLOSER } from "./audit/walk";
import { runCap } from "./commands/cap";
import { runPolicyList } from "./commands/policy";
import { runQuit } from "./commands/quit";
import { runStatus } from "./commands/status";
import {
  runTaskCancel,
  runTaskList,
  runTaskShow,
  runTaskWatch,
} from "./commands/task";
import { spawn } from "node:child_process";
import { runDown } from "./commands/down";
import { runUp } from "./commands/up";
import { loadConfig } from "./config";
import { makePresenceGate, type PresenceGate } from "./gate/confirm-presence";

export interface CliRunners {
  chat: () => Promise<number>;
  up: (opts?: { visualModel?: boolean }) => Promise<number>;
  down: () => Promise<number>;
  connect: (service?: string, timeoutSeconds?: number) => Promise<number>;
  disconnect: (service: string) => Promise<number>;
  status: () => Promise<number>;
  kill: () => Promise<number>;
  quit: () => Promise<number>;
  policyList: () => Promise<number>;
  cap: (opts?: { monthlyCents?: number; sessionCents?: number }) => Promise<number>;
  taskList: (opts?: { limit?: number; all?: boolean }) => Promise<number>;
  taskShow: (taskId: string) => Promise<number>;
  taskCancel: (taskId: string) => Promise<number>;
  taskWatch: () => Promise<number>;
  log: (opts?: { limit?: number }) => Promise<number>;
  logDump: (path: string) => Promise<number>;
  logVerify: (opts?: { file?: string }) => Promise<number>;
}

function wrap<A extends unknown[]>(fn: (...args: A) => Promise<number>) {
  return async (...args: A): Promise<void> => {
    try {
      const code = await fn(...args);
      if (code !== 0) {
        process.exit(code);
      }
    } catch (err) {
      process.stderr.write(`${formatError(err)}\n`);
      // Exit 2 is reserved for the availability state:
      // scripts read "engine down" vs exit 1 for every other failure. The
      // contract holds only while runners let EngineUnavailableError
      // propagate here uncaught — a runner catch must stay ApiError-typed.
      process.exit(err instanceof EngineUnavailableError ? 2 : 1);
    }
  };
}

export function createProgram(runners: CliRunners): Command {
  const program = new Command();

  program
    .name("habenula")
    .description("Habenula CLI — Habenula agent platform")
    .version("0.0.0")
    .action(wrap(() => runners.chat()));

  program
    .command("chat")
    .description("Start an interactive chat session")
    .action(wrap(() => runners.chat()));

  program
    .command("up")
    .description(
      "Start the local engine if it is not already running, and report the URL it serves",
    )
    .option(
      "--visual-model",
      "Also serve the read-only visual model page at /dev/model, and report its URL",
    )
    .action(
      wrap((opts: { visualModel?: boolean }) =>
        runners.up({ visualModel: opts.visualModel === true }),
      ),
    );

  program
    .command("down")
    .description(
      "Stop the engine this CLI started (the session and its grants are untouched)",
    )
    .action(wrap(() => runners.down()));

  program
    .command("status")
    .description("Show the active session, connected services, and default policy")
    .action(wrap(() => runners.status()));

  program
    .command("kill")
    .description("Kill switch: clear all grants, set policy to deny (connections preserved)")
    .action(wrap(() => runners.kill()));

  program
    .command("quit")
    .description("End the active session: grants expire, the slot frees (connections preserved)")
    .action(wrap(() => runners.quit()));

  program
    .command("connect")
    .argument("[service]", "Service to connect (e.g. mock_email, gmail)")
    .option(
      "--timeout <seconds>",
      "Bound the OAuth wait explicitly (for piped/scripted runs; default 300)",
      parsePositiveIntSeconds,
    )
    .description(
      "Connect a service via OAuth; run without a service to list the connectable services",
    )
    .action(
      wrap((service: string | undefined, options: { timeout?: number }) =>
        runners.connect(service, options.timeout),
      ),
    );

  program
    .command("disconnect")
    .argument("<service>", "Service to disconnect")
    .description("Disconnect a service")
    .action(wrap((service: string) => runners.disconnect(service)));

  const policy = program
    .command("policy")
    .description("Show governance policy");

  policy
    .command("list")
    .description("List all policy entries")
    .action(wrap(() => runners.policyList()));

  program
    .command("cap")
    .description(
      "Show the spending caps and window totals; --monthly/--session set them (dollars)",
    )
    .option("--monthly <dollars>", "Set the monthly cap in dollars", parseDollarsToCents)
    .option("--session <dollars>", "Set the per-session cap in dollars", parseDollarsToCents)
    .action(
      wrap((options: { monthly?: number; session?: number }) =>
        runners.cap({
          ...(options.monthly !== undefined ? { monthlyCents: options.monthly } : {}),
          ...(options.session !== undefined ? { sessionCents: options.session } : {}),
        }),
      ),
    );

  const task = program
    .command("task")
    .description("Inspect and manage the task queue");

  task
    .command("list")
    .description("List the tasks the agent(s) are working on, newest first")
    .option("--limit <n>", "Tasks per page (server-clamped)", parsePositiveIntCount)
    .option("--all", "Follow pagination to the end instead of the newest page only")
    .action(
      wrap((options: { limit?: number; all?: boolean }) =>
        runners.taskList({ ...options }),
      ),
    );

  task
    .command("show")
    .argument("<id>", "Task id (from `task list`)")
    .description("Show one task's full record, including its per-action breakdown")
    .action(wrap((id: string) => runners.taskShow(id)));

  task
    .command("cancel")
    .argument("<id>", "Task id (from `task list`)")
    .description("Cancel a queued or parked task of any origin")
    .action(wrap((id: string) => runners.taskCancel(id)));

  task
    .command("watch")
    .description("Live-poll the task queue until interrupted (Ctrl-C)")
    .action(wrap(() => runners.taskWatch()));

  // A command group that carries its own action: bare `habenula log` shows
  // the newest page. cli-doc-drift.test.ts's ACTIONABLE_GROUPS set names it.
  const log = program
    .command("log")
    .description("Show the newest audit-log entries (page one; `log dump` reaches the rest)")
    .option("--limit <n>", "Entries to show (server-clamped)", parsePositiveIntCount)
    .action(wrap((options: { limit?: number }) => runners.log({ ...options })));

  log
    .command("dump")
    .argument("<path>", "Destination file; `-` writes the dump to stdout (progress stays on stderr)")
    .description(
      "Write the complete audit chain as JSONL — can run to hundreds of MB on a long history",
    )
    .action(wrap((path: string) => runners.logDump(path)));

  log
    .command("verify")
    .option("--file <path>", "Verify a dump file instead of the live engine; `-` reads stdin")
    .description(
      "Recompute every hash locally and verify the chain (3 = broken, 4 = edge unchecked, 5 = conflicted closers)",
    )
    .action(wrap((options: { file?: string }) => runners.logVerify({ ...options })));

  return program;
}

/** Upper bound on `--timeout`, in seconds (24h). Keeps the parsed value well
 * inside the range where `Number` is exact, so a giant digit string can't slip
 * through as a precision-lossy, nonsensical timeout. No real OAuth wait
 * approaches this. */
const MAX_TIMEOUT_SECONDS = 86_400;

/** Upper bound on `--limit` for `task list`. The engine clamps to its own page
 * cap; this only rejects input that clearly isn't a page size. */
const MAX_LIST_LIMIT = 10_000;

/** Reject a non-integer, non-positive, or absurdly large `--limit` at parse time.
 * Same strict-decimal-digits rule as the timeout parser, with a count-shaped
 * message so the error doesn't talk about seconds. */
function parsePositiveIntCount(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new InvalidArgumentError(
      `--limit must be a positive integer (max ${MAX_LIST_LIMIT})`,
    );
  }
  return n;
}

/** Upper bound on a cap set via `--monthly`/`--session`, in dollars. Same
 * why as the other bounds: reject input that clearly isn't a spending cap
 * while staying far inside `Number`'s exact-integer range once in cents. */
const MAX_CAP_DOLLARS = 1_000_000;

/** Parse a dollars amount (`50`, `12.50`) to integer cents, rejecting
 * anything else at parse time. Same strict-decimal-digits posture as the
 * other parsers — no `1e5`, no `0x10`, no negatives — plus at most two
 * decimal places, because cents are the storage unit
 * and a third place would be silently lost. Zero is allowed: "$0" is a
 * legitimate every-spend-asks posture, not an error. */
function parseDollarsToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  const n = Number(value);
  if (!match || n > MAX_CAP_DOLLARS) {
    throw new InvalidArgumentError(
      `--monthly/--session must be a dollar amount with at most two decimal places (max ${MAX_CAP_DOLLARS})`,
    );
  }
  const wholeCents = Number(match[1]) * 100;
  const fraction = match[2] ?? "";
  const fractionCents =
    fraction.length === 0 ? 0 : Number(fraction.padEnd(2, "0"));
  return wholeCents + fractionCents;
}

/** Reject a non-integer, non-positive, or absurdly large `--timeout` at parse
 * time. Format is strict decimal digits: a bare `Number(...)` would also accept
 * `1e5`, `0x10`, and whitespace-padded values, none of which read as a plain
 * seconds count. */
function parsePositiveIntSeconds(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n <= 0 || n > MAX_TIMEOUT_SECONDS) {
    throw new InvalidArgumentError(
      `--timeout must be a positive integer number of seconds (max ${MAX_TIMEOUT_SECONDS})`,
    );
  }
  return n;
}

/**
 * Run `runConnect` with the standalone command's cancel wiring:
 * the process owns SIGINT here, so a handler aborts
 * the injected signal for the call's duration and is removed in `finally`,
 * restoring default Ctrl-C handling. The in-REPL `:connect` wires its own
 * signal through the REPL's input machinery instead (chat.ts).
 *
 * The abort signal only bounds the wait's poll sleep, so a Ctrl-C during the
 * initial connect POST, or during the best-effort cleanup, is observed only
 * once that in-flight request returns. A second Ctrl-C is the user's escape
 * hatch: it force-exits with the cancel code immediately, matching the shell's
 * "mash Ctrl-C to give up" convention rather than making them wait out (or
 * SIGKILL) a hung Worker.
 *
 * `run` is injected only so tests can assert the SIGINT install/teardown and
 * the seconds→ms conversion without a live wait; it defaults to `runConnect`.
 */
export async function runConnectStandalone(
  client: ApiClient,
  service?: string,
  timeoutSeconds?: number,
  run: typeof runConnect = runConnect,
): Promise<number> {
  const controller = new AbortController();
  let aborting = false;
  const onSigint = (): void => {
    if (aborting) {
      // Second Ctrl-C: the first abort is stuck behind an in-flight request
      // (initial POST or cleanup). Hand the shell back now.
      process.exit(EXIT_CANCELLED);
    }
    aborting = true;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    return await run(client, service, {
      cancelSignal: controller.signal,
      ...(timeoutSeconds !== undefined
        ? { timeoutMs: timeoutSeconds * 1000 }
        : {}),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Run a walk command (`log dump` / `log verify`) with the standalone SIGINT
 * wiring, on `runConnectStandalone`'s pattern: install the handler, abort the
 * injected controller on the first Ctrl-C (the walk unwinds at a page
 * boundary and the runner RETURNS its code), force-exit on a second, remove
 * the listener in `finally`. Keeping this at the composition root leaves both
 * runners signal-injectable and free of process-global state.
 *
 * The force-exit cannot read the walk's accumulated verdict — it runs inside
 * the signal handler — so it reads two booleans instead, raised through
 * `onBreakFound` and `onConflictFound` the moment the walk locates each
 * finding. Without them the escape hatch would silently discard a located
 * finding, on the path a user takes when a command is slow — which is when a
 * long walk has had the most time to find one.
 *
 * The exit here restates `summarizeWalk`'s precedence — 3 over 5 over 130 —
 * BY HAND, because the handler cannot call the summarizer. Written twice on
 * purpose; a change to the ladder changes both places.
 *
 * `run` is injected so tests can assert the SIGINT install/teardown and the
 * force-exit's flags without a live walk.
 */
export async function runWalkStandalone(
  run: (opts: {
    cancelSignal: AbortSignal;
    onBreakFound: () => void;
    onConflictFound: () => void;
  }) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  let aborting = false;
  let breakFound = false;
  let conflictFound = false;
  const onSigint = (): void => {
    if (aborting) {
      // Second Ctrl-C: the first abort is stuck behind a request already in
      // flight. Hand the shell back now — a located finding still outranks
      // the cancel, and integrity outranks semantics.
      process.exit(
        breakFound
          ? EXIT_BROKEN_CHAIN
          : conflictFound
            ? EXIT_CONFLICTED_CLOSER
            : EXIT_CANCELLED,
      );
    }
    aborting = true;
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    return await run({
      cancelSignal: controller.signal,
      onBreakFound: () => {
        breakFound = true;
      },
      onConflictFound: () => {
        conflictFound = true;
      },
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/**
 * Exported for the per-command exit-2 tests: they must
 * drive the REAL runners against a rejecting fetch, so a runner that demoted
 * the availability error to a returned exit-1 code fails the assertion.
 */
export function buildRunners(client: ApiClient, confirmPresence: PresenceGate): CliRunners {
  return {
    // The Human Touch gate rides only the runner that renders confirmation
    // prompts; `undefined` falls through to chat.ts's private defaultIO.
    chat: () => runChatRepl(client, undefined, { confirmPresence }),
    // The one place `up`'s effects are read from the real process — the
    // engine-lifecycle modules themselves may not touch it (eslint ban).
    up: (opts?: { visualModel?: boolean }) =>
      runUp(
        {
          env: process.env,
          cwd: () => process.cwd(),
          nodePath: process.execPath,
          spawn,
          kill: (pid, signal) => process.kill(pid, signal),
          fetchFn: nodeFetch,
          now: () => Date.now(),
          write: (line) => process.stdout.write(`${line}\n`),
          writeErr: (line) => process.stderr.write(`${line}\n`),
        },
        { visualModel: opts?.visualModel === true },
      ),
    down: () =>
      runDown({
        env: process.env,
        kill: (pid, signal) => process.kill(pid, signal),
        fetchFn: nodeFetch,
        now: () => Date.now(),
        write: (line) => process.stdout.write(`${line}\n`),
        writeErr: (line) => process.stderr.write(`${line}\n`),
      }),
    connect: (service?: string, timeoutSeconds?: number) =>
      runConnectStandalone(client, service, timeoutSeconds),
    disconnect: (service: string) => runDisconnect(client, service),
    status: () => runStatus(client),
    kill: () => runKill(client),
    quit: () => runQuit(client),
    policyList: () => runPolicyList(client),
    cap: (opts?: { monthlyCents?: number; sessionCents?: number }) => runCap(client, opts),
    taskList: (opts?: { limit?: number; all?: boolean }) => runTaskList(client, opts),
    taskShow: (taskId: string) => runTaskShow(client, taskId),
    taskCancel: (taskId: string) => runTaskCancel(client, taskId),
    taskWatch: () => runTaskWatch(client),
    log: (opts?: { limit?: number }) => runLog(client, opts),
    logDump: (path: string) =>
      runWalkStandalone(({ cancelSignal }) => runLogDump(client, path, { cancelSignal })),
    logVerify: (opts?: { file?: string }) =>
      runWalkStandalone(({ cancelSignal, onBreakFound, onConflictFound }) =>
        runLogVerify(client, { ...opts, cancelSignal, onBreakFound, onConflictFound }),
      ),
  };
}

/**
 * The composition root: read the real environment once, wire the clients, hand
 * argv to Commander. Exported and never self-invoked — src/bin.ts is the
 * process entry. Two test files import this module for `createProgram`, and a
 * module-scope `main()` would make importing the CLI start the CLI.
 *
 * `loadConfig` is total: a config file it could not read or parse arrives as
 * `config.configFault` rather than a throw, so `--help`, `--version`, and the
 * offline `log verify --file` still work. The fault surfaces at the first
 * request instead (see requireUsableConfig in config.ts).
 */
export async function main(): Promise<number> {
  const config = loadConfig();
  const client = new ApiClient(config);
  const gate = makePresenceGate(config);
  const program = createProgram(buildRunners(client, gate));
  await program.parseAsync(process.argv);
  return 0;
}
