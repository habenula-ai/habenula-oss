// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The HABENULA boot banner. A hand-rolled
 * block wordmark in the seafoam brand accent with a rule beneath it, replacing the
 * plain boot line. TTY-gated and suppressible (env flag or first-run-only), and
 * width-capped: below the banner's width it degrades to a one-line wordmark
 * rather than wrapping into garbage.
 *
 * The wordmark is assembled from a fixed 6-column-per-letter glyph map so every
 * row is the same width by construction — no hand-aligned ASCII to drift.
 */

import { colorize, type ColorDepth } from "./color";

/** Each letter is exactly 6 columns × 5 rows of block glyphs. */
const GLYPHS: Record<string, readonly [string, string, string, string, string]> = {
  H: ["██  ██", "██  ██", "██████", "██  ██", "██  ██"],
  A: [" ████ ", "██  ██", "██████", "██  ██", "██  ██"],
  B: ["█████ ", "██  ██", "█████ ", "██  ██", "█████ "],
  E: ["██████", "██    ", "█████ ", "██    ", "██████"],
  N: ["██  ██", "███ ██", "██████", "██ ███", "██  ██"],
  U: ["██  ██", "██  ██", "██  ██", "██  ██", "██████"],
  L: ["██    ", "██    ", "██    ", "██    ", "██████"],
};

const WORD = "HABENULA";

// Guard: every letter of WORD must have a glyph, or the map below throws an opaque
// "cannot read row of undefined". Fail loudly at module load with a clear message
// instead (the `GLYPHS[ch]!` non-null assert relies on this holding).
for (const ch of WORD) {
  if (!(ch in GLYPHS)) throw new Error(`banner: no glyph defined for '${ch}' in WORD`);
}

/** The five block-glyph rows, letters joined by a single space column. */
const BANNER_LINES: string[] = [0, 1, 2, 3, 4].map((row) =>
  WORD.split("")
    .map((ch) => GLYPHS[ch]![row])
    .join(" "),
);

/** The banner's intrinsic display width (all rows equal by construction). */
const BANNER_WIDTH = Math.max(...BANNER_LINES.map((l) => l.length));

/** A seafoam rule drawn to the banner's own width (never the terminal's, so it can't soft-wrap). */
const BANNER_RULE = "─".repeat(BANNER_WIDTH);

/** Set to suppress the banner regardless of TTY (honored by `shouldShowBanner`). */
const SUPPRESS_ENV = "HABENULA_NO_BANNER";

/**
 * Whether to draw the full banner. Off when not a TTY, when `HABENULA_NO_BANNER`
 * is set, or when the terminal is narrower than the banner (the one-line
 * wordmark is used instead — see `renderBanner`). Injectable for tests.
 */
export function shouldShowBanner(env: { [k: string]: string | undefined }, isTTY: boolean): boolean {
  return isTTY && env[SUPPRESS_ENV] === undefined;
}

/**
 * The banner as ready-to-print lines for a given width and color depth. Returns
 * the full block wordmark followed by a rule when it fits, else a single
 * wordmark line. Always colored in the seafoam brand accent, which nothing else
 * wears — a granted outcome takes the accent's deeper half; all other Habenula
 * output takes the brand text color.
 */
export function renderBanner(depth: ColorDepth, width: number): string[] {
  if (width < BANNER_WIDTH) {
    return [colorize("HABENULA", "banner", depth)];
  }
  return [...BANNER_LINES, BANNER_RULE].map((line) => colorize(line, "banner", depth));
}
