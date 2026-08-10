// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The inline autocomplete menu renderer. Pure: it turns
 * a completion list + highlight index into ready-to-write terminal rows. No
 * alternate screen — the menu is drawn on the lines directly below the prompt,
 * and the raw-mode editor (`input/line-editor.ts`) owns the cursor choreography
 * that positions and erases it.
 *
 * Width safety reuses the forge-guard primitives (`displayWidth`, `sanitize`):
 * every row is sanitized and truncated so it occupies at most `width` display
 * columns and cannot soft-wrap into an extra physical row the editor's
 * row-count math didn't budget for. Menu rows carry only Habenula-authored
 * command names and Habenula-controlled service ids (the catalog), so they are
 * trusted chrome — but they are sanitized anyway, cheaply, so a future
 * untrusted source can't regress the guarantee.
 */

import { displayWidth, sanitize } from "../render/attribution";
import { tintKeyword, type ColorDepth, type ColorRole } from "../render/color";
import type { Completion } from "./completion";

/** The highlighted-row marker; a plain-ASCII arrow so its width is exactly 1 and never wide. */
const MARKER = "→ ";
/** The unhighlighted-row indent — same width as the marker, so items align. */
const INDENT = "  ";

/** Reverse-video SGR bracketing for the highlighted row when color is enabled. */
const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[0m";

export interface MenuStyle {
  /**
   * Emit the reverse-video SGR on the highlighted row. The editor passes
   * `depth !== "none"`, so a `NO_COLOR` / piped session still gets the `→`
   * marker (a text affordance, not a color) but no SGR bytes.
   */
  readonly color: boolean;
}

/** Truncate to at most `width` display columns, grapheme-safe, with a trailing ellipsis when cut. */
function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  for (const ch of text) {
    // Reserve one column for the ellipsis.
    if (displayWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * The most rows the menu ever draws. A longer list (e.g. the full `:connect`
 * catalog) scrolls within this window rather than emitting one row per item —
 * an unbounded menu on a short terminal scrolls the viewport, after which the
 * editor's absolute cursor-up counts land on the wrong line and corrupt the next
 * repaint. Bounding the row count keeps the geometry sound.
 */
export const MAX_MENU_ROWS = 8;

/**
 * The window of items shown for a list of length `n` with highlight `index`,
 * capped at `MAX_MENU_ROWS`. The window scrolls to keep the highlighted item
 * visible: centered when possible, clamped at either end. Returns the inclusive
 * start and the count.
 */
function menuWindow(n: number, index: number): { start: number; count: number } {
  const count = Math.min(n, MAX_MENU_ROWS);
  if (n <= count) return { start: 0, count };
  const start = Math.min(Math.max(0, index - Math.floor(count / 2)), n - count);
  return { start, count };
}

/**
 * Render the (windowed) menu as one row per visible item. The row at `index` is
 * prefixed with the `→` marker (and reverse-video when `style.color`); the rest
 * are indented to align. Each row is sanitized and truncated to `width` display
 * columns. A list longer than `MAX_MENU_ROWS` scrolls within the window, keeping
 * the highlight visible. Returns `[]` for an empty item list (nothing to draw).
 */
export function renderMenu(
  items: readonly Completion[],
  index: number,
  width: number,
  style: MenuStyle,
): string[] {
  const limit = Math.max(1, width);
  const { start, count } = menuWindow(items.length, index);
  const rows: string[] = [];
  for (let i = start; i < start + count; i++) {
    const highlighted = i === index;
    const marker = highlighted ? MARKER : INDENT;
    const row = truncateToWidth(`${marker}${sanitize(items[i]!.value)}`, limit);
    rows.push(highlighted && style.color ? `${REVERSE_ON}${row}${REVERSE_OFF}` : row);
  }
  return rows;
}

/**
 * How many physical rows the menu occupies — one per visible item, capped at
 * `MAX_MENU_ROWS`. Matches `renderMenu`'s output length exactly, so the editor's
 * repaint geometry and this budget never disagree.
 */
export function menuHeight(items: readonly Completion[]): number {
  return Math.min(items.length, MAX_MENU_ROWS);
}

/**
 * One selectable confirmation choice (arrow-key nav). `label` is the
 * Habenula-authored, numbered line (`"1. Deny — …"`);
 * `role` is its outcome color (deny coral / grant deep seafoam / tell-more brand text); `token`
 * is what the editor submits when this row is chosen (`"1".."4"`), so the
 * existing `parseChoice` maps it with no new vocabulary. Habenula-authored, so
 * trusted chrome — sanitized anyway (cheap) to keep the guarantee if a future
 * source is untrusted.
 */
export interface SelectionChoice {
  readonly label: string;
  readonly role: ColorRole;
  readonly token: string;
  /**
   * The outcome word within `label` to tint by `role` — `"Allow"`, `"Deny"`,
   * `"Tell me more"`. Only this span is colored; the number and
   * granularity text stay plain. Its first occurrence in `label` is tinted.
   */
  readonly keyword: string;
}

/**
 * Render the confirmation choices as one row per choice, the row at `index`
 * prefixed with the `→` marker so the highlight is clear at every color depth.
 * Only each choice's outcome word is tinted by its role — the marker
 * gives the position affordance, the keyword hue the outcome affordance, and the
 * number + text carry the meaning, so a `NO_COLOR` / `depth:"none"` session still
 * scans by the `→` marker and the number. `tintKeyword` handles the highlighted
 * row's reverse-video: because the keyword's color resets with `\x1b[0m` (which
 * also clears reverse), it re-opens reverse after the keyword so the whole row
 * stays highlighted, not just its head. Color is applied AFTER `truncateToWidth`
 * — that helper is not ANSI-aware and would miscount escape bytes.
 */
export function renderSelection(
  choices: readonly SelectionChoice[],
  index: number,
  width: number,
  depth: ColorDepth,
): string[] {
  const limit = Math.max(1, width);
  return choices.map((choice, i) => {
    const highlighted = i === index;
    const marker = highlighted ? MARKER : INDENT;
    const row = truncateToWidth(`${marker}${sanitize(choice.label)}`, limit);
    return tintKeyword(row, choice.keyword, choice.role, depth, {
      reverse: highlighted && depth !== "none",
    });
  });
}
