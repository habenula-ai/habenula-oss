// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Human Touch presence gate: an
 * optional macOS Touch ID check consulted immediately before the CLI sends an
 * affirmative approval (`task`/`session`) to POST /api/resolve. `deny` and
 * `tell_more` never consult it.
 *
 * Honest tier-1, not a security boundary: the check runs entirely CLI-side and
 * the engine accepts /api/resolve with no proof of presence attached — a
 * compromised process holding a valid token bypasses it entirely. Do not cite
 * this gate as mitigating the compromised-local-agent threat.
 *
 * Direction of failure: fail CLOSED (approval withheld) on a real failure of an
 * enabled gate — `denied` and `error` — and fail OPEN when the feature isn't
 * usable: toggle off, non-macOS, biometrics unavailable (`unavailable`), or
 * helper not built (`missing`). Every fail-open of an *enabled* gate is
 * surfaced, never silent: `missing` re-notes on every ungated approval (it's a
 * fixable build gap), and `unavailable` notes once (it usually means this Mac
 * has no sensor — but the same code also covers biometric access denied to an
 * unsigned POC binary, so silent ungating must stay detectable). A bug here may
 * withhold an approval; it must never fabricate one.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "../config";

/** The config-bound nullary form threaded into `renderPrompt`. */
export type PresenceGate = () => Promise<boolean>;

/**
 * The runner's classified result. A discriminated union rather than a raw exit
 * code, so the gate never re-derives meaning arithmetically (`!== 1` would fail
 * OPEN on a signal-killed child, where `code === null`).
 */
export type HelperResult = "ok" | "denied" | "unavailable" | "missing" | "error";

/** Injectable seam, mirroring `RunConnectOptions` in commands/connect.ts. */
export interface PresenceDeps {
  /** Override for tests — defaults to `process.platform`. */
  platform?: () => string;
  /** Override for tests — defaults to spawning the native helper. */
  runHelper?: () => Promise<HelperResult>;
  /** Override for tests — defaults to a stderr line. */
  warn?: (msg: string) => void;
  /** Override for tests — defaults to `import.meta.url` (bundle detection). */
  moduleUrl?: string;
}

/** The Touch ID prompt's own deadline — unrelated to the held call's expiry (holds live until the session passes 90 minutes). */
export const PRESENCE_TIMEOUT_MS = 30_000;

const MISSING_NOTE =
  "Human Touch is enabled but the Touch ID helper isn't built — approvals are proceeding ungated; run 'just build-presence-helper'.";
const UNAVAILABLE_NOTE =
  "Human Touch is enabled but biometrics are unavailable (no Touch ID sensor, not enrolled, or access denied) — approvals are proceeding ungated.";
const ERROR_NOTE =
  "Human Touch: the Touch ID helper failed — the approval was not sent. Retry, choose Deny, or unset HABENULA_HUMAN_TOUCH to disable the gate.";
const BUNDLED_NOTE =
  "Human Touch is enabled but is not available in the packaged CLI (the Touch ID helper ships only in a source checkout) — approvals are being withheld. Run from source, or unset HABENULA_HUMAN_TOUCH to disable the gate.";

/** Notes that fire once per gate instance; `MISSING_NOTE` deliberately repeats. */
const ONCE_NOTES = new Set([UNAVAILABLE_NOTE, ERROR_NOTE, BUNDLED_NOTE]);

function defaultWarn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Decide whether an affirmative approval may be sent. `true` — proceed; `false`
 * — withhold (the caller re-prompts; the held call stays parked). Stateless:
 * the `error`-note latch lives in `makePresenceGate`.
 */
export async function confirmPresence(
  config: Config,
  deps: PresenceDeps = {},
): Promise<boolean> {
  if (!config.humanTouch) return true;
  const platform = deps.platform ?? (() => process.platform);
  if (platform() !== "darwin") return true;

  const warn = deps.warn ?? defaultWarn;
  // Bundle guard: the helper path anchors on this module's URL,
  // which under the packaged `dist/index.js` points into `dist/` — where the
  // helper never ships. Left to `spawnPresenceHelper` that resolves to a
  // `missing` classification and fails OPEN, silently ungating an *enabled*
  // gate. Catch it here and fail CLOSED instead: the gate isn't wired for the
  // bundle, so an affirmative approval must not proceed unchecked.
  if (isBundledAnchor(deps.moduleUrl ?? import.meta.url)) {
    warn(BUNDLED_NOTE);
    return false;
  }

  const runHelper = deps.runHelper ?? defaultRunHelper;
  // A total switch over the union: an unhandled value is a type error (the
  // function would no longer return `boolean` on every path), never a silent
  // fail-open.
  switch (await runHelper()) {
    case "ok":
      return true;
    case "unavailable":
      // Usually a genuine no-sensor Mac, but the same probe failure also covers
      // biometric access denied to an unsigned binary — note it (once) so an
      // enabled gate never fails open without a trace.
      warn(UNAVAILABLE_NOTE);
      return true;
    case "missing":
      warn(MISSING_NOTE);
      return true;
    case "denied":
      return false;
    case "error":
      warn(ERROR_NOTE);
      return false;
  }
}

/**
 * Bind the gate to config so callers thread a nullary `PresenceGate`, and latch
 * the once-per-instance notes (`ONCE_NOTES`). The fail cases differ on
 * repetition: `error` fails CLOSED and `renderPrompt` already prints a
 * per-attempt "Approval not confirmed" line; `unavailable` usually means fixed
 * hardware — so both note once. `missing` is a fixable build gap that fails
 * OPEN, so its note repeats on every ungated approval rather than latching.
 */
export function makePresenceGate(config: Config, deps: PresenceDeps = {}): PresenceGate {
  const warnedOnce = new Set<string>();
  const baseWarn = deps.warn ?? defaultWarn;
  const warn = (msg: string): void => {
    if (ONCE_NOTES.has(msg)) {
      if (warnedOnce.has(msg)) return;
      warnedOnce.add(msg);
    }
    baseWarn(msg);
  };
  return () => confirmPresence(config, { ...deps, warn });
}

/**
 * The structural slice of a spawned child the runner needs — injectable so the
 * classification below is unit-testable with a fake child (the minimal-typings
 * pattern `chat.ts` uses for readline).
 */
export interface HelperChild {
  on(event: "error", cb: (err: Error & { code?: string }) => void): void;
  on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
}

/**
 * Build the default runner: spawn the helper and classify its outcome. This is
 * the SOLE place a child's `(code, signal)` becomes a `HelperResult`:
 *
 *   exit 0 → ok · exit 1 → denied · exit 2 → unavailable ·
 *   spawn ENOENT → missing · signal / null code / other → error
 *
 * The child races a timeout: on expiry the runner settles `denied` FIRST, then
 * kills the child — the `settled` latch keeps the kill's signalled `close` from
 * double-settling into a spurious `error`.
 */
export function makeRunHelper(
  spawnHelper: () => HelperChild = spawnPresenceHelper,
  timeoutMs: number = PRESENCE_TIMEOUT_MS,
): () => Promise<HelperResult> {
  return () =>
    new Promise((resolve) => {
      let settled = false;
      const settle = (result: HelperResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = spawnHelper();
      const timer = setTimeout(() => {
        settle("denied"); // a walked-away user is a non-confirmation, not an error
        child.kill();
      }, timeoutMs);
      child.on("error", (err) => settle(err.code === "ENOENT" ? "missing" : "error"));
      child.on("close", (code, signal) => {
        if (signal !== null || code === null) settle("error");
        else if (code === 0) settle("ok");
        else if (code === 1) settle("denied");
        else if (code === 2) settle("unavailable");
        else settle("error");
      });
    });
}

const defaultRunHelper = makeRunHelper();

/**
 * True when this module is running from the esbuild bundle rather than a source
 * checkout. esbuild inlines every source module into `dist/index.js`, so at
 * runtime `import.meta.url` resolves to a directory named `dist`;
 * under the dev flow (`tsx src/index.ts`) the anchor is `src/gate/`. Used by
 * `confirmPresence` to fail CLOSED in the bundle rather than let the helper
 * path miss and fail open. String-only (no `node:path`) to keep the CLI's
 * zero-dependency typings surface.
 */
function isBundledAnchor(moduleUrl: string): boolean {
  const dir = fileURLToPath(new URL(".", moduleUrl)).replace(/\\/g, "/");
  return /\/dist\/$/.test(dir);
}

/**
 * Located, not compiled at runtime: the fixed gitignored build-recipe output.
 * The path is resolved relative to THIS module's URL. Under the dev flow
 * (`tsx src/index.ts`) that is `src/gate/`, so `../../native/...` lands on the
 * package's `native/` dir — correct. Under the bundled `dist/index.js` the
 * anchor would be `dist/` and the path would miss; that case never
 * reaches here — `confirmPresence`'s bundle guard (`isBundledAnchor`) fails the
 * gate CLOSED before spawning. The presence gate is a dev/source feature; to
 * ship it in the bundle, resolve the anchor here and drop the bundle guard.
 */
function spawnPresenceHelper(): HelperChild {
  const helperPath = fileURLToPath(
    new URL("../../native/presence/bin/habenula-presence", import.meta.url),
  );
  return spawn(helperPath, [], { stdio: "ignore" }) as unknown as HelperChild;
}
