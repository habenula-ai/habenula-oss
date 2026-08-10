// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A hand-rolled round-trip spinner. No `ora` dependency.
 * Labels are process-descriptive, never personifying (`working…`,
 * `resolving…` — never "thinking…").
 *
 * Guarantees the tests pin:
 *  - show-after-delay: a round-trip that resolves before `showAfterMs` never
 *    draws a frame, so a fast call does not flash;
 *  - teardown always wins: the spinner is cleared in `finally`, before any
 *    result or error line is written, and the interval is always cleared — a
 *    thrown round-trip leaves no live timer and no residual frame;
 *  - TTY-only: with no TTY, `fn` runs with zero writes.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerDeps {
  /** Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** Defaults to `process.stdout`. */
  stream?: { write(s: string): void; columns?: number };
  /** Delay before the first frame is drawn. */
  showAfterMs?: number;
  /** Frame cadence. */
  intervalMs?: number;
}

/**
 * Run `fn` while showing a spinner. Returns `fn`'s result (or re-throws its
 * error) — the spinner is torn down either way before control returns, so the
 * caller's next write lands on a clean line.
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
  deps: SpinnerDeps = {},
): Promise<T> {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return fn();

  const stream = deps.stream ?? process.stdout;
  const showAfterMs = deps.showAfterMs ?? 120;
  const intervalMs = deps.intervalMs ?? 90;

  let frame = 0;
  let shown = false;
  let cleared = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const draw = (): void => {
    stream.write(`\r${FRAMES[frame % FRAMES.length]} ${label}`);
    frame += 1;
  };

  const start = (): void => {
    shown = true;
    draw();
    interval = setInterval(draw, intervalMs);
  };

  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    clearTimeout(showTimer);
    if (interval !== undefined) clearInterval(interval);
    if (shown) {
      // Overwrite the frame line with blanks, then return to column 0, so the
      // next write starts clean. Width is the label + a small frame margin.
      const width = (label.length + 2) + 1;
      stream.write(`\r${" ".repeat(width)}\r`);
    }
  };

  const showTimer = setTimeout(start, showAfterMs);

  try {
    return await fn();
  } finally {
    clear();
  }
}
