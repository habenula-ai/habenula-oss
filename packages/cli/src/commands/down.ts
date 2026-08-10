// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FetchFn } from "../api-client";
import { resolveEnginePaths, type EnginePaths } from "../engine/paths";
import { classifyPort, PROBE_TIMEOUT_MS } from "../engine/probe";
import {
  proveOwnership,
  removeRunRecordIfUnchanged,
  removeUnparseableRunRecord,
  STALE_RECORD_MS,
  type OwnershipProof,
  type RunRecord,
} from "../engine/run-record";

/**
 * `habenula down`: stop the engine this CLI started, and nothing more. The
 * two-part ownership proof (recorded pid alive and ours, recorded port
 * answering as an engine) must hold before any signal is sent — `down` never
 * signals a process it cannot prove is the engine, and a failed proof is a
 * refusal that says why.
 *
 * Stopping the process is not a governance boundary: the session keeps aging
 * on its wall clock, grants and held calls survive a restart inside the
 * window, and the output says so every time.
 *
 * This module may not read `process` (see eslint.config.mjs): every effect
 * arrives through DownDeps, wired at the composition root in index.ts.
 */

/** Bounds the SIGTERM wait before escalation. */
export const TERM_WAIT_MS = 10_000;
/** Bounds the re-probe that decides whether to report stopped or still-answering. */
export const POST_KILL_PROBE_MS = 3_000;
/** The stop wait's poll cadence. */
export const DOWN_POLL_MS = 250;

export interface DownBounds {
  termWaitMs: number;
  postKillProbeMs: number;
  pollMs: number;
  probeTimeoutMs: number;
  staleRecordMs: number;
}

export interface DownDeps {
  env: Record<string, string | undefined>;
  kill: (pid: number, signal: number | string) => void;
  fetchFn: FetchFn;
  now: () => number;
  write: (line: string) => void;
  writeErr: (line: string) => void;
  bounds?: Partial<DownBounds>;
}

function boundsOf(deps: DownDeps): DownBounds {
  return {
    termWaitMs: TERM_WAIT_MS,
    postKillProbeMs: POST_KILL_PROBE_MS,
    pollMs: DOWN_POLL_MS,
    probeTimeoutMs: PROBE_TIMEOUT_MS,
    staleRecordMs: STALE_RECORD_MS,
    ...deps.bounds,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compile-time exhaustiveness: a seventh proof kind is a type error here. */
function unreachableProof(proof: never): never {
  throw new Error(`unhandled ownership proof: ${JSON.stringify(proof)}`);
}

export async function runDown(deps: DownDeps): Promise<number> {
  const b = boundsOf(deps);
  const paths = resolveEnginePaths(deps.env);
  const proof: OwnershipProof = await proveOwnership(paths, {
    kill: deps.kill,
    classify: (port) =>
      classifyPort(port, { fetchFn: deps.fetchFn, timeoutMs: b.probeTimeoutMs }),
    now: deps.now,
    staleMs: b.staleRecordMs,
  });

  // Every kind is answered explicitly. The one wrong answer this command can
  // give is a false "nothing was running" — it would send a user away
  // believing their engine is stopped.
  switch (proof.kind) {
    case "no-record": {
      deps.write("No engine to stop: this CLI has not started one.");
      return 0;
    }

    case "stale": {
      if (proof.record === null) {
        removeUnparseableRunRecord(paths);
      } else {
        removeRunRecordIfUnchanged(paths, proof.record.startedAt);
      }
      deps.write(
        "No engine to stop: the recorded run is gone, and the stale record has been removed.",
      );
      return 0;
    }

    case "claim-pending": {
      // Another `up` is mid-spawn: there is no pid to aim at yet, and the
      // record belongs to a run that is about to write one into it. Removing
      // it would put that spawn outside any slot.
      deps.writeErr(
        "habenula down: another habenula up is starting the engine, and no pid is recorded yet. " +
          "Run habenula down again once it finishes.",
      );
      return 1;
    }

    case "pid-alive-port-silent": {
      const { record } = proof;
      if (proof.served) {
        deps.writeErr(
          `habenula down: pid ${record.pid} is alive but nothing is answering on port ${record.port}, so this ` +
            "CLI cannot prove that process is the engine and will not signal it. An engine " +
            "that stops serving exits on its own within about a minute. Wait, then run " +
            "habenula down again. If the pid is still alive after that, it is not the engine.",
        );
      } else {
        deps.writeErr(
          `habenula down: pid ${record.pid} is alive but never answered on port ${record.port}, so this ` +
            "CLI cannot prove that process is the engine and will not signal it. Read " +
            `${record.logPath} for why it did not come up. If that pid is the stalled ` +
            "engine, stop it yourself; habenula up will not reuse the port until it is gone.",
        );
      }
      return 1;
    }

    case "foreign": {
      // The same rule as everywhere else in this design: a failed proof never
      // reaches a signal.
      deps.writeErr(
        "habenula down: an engine is answering on the recorded port, and it is not one this CLI " +
          "started, so it will not be signalled. If it is your container, stop it with " +
          "docker compose down.",
      );
      return 1;
    }

    case "ours": {
      return stopOwnedEngine(deps, b, paths, proof.record);
    }
  }
  return unreachableProof(proof);
}

async function stopOwnedEngine(
  deps: DownDeps,
  b: DownBounds,
  paths: EnginePaths,
  record: RunRecord,
): Promise<number> {
  // proveOwnership only returns "ours" for a record with a live pid.
  const pid = record.pid as number;
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    // Already gone between the proof and the signal; the poll decides.
  }

  let stopped = await waitForPortToRefuse(deps, b, record.port, b.termWaitMs);
  if (!stopped) {
    // Escalation targets the process group, never the pid: SIGKILL runs no
    // exit hook, so a pid-only kill would strand workerd holding the socket.
    if (record.pgid === undefined) {
      deps.writeErr(
        `habenula down: the engine (pid ${pid}) did not stop on SIGTERM, and the run record holds ` +
          "no process group to escalate to — habenula down will not fall back to signalling the " +
          "pid alone. Stop the process yourself, then run habenula down again.",
      );
      return 1;
    }
    try {
      deps.kill(-record.pgid, "SIGKILL");
    } catch {
      // The group died between the wait and the escalation.
    }
    stopped = await waitForPortToRefuse(deps, b, record.port, b.postKillProbeMs);
  }

  if (!stopped) {
    // The one thing worse than a stuck engine is being told it is gone — the
    // record stays, and the port's state is reported as found.
    deps.writeErr(
      `habenula down: something is still answering on port ${record.port} after escalation. ` +
        "The engine was not stopped.",
    );
    return 1;
  }

  removeRunRecordIfUnchanged(paths, record.startedAt);
  deps.write(`Engine stopped. Your state is kept in ${paths.root}.`);
  // Unconditional: this line is the whole answer to "down is not a
  // governance boundary".
  deps.write("This did not end your session or clear grants.");
  return 0;
}

async function waitForPortToRefuse(
  deps: DownDeps,
  b: DownBounds,
  port: number,
  boundMs: number,
): Promise<boolean> {
  const start = deps.now();
  for (;;) {
    const cls = await classifyPort(port, {
      fetchFn: deps.fetchFn,
      timeoutMs: b.probeTimeoutMs,
    });
    if (cls === "refused") return true;
    if (deps.now() - start >= boundMs) return false;
    await sleep(b.pollMs);
  }
}
