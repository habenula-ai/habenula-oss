// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient } from "../api-client";
import { EngineUnavailableError } from "../api-client";

/**
 * How long a kill keeps retrying against an unavailable engine before giving
 * up (sized to a wrangler-dev reload), and the interval between attempts.
 * Source constants, not config.
 */
export const KILL_RETRY_WINDOW_MS = 30_000;
export const KILL_RETRY_INTERVAL_MS = 1_000;

/** Injected clock/sleep so tests drive the retry window without waiting. */
export interface RunKillOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * The injected cancel channel (mirrors `runConnect`): Ctrl-C during the retry
   * window aborts the wait and gives up rather than freezing until the window
   * elapses. Injected because the two entry points own their input differently
   * — the standalone command relies on the default SIGINT (Ctrl-C kills the
   * process); the REPL wires it to its own SIGINT slot so a give-up never grabs
   * stdin or exits the process. Making the printed "Ctrl-C to give up"
   * cue true is the point.
   */
  signal?: AbortSignal;
}

/**
 * The kill switch — the one one-shot that retries rather than failing fast.
 * A kill's intent is durable and safety-critical:
 * grants live in DO SQLite and survive an engine restart, so a kill typed
 * mid-restart must land the moment the engine is back rather than being lost
 * to a fail-fast exit. Kill is idempotent, so a retry that lands after an
 * earlier one silently succeeded is still safe. If the window elapses first,
 * the last availability error rethrows so `wrap()` exits 2 and prints the full
 * guidance once. A non-availability `ApiError` is never retried — it surfaces
 * immediately.
 *
 * While retrying, a terse status goes to stderr (not stdout) with no `error:`
 * prefix — it is a transient state, not a terminal failure, and a kill that
 * lands after a restart must not have emitted an `error:` line. The full
 * actionable guidance is left to `wrap()` on give-up, so it is never printed
 * twice.
 */
export async function runKill(
  client: ApiClient,
  opts: RunKillOptions = {},
): Promise<number> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const signal = opts.signal;
  const start = now();
  let lastKind: EngineUnavailableError["kind"] | null = null;
  for (;;) {
    try {
      await client.kill();
      break;
    } catch (err) {
      if (!(err instanceof EngineUnavailableError)) throw err;
      if (now() - start >= KILL_RETRY_WINDOW_MS) throw err;
      // stderr, no `error:` prefix: this is a transient retry state, and
      // the window is checked after each attempt — so under a `deadline`
      // stall the total wait can run one attempt's deadline past the window
      // ("about", not exactly). Re-emitted only when the failure kind flips
      // across the window (reject↔deadline), so the state text never goes
      // stale but the line does not spam once per interval.
      if (err.kind !== lastKind) {
        lastKind = err.kind;
        const state = err.kind === "deadline" ? "not responding" : "not reachable";
        console.error(
          `Engine ${state} at ${err.apiUrl}. Retrying kill for about ${Math.round(KILL_RETRY_WINDOW_MS / 1000)}s — it lands the moment the engine is back (Ctrl-C to give up).`,
        );
      }
      await abortableSleep(KILL_RETRY_INTERVAL_MS, sleep, signal);
      // Ctrl-C during the wait gives up (the printed cue is now true): rethrow
      // the last availability error rather than retrying. In the REPL this
      // propagates to the dispatch catch, which routes it through the engine
      // tracker — the REPL transitions offline and starts probing, so the
      // give-up leaves the surface in a coherent state rather than pretending
      // the engine is up. Checked before looping so no further attempt
      // is issued after the user has bailed.
      if (signal?.aborted) throw err;
    }
  }
  console.log("Kill switch activated — all grants cleared, policy set to deny.");
  // Kill is deny-all only: connections and credentials are preserved, so the
  // user can resume without re-running OAuth.
  console.log("Connections and credentials are preserved.");
  return 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep racing the cancel signal, so Ctrl-C ends the wait in milliseconds
 * rather than after up to a full retry interval (mirrors `runConnect`'s helper).
 * The underlying sleep is not torn down on abort — a timer resolving late is
 * harmless; the race just stops waiting.
 */
function abortableSleep(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    // Settle on either outcome: a sleep that rejects still just means "done
    // waiting", and must not leave this promise (and the retry loop) hung.
    void sleep(ms).then(settle, settle);
  });
}
