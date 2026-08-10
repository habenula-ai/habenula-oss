// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Proactive held-call poll.
 *
 * The reactive path (a `held`-carrying `/api/chat` turn, in `handleChatTurn`)
 * only surfaces a hold the *current* turn raised. A hold can also appear with
 * no user turn at all — an inbound MCP commission bounces the guard while
 * the user sits idle at the `> ` prompt. This poll is the surface that makes
 * such a call legible: it reads `GET /api/status` on an interval and, when a
 * fresh held call appears, draws the same confirmation prompt the reactive path
 * draws (which now renders the commission origin/goal + `↑ incoming` badge —
 * shipped alongside this module).
 *
 * The core design task is the readline interleaving. The REPL idles
 * inside `rl.question("> ")`, so the shared readline is *always* awaiting a line
 * exactly when the poll fires. `node:readline/promises` will not queue a second
 * concurrent `question`, and writing over the pending one corrupts the
 * half-typed buffer. Candidate 1 (chosen) composes over the input instead of
 * racing it: erase the input line, draw the confirmation above it, restore the
 * half-typed buffer. This module owns that mechanism against an injectable
 * `PollableIO`, so it is unit-testable without spawning a terminal — the same
 * injectable-IO posture `ReplIO` takes in `commands/chat.ts`.
 *
 * On the `busy`/409 question, now settled: an arriving *commission* that loses
 * the turn gate gets `busy` at the `habenula_commission` MCP tool (no run
 * created — not a `ResolveResponse` field), and a *resume* that loses it is the
 * HTTP 409 `TURN_IN_PROGRESS` envelope that the `renderPrompt` already
 * re-prompts on. `ResolveResponse` stays `info | resumed` — there is no typed
 * variant to consume — so the poll needs nothing further here.
 *
 * This is now wired into `runChatRepl` (step 11): the REPL runs on a `line`
 * listener (not an idle `rl.question`), a single router hands each line to the
 * idle dispatcher or, while a confirmation is open, its choice reader; the
 * production `PollableIO` adapter's erase is display-width-aware; and the poll
 * shares one `PromptLatch` with the reactive path. The idle-render gate (idle
 * render without input corruption; poll + reactive never double-render;
 * polled-resume 409 re-prompt) is covered by `test/commands/repl-poll.test.ts`.
 */

import type { HeldCallRecord, StatusResponse } from "@habenula-ai/contracts";

/** Poll cadence. A source constant, not config. */
export const POLL_INTERVAL_MS = 3_000;

/**
 * How many ticks to skip a held call after a render/resolve failure. A
 * persistent `/api/resolve` fault would otherwise redraw the same prompt every
 * interval — erasing the user's input each time with no feedback (the failure
 * `renderPrompt` rethrows on a non-404/409 resolve error). Backing off lets the
 * user keep typing; the hold resurfaces once the cooldown lapses.
 */
export const RENDER_FAILURE_COOLDOWN_TICKS = 3;

/**
 * The subset of the terminal the poll composes over (candidate 1). A production
 * adapter wraps `node:readline`'s cursor/erase helpers plus the `Interface`'s
 * current-buffer accessor; tests pass a fake that records the call order, so a
 * test can assert the input line was erased *before* the prompt drew and
 * restored *after* — with the half-typed buffer intact. The adapter (0025C)
 * owns display-width-aware erase for a buffer that spans multiple visual rows.
 */
export interface PollableIO {
  /**
   * Whether to defer this tick instead of drawing over the input. The raw-mode
   * editor defers only while its completion menu is open (it owns the buffer and
   * can lift a half-typed line aside); the plain readline reader defers while the
   * user is mid-typing (it cannot). See `ReplIO.deferPoll`.
   */
  deferPoll(): boolean;
  /** Wipe the pending `> …` input line so the prompt can draw from column 0. */
  eraseInputLine(): void;
  /** Re-issue the `> ` prompt (the editor restores any stashed buffer itself). */
  restoreInputLine(): void;
  /** Feed the latest status snapshot so the input surface can repaint its live status line. */
  setStatus(status: StatusResponse): void;
}

/**
 * The reactive-vs-proactive latch. Held while a confirmation prompt is
 * open and *unresolved*, so a poll tick cannot re-read a not-yet-resolved call
 * and double-render, and the reactive path and the poll never both render the
 * same hold. It clears on `resolve()` completion, **not** on prompt-open — a
 * call parked until resolution stays latched, so the next tick skips it.
 *
 * Shared between this poll and the reactive `renderPrompt` path once the REPL
 * is rewired; until then the poll owns its own instance.
 */
export class PromptLatch {
  private activeId: string | null = null;

  /** True while a prompt is open and unresolved (either path). */
  get busy(): boolean {
    return this.activeId !== null;
  }

  /**
   * Claim the latch for a held call. Returns true only if the latch was free and
   * the caller now owns the prompt. Returns false whenever a prompt is already
   * open — **including for the same id**. No single path ever re-acquires an id it
   * already holds: the reactive path (`handleChatTurn`) acquires once and drives
   * the whole prompt (tell-more / 409 re-prompts included) inside that one claim,
   * and the poll guards its own `tryAcquire` behind `busy` (and behind the same
   * `busy` check across ticks). So a same-id "re-acquire" can only come from the
   * *other* path racing the same hold between its `busy` read and here — which is
   * exactly the double-render (two prompts, one orphaned choice reader → wedged
   * REPL) this latch exists to reject. An idempotent same-id `return true` here
   * would let that race through, so it is deliberately absent.
   */
  tryAcquire(heldCallId: string): boolean {
    if (this.activeId !== null) return false; // a prompt is already open (either path)
    this.activeId = heldCallId;
    return true;
  }

  /**
   * Release on resolve completion (grant/deny/expiry), freeing the next tick.
   * Ownership-checked: only the holder can free it. So the shared reactive-path
   * shape `try { … } finally { release(id) }` on a branch whose own
   * `tryAcquire` returned false (the poll owns the prompt) cannot free the
   * poll's claim mid-prompt — the exact double-render the latch prevents.
   */
  release(heldCallId: string): void {
    if (this.activeId === heldCallId) this.activeId = null;
  }
}

export interface PollDeps {
  /**
   * Aggregate status read; the poll uses only `.held`. No signal: the request
   * layer's control deadline bounds the read, so a poll-read timeout surfaces
   * as an availability failure with `kind: "deadline"` — which the REPL's
   * flap rule needs.
   */
  getStatus: () => Promise<StatusResponse>;
  /**
   * Render the held prompt and drive it to a resolution. In the wired REPL this
   * is a thin wrapper over `renderPrompt`; injected so the poll is testable
   * without the reactive renderer's readline/resolve machinery.
   */
  renderHeld: (record: HeldCallRecord) => Promise<void>;
  io: PollableIO;
  /** Shared with the reactive path once the REPL is rewired; poll-owned today. */
  latch: PromptLatch;
  /** True while the REPL is live; the loop stops the first tick it reads false. */
  isActive: () => boolean;
  /**
   * True while the REPL is offline: a paused tick issues
   * no read — the health probe is the only offline traffic — and the latch
   * and render-failure cooldowns are left untouched, so the poll resumes on
   * recovery with that state intact.
   */
  isPaused?: () => boolean;
  /** Injected scheduler (defaults to an unref'd setTimeout-based sleep). */
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /**
   * A tick that throws (Worker unreachable, a render/resolve error) is caught so
   * the loop keeps polling; the sink is injectable and defaults to a muted
   * stderr line rather than silence — a wedged poll is the one failure the user
   * can't otherwise see. The wiring PR supplies a REPL-aware sink.
   */
  onError?: (err: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't keep the process alive for up to one interval after quit.
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * The muted stderr sink for a failed tick. Exported so the REPL's
 * availability-aware sink can keep exactly this rendering for every
 * NON-availability error while routing availability to the state tracker.
 */
export function defaultPollOnError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // stderr, not stdout — never corrupts the readline prompt on stdout.
  process.stderr.write(`\n(background check failed: ${message})\n`);
}

/**
 * Run one poll tick. Extracted so a test can drive ticks deterministically
 * without the interval loop. Returns the held call it rendered, or null if it
 * skipped (latch busy, no awaiting hold outside render-failure cooldown, or it
 * lost a race to a resolve/expiry or another path between the read and here).
 *
 * The interleaving (candidate 1): claim the latch, erase the input line,
 * render the confirmation above it, drive it to a resolution, then restore the
 * prompt — in a `try`/`finally` so an IO throw can never leave the latch stuck
 * busy (which would silently kill proactive surfacing for the session).
 *
 * Whether to defer is delegated to `io.deferPoll()`. With the raw-mode editor
 * that is only while the completion menu is open — the editor
 * owns the buffer, so a half-typed line is lifted aside and restored, and a
 * mid-typing tick repaints through the editor rather than deferring. The plain
 * readline reader still defers while mid-typing, since it cannot lift a live
 * buffer (the constraint). Every tick also feeds the latest
 * status snapshot to `io.setStatus` so the editor's live status line stays fresh.
 */
export async function pollTick(
  deps: PollDeps,
  cooldown: Map<string, number> = new Map(),
): Promise<HeldCallRecord | null> {
  const { getStatus, renderHeld, io, latch } = deps;

  // A prompt is already open (reactive or a prior tick) — never draw over it.
  if (latch.busy) return null;

  const status = await getStatus();
  // Refresh the live status line every tick, so `~Nm left` and the session dot
  // stay current even while the user sits idle (no-op on the plain reader).
  io.setStatus(status);
  // The prompt drives one confirmation at a time: the oldest awaiting call
  // (`held[0]`), the next one to answer. Resolving it surfaces the next on a
  // later tick. A call whose render just failed is parked in cooldown — skip
  // past it to the next awaiting call rather than redrawing (and re-erasing
  // the input) every interval while the fault persists; a single broken
  // render must not hide the rest of the list.
  const held = status.held.find((h) => !cooldown.has(h.heldCallId));
  if (!held) return null;

  let acquired = false;
  let erased = false;
  try {
    // Claim before touching the terminal. A racing reactive turn or prior tick
    // that claimed between the read and here just makes this tick a no-op.
    if (!latch.tryAcquire(held.heldCallId)) return null;
    acquired = true;
    // Defer while the input surface says so (menu open / mid-typing) — the
    // editor restores its owned buffer afterward, so a half-typed line survives.
    if (io.deferPoll()) return null;
    io.eraseInputLine();
    erased = true;
    await renderHeld(held);
    return held;
  } catch (err) {
    // A render/resolve failure (not the transient status-read kind) — back this
    // hold off for a few ticks so it can't spin, then let it surface again.
    cooldown.set(held.heldCallId, RENDER_FAILURE_COOLDOWN_TICKS);
    throw err;
  } finally {
    // Restore the prompt only if we actually erased; always free the latch we
    // took, so a deferred tick doesn't leave it stuck busy.
    if (erased) io.restoreInputLine();
    if (acquired) latch.release(held.heldCallId); // clears on resolve completion
  }
}

/**
 * The idle poll loop. Ticks every `intervalMs` until `isActive()` is false.
 * Never rejects — a thrown tick routes to `onError` and the loop continues, so
 * a transient status-read failure does not tear the poll down. Render-failure
 * cooldowns age out one tick at a time.
 */
export async function startPoll(deps: PollDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const onError = deps.onError ?? defaultPollOnError;
  const cooldown = new Map<string, number>();

  while (deps.isActive()) {
    await sleep(intervalMs);
    if (!deps.isActive()) break;
    // Paused (REPL offline): no read, and — placement is load-bearing — no
    // cooldown aging either, so the offline stretch neither polls nor
    // silently expires a render-failure cooldown.
    if (deps.isPaused?.()) continue;
    // Age out render-failure cooldowns so a backed-off hold resurfaces.
    for (const [id, ticks] of cooldown) {
      if (ticks <= 1) cooldown.delete(id);
      else cooldown.set(id, ticks - 1);
    }
    try {
      await pollTick(deps, cooldown);
    } catch (err) {
      onError(err);
    }
  }
}
