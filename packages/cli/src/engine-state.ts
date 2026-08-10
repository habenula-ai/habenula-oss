// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { EngineUnavailableError } from "./api-client";
import { recoveryLine, unavailableGuidance } from "./errors";

/**
 * REPL engine-state tracker. Owns the online/offline
 * state, the one-time transition announcements, the offline health-probe
 * loop, and the deferred launch handshake. All REPL surfaces route
 * availability failures through `noteFailure`; the poll gate and the loop
 * dispatcher query `isOffline()`.
 *
 * Recovery is confirmed by real work, not by the probe: a health 200 attests
 * that the process serves, not that the per-user DO is ready, so a reachable
 * probe only cues the re-run of the launch handshake, and the state flips
 * online only once that handshake completes. No online announcement until
 * real work goes through — no connected-then-dropped flap.
 */

/** Offline probe backoff: base interval doubling to the cap. Source constants. */
export const HEALTH_PROBE_BASE_MS = 1_000;
export const HEALTH_PROBE_MAX_MS = 8_000;

export interface EngineStateDeps {
  /** Echoed in the guidance line — the configured engine URL. */
  apiUrl: string;
  /** `ApiClient.probeHealth`: shape-matched 200 → true; never throws. */
  probeHealth: () => Promise<boolean>;
  /**
   * The deferred launch handshake, run notice-suppressed: it drives the raw
   * `startSession()` and lets availability errors propagate, but renders no
   * started/refusal/unverified notice — the reconnect is narrated by the
   * recovery line alone (a mid-session engine restart 409-refuses EVERY
   * recovery handshake, so replaying the attach notice would be noise).
   */
  runLaunchHandshake: () => Promise<void>;
  /** The boot nudge, deferred to recovery when boot was offline. The wiring
   * guards it to at most once per session, so repeated recoveries never re-nudge. */
  onFirstRunNudge: () => Promise<void>;
  /** Output sink for the guidance and recovery lines (console.log in the REPL). */
  write: (line: string) => void;
  /**
   * Diagnostic sink for the one swallowed case: a recovery handshake that threw
   * a NON-availability error (see `runProbeLoop`). Recovery semantics are kept
   * — a reached engine is online — but the error is surfaced here so a genuine
   * bug (e.g. a `TypeError` in the handshake) is not silently discarded and
   * mislabelled as a clean connect. Defaults to a no-op; the REPL wires stderr.
   */
  diagnose?: (message: string) => void;
  /** Injected scheduler so tests drive the probe backoff without waiting. */
  sleep: (ms: number) => Promise<void>;
  /** True while the REPL is live; the probe loop stops when it reads false. */
  isActive: () => boolean;
}

export class EngineState {
  private online = true;
  private offlineKind: "reject" | "deadline" = "reject";
  private probing = false;

  constructor(private readonly deps: EngineStateDeps) {}

  isOnline(): boolean {
    return this.online;
  }

  isOffline(): boolean {
    return !this.online;
  }

  /**
   * The one-line restatement a foreground user action gets while already
   * offline — an explicit action is never met with silence, but repeated
   * background failures are (announce-on-transition, not per tick).
   */
  offlineNotice(): string {
    return unavailableGuidance(this.deps.apiUrl, this.offlineKind);
  }

  /**
   * The single entry every REPL surface routes availability failures to.
   * The flap rule: a transport reject transitions
   * offline from either surface; a deadline expiry transitions offline only
   * when foreground — a background-poll deadline retries next tick without
   * flapping the visible state (`source` exists solely for this asymmetry).
   */
  noteFailure(err: EngineUnavailableError, source: "foreground" | "background"): void {
    if (this.isOffline()) return; // announced on transition, not per tick
    if (err.kind === "deadline" && source === "background") return; // no flap
    this.enterOffline(err.kind);
  }

  private enterOffline(kind: "reject" | "deadline"): void {
    this.online = false;
    this.offlineKind = kind;
    this.deps.write(unavailableGuidance(this.deps.apiUrl, kind));
    if (!this.probing) {
      this.probing = true;
      void this.runProbeLoop();
    }
  }

  /**
   * While offline and active: sleep the backoff, probe `/api/health`, and on
   * a shape-matched probe re-run the launch handshake. A handshake that
   * throws availability means still-not-ready — keep probing. A handshake
   * that completes (or throws a non-availability error, meaning the engine
   * was reached) flips online. Unbounded by design: each probe inside it is
   * deadline-bounded, the loop persists until recovery or exit.
   */
  private async runProbeLoop(): Promise<void> {
    try {
      let interval = HEALTH_PROBE_BASE_MS;
      while (this.isOffline() && this.deps.isActive()) {
        await this.deps.sleep(interval);
        interval = Math.min(interval * 2, HEALTH_PROBE_MAX_MS);
        if (!this.isOffline() || !this.deps.isActive()) break;
        if (!(await this.deps.probeHealth())) continue;
        try {
          await this.deps.runLaunchHandshake();
        } catch (err) {
          if (err instanceof EngineUnavailableError) continue; // still down
          // Reached the engine — a reachable-engine error is still recovery,
          // but surface it: an unexpected handshake bug would otherwise vanish
          // behind "Engine connected." and only resurface on the next request.
          this.deps.diagnose?.(
            `engine reached on recovery but the launch handshake errored: ${String(err)}`,
          );
        }
        // The handshake spans an await; a teardown (isActive → false) may have
        // landed meanwhile — don't write the recovery line into a torn-down
        // REPL (the fire-and-forgotten loop outlives close otherwise).
        if (!this.deps.isActive()) break;
        this.goOnline();
      }
    } finally {
      this.probing = false;
    }
  }

  private goOnline(): void {
    this.online = true;
    this.deps.write(recoveryLine(this.offlineKind));
    // The deferred boot nudge; the wiring's once-guard makes re-runs no-ops.
    void this.deps.onFirstRunNudge();
  }
}
