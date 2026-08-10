// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The live status line: a single glanceable row —
 * `● live · ~Nm left · <services>` — drawn by the raw-mode editor on the row
 * directly above the prompt. Pure: it turns a session snapshot + the connected
 * services into one ready-to-write, width-bounded, colored string. The editor
 * owns *where* it goes and *when* it repaints; this owns *what it says*.
 *
 * Session and time-remaining come from the `GET /api/status` snapshot the poll
 * already fetches (so `~Nm left` stays live as the 90-minute clock ticks and as
 * activity resets it); the service list comes from the editor's completion
 * cache. The whole line renders in the muted role — it is ambient chrome, not a
 * call to action — and the `●`/`○` glyph, not color, carries the live/idle
 * state so it reads under `NO_COLOR`.
 */

import type { ActiveSessionView } from "../api-client";
import { sessionTimes } from "../commands/repl-meta";
import { colorize, type ColorDepth } from "./color";
import { displayWidth, sanitize } from "./attribution";

/**
 * Truncate to at most `width` display columns with a trailing ellipsis when cut.
 * Iterates by code point (so surrogate pairs stay intact); ZWJ/combining
 * sequences may still split — acceptable for the status line's ASCII-ish content.
 * Tracks a running width so it stays O(n) rather than re-measuring each step.
 */
function clampToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width - 1) break; // reserve one column for the ellipsis
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export interface StatusLineInput {
  /** The active session (from `GET /api/status`), or null when none / unverified. */
  session: ActiveSessionView | null;
  /** Connected service names (from the editor's completion cache). */
  connected: readonly string[];
  /** Current instant, injected so the time-remaining is testable. */
  now: Date;
  depth: ColorDepth;
  /** Terminal width; the line is truncated to fit so it never soft-wraps into a second row. */
  width: number;
}

/**
 * Format the status line. A filled `●` marks an active session, hollow `○` when
 * there is none; `~Nm left` is omitted when the session carries no expiry
 * (the defensive `expiry: null` edge). The service segment lists connected
 * names, or `no services connected` when none. The assembled plain text is
 * sanitized and truncated to `width`, then colored muted as one unit.
 */
export function formatStatusLine(opts: StatusLineInput): string {
  const parts: string[] = [];
  if (opts.session) {
    parts.push("live");
    const times = sessionTimes(opts.session, opts.now);
    if (times) parts.push(`~${times.left} left`);
  } else {
    parts.push("no active session");
  }
  parts.push(
    opts.connected.length > 0 ? opts.connected.join(", ") : "no services connected",
  );
  const glyph = opts.session ? "●" : "○";
  const plain = clampToWidth(sanitize(`${glyph} ${parts.join(" · ")}`), Math.max(1, opts.width));
  return colorize(plain, "muted", opts.depth);
}
