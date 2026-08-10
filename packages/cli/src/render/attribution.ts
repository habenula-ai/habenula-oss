// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Speaker attribution and the forge guard. This is the security-load-bearing
 * render module: it ensures no
 * agent-authored bytes can produce a visual row that reads as engine-attributed
 * (a forged `Habenula ›` line).
 *
 * The governing invariant: an unlabeled visual row of CLI output reads as a
 * Habenula continuation, so every row carrying non-Habenula (agent/human) or
 * agent-influenced bytes must be re-prefixed with its true speaker label — on
 * every visual row, including width-wrapped continuations. The guard is three
 * steps applied in order: strip → width-correct wrap → re-attribute.
 *
 * Exports pure functions (no terminal spawned) so the injection test can
 * capture the exact rendered rows.
 */

import type { ToolCallOutcome } from "../api-client";
import { colorize, type ColorDepth, type ColorRole } from "./color";

export type Speaker = "you" | "agent" | "habenula";

/** The visible label prefixing each speaker's rows. */
export const SPEAKER_LABEL: Record<Speaker, string> = {
  you: "you ›",
  agent: "agent ›",
  habenula: "Habenula ›",
};

const SPEAKER_ROLE: Record<Speaker, ColorRole> = {
  you: "human",
  agent: "agent",
  habenula: "habenula",
};

// A compact ANSI/CSI/OSC escape-sequence matcher (the well-known ansi-regex
// shape, inlined — no dependency). Stripped first, before the bare
// control-byte pass, so a `\x1b[31m` is removed whole rather than leaving a
// visible `[31m` once its ESC (U+001B) is gone. U+009B is the C1 CSI form.
// The OSC body can be terminated by BEL () OR String Terminator (ESC \
// or the C1 form ) — both are matched so an OSC-ST sequence's body does
// not leak as visible text once the bare-control pass removes its ESC bytes.
const ANSI_ESCAPE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\\\|\\u009C))|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

// C0 controls + DEL + C1 controls. Includes TAB, CR, and any leftover ESC.
const CONTROL_BYTES = /[\u0000-\u001F\u007F-\u009F]/g;

// Unicode format/bidi characters: ALM (U+061C), the zero-width space / non-joiner
// (U+200B/200C), LRM/RLM (U+200E/200F), the embedding and override set
// (U+202A-202E), the invisible-operator / word-joiner set (U+2060-2064), the
// isolate set (U+2066-2069), and the BOM/ZWNBSP (U+FEFF). A bidi override can
// visually reorder a param to read like engine chrome, and the zero-width space /
// non-joiner enable invisible word-splitting / homoglyph confusion in a rendered
// value; these are all category Cf, which a C0-only strip (as `sanitizeNoun` on
// the engine does) misses. ZWJ (U+200D) is deliberately NOT stripped \u2014 it is
// load-bearing inside emoji sequences, and a JSON-quoted value already bounds it
// so it cannot forge a line; width accounting (`isZeroWidth`) still neutralizes it.
const FORMAT_BIDI =
  /[\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Unicode line/paragraph separators (LS U+2028, PS U+2029). Category Zl/Zp, so
// they are neither C0/C1 controls nor format/bidi \u2014 but a terminal that honors
// them breaks the line, and `attribute` only splits logical rows on `\r?\n`. An
// unstripped LS/PS in agent text therefore forges a physical row with no speaker
// label (the forged `Habenula \u203A` the guard exists to stop). Stripped, not
// converted to a break: the guard's rule is to remove anything that could forge
// a line, and a real break would need its own re-attribution anyway.
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Strip everything that could forge a line or reorder its glyphs: ANSI/CSI/OSC
 * escape sequences, C0/C1 controls + DEL (CR included), Unicode format/bidi
 * characters, and Unicode line/paragraph separators. Newlines are handled a
 * level up (they split logical rows before this runs), so a raw `\r`/`\n`
 * reaching here is stripped as a control byte.
 */
export function sanitize(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_BYTES, "")
    .replace(FORMAT_BIDI, "")
    .replace(LINE_SEPARATORS, "");
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Iterate grapheme clusters (ZWJ emoji stay one unit), with a code-point fallback. */
function graphemes(text: string): string[] {
  if (segmenter) return [...segmenter.segment(text)].map((s) => s.segment);
  return [...text];
}

// Combining marks and variation selectors add zero display columns.
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200d) || // ZW space / ZWNJ / ZWJ
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
  );
}

// East-Asian Wide / Fullwidth and emoji occupy two columns. The BMP emoji
// symbol/dingbat ranges (U+2600-27BF, U+2B00-2BFF, and scattered singletons)
// are included because most terminals render them double-width — omitting them
// under-counts and lets a run soft-wrap into a forged flush-left row.
// Over-counting a rare width-1 symbol only wraps one column early (safe);
// under-counting is the vector, so this errs wide.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23fa) ||
    cp === 0x24c2 ||
    (cp >= 0x25aa && cp <= 0x25fe) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2900 && cp <= 0x297f) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) || // Presentation Forms For Vertical (EAW=W)
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Display width of one grapheme cluster: 0 (zero-width base), 2 (wide), or 1.
 * A cluster carrying VS16 (U+FE0F) is emoji-presentation and renders as 2
 * columns even when its base is a normally-width-1 symbol (`❤️`, `⚠️`), so a
 * VS16 anywhere in the cluster forces width 2. Otherwise the first non-zero-width
 * code point decides.
 */
function graphemeWidth(g: string): number {
  let base = -1;
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0xfe0f) return 2;
    if (isZeroWidth(cp)) continue;
    if (base === -1) base = cp;
  }
  if (base === -1) return 0;
  return isWide(base) ? 2 : 1;
}

/**
 * Display width of a string, grapheme-segmented with East-Asian-width
 * accounting. This is what wrapping must measure — `String.length` under-counts
 * double-width glyphs, the terminal soft-wraps them, and a flush-left
 * continuation row appears: the exact forged `Habenula ›` the guard prevents.
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(text)) w += graphemeWidth(g);
  return w;
}

/**
 * Grapheme hard-wrap into rows no wider than `width` display columns (a wide
 * glyph is never split across the boundary). Returns at least one row. Used for
 * a single token that is itself wider than the line — where there is no word
 * boundary to break on, correctness (no row exceeds the width, so nothing
 * soft-wraps into a forged flush-left continuation) beats keeping the token whole.
 */
function hardWrap(text: string, limit: number): string[] {
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (currentWidth + w > limit && current !== "") {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += g;
    currentWidth += w;
  }
  if (current !== "" || rows.length === 0) rows.push(current);
  return rows;
}

/**
 * Word-aware wrap into rows no wider than `width` display columns. Breaks on
 * spaces so words are never split mid-token; a token that alone exceeds the
 * width is hard-broken by `hardWrap` (so a pasted URL still wraps rather than
 * overflowing — the forge-guard width bound is never relaxed). Whitespace runs
 * collapse to a single space and the break-point space is consumed by the line
 * break, so `rows.join(" ")` reproduces the words (not the original spacing).
 * Returns at least one row (`[""]` for empty input). Used by `attribute` for the
 * prose voices; `layoutField` keeps a faithful char-wrap for untrusted DATA
 * values, which must render exactly as received on the consent surface.
 *
 * Because it collapses whitespace runs and strips leading/trailing spaces, this
 * is intentionally lossy for alignment: an agent (LLM) response with a hand-laid
 * table or indented list reflows into running prose. That is an accepted trade
 * for the chat voice — security is unaffected (the forge guard holds regardless
 * of where rows break). Splitting on the ASCII space only is sufficient because
 * `sanitize` (run by `attribute` before this) already strips tabs and every
 * other C0 control, so no tab break-points reach here.
 */
export function wrapToWidth(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const token of text.split(" ")) {
    if (token === "") continue; // collapse space runs
    const tokW = displayWidth(token);
    if (tokW > limit) {
      // Token wider than the whole line: flush the current row, hard-break it,
      // and carry the final piece as the new row start.
      if (cur !== "") {
        rows.push(cur);
        cur = "";
        curW = 0;
      }
      const pieces = hardWrap(token, limit);
      for (let i = 0; i < pieces.length - 1; i++) rows.push(pieces[i]!);
      cur = pieces[pieces.length - 1]!;
      curW = displayWidth(cur);
      continue;
    }
    const sep = cur === "" ? 0 : 1;
    if (cur !== "" && curW + sep + tokW > limit) {
      rows.push(cur);
      cur = "";
      curW = 0;
    }
    if (cur === "") {
      cur = token;
      curW = tokW;
    } else {
      cur += ` ${token}`;
      curW += 1 + tokW;
    }
  }
  if (cur !== "" || rows.length === 0) rows.push(cur);
  return rows;
}

/**
 * Sanitize and truncate an agent-influenced value (a noun, a param) for display
 * in a labeled-data region. Returns `altered` (sanitization stripped dangerous
 * bytes) separately from `truncated` (display length cap only), so a caller can
 * flag `⚠` on tampering while treating a pure length cap as benign, or on both
 * where a shortened value implies a narrower grant than the raw grant-key.
 * Shared by the prompt renderer and the status grant list — one guard.
 */
export function clampSanitized(
  raw: string,
  max: number,
): { text: string; altered: boolean; truncated: boolean } {
  const clean = sanitize(raw);
  const clamped = clean.length > max ? `${clean.slice(0, max)}…` : clean;
  return { text: clamped, altered: clean !== raw, truncated: clamped !== clean };
}

/** The chrome separator (`service · verb · noun`), the byte an untrusted value must never impersonate. */
const CHROME_SEPARATOR = "·"; // MIDDLE DOT, U+00B7

/**
 * Render an **untrusted (agent-influenced)** value — a noun or a tool-call
 * parameter — as a self-delimited data token that can never be mistaken for
 * trusted governance chrome. Use this for values in the `service · verb · <here>`
 * action position and for confirmation-prompt params; use `clampSanitized` for
 * trusted/registry- or human-authored surfaces (the connected-service name, the
 * "Tell me more" description).
 *
 * Two defects this closes:
 *
 * 1. **Chrome forgery via the separator.** `sanitize` strips forge
 *    bytes but NOT `·` (U+00B7) — it is legitimate chrome. So an untrusted noun
 *    `"all · calendar · read"` rendered bare reads as extra granted scopes, and
 *    at `NO_COLOR`/`depth=none` (where `colorize` is a pass-through) the trusted
 *    brand-text chrome and the default-fg noun are byte-identical plain text — colour,
 *    the only disambiguator, is gone. The guarantee here must therefore be
 *    **structural, not colour-dependent**: the value is wrapped with
 *    `JSON.stringify`, which delimits it in double quotes AND escapes any embedded
 *    `"` / `\`, so a contained `·` (or a quote) is visibly bounded inside the
 *    quotes and can never close the delimiter or read as a separator — at ANY
 *    depth. A value carrying the chrome separator additionally trips `altered`, so
 *    the `⚠ unusual value` flag fires even though `·` survives sanitize unchanged.
 *
 * 2. **Structure hidden on the consent surface.** `String(value)`
 *    renders `{email:'x'}` as `[object Object]`, `['a','b']` as `a,b`, hiding the
 *    real destination the user is approving. Non-string values are `JSON.stringify`d
 *    so their structure is shown; they are already self-delimited by `{}`/`[]`/a
 *    bare literal, so they are not re-quoted.
 *
 * **Interim defense, by design.** The noun is untrusted-at-render only because
 * `nounExtractor` does not validate it on the read path. When the noun is
 * typed at the dispatch boundary, the noun
 * becomes a typed scope — trusted chrome — and this quoting is dropped for it.
 * Genuinely free-form params stay untrusted and keep this treatment.
 */
export function renderUntrusted(
  value: unknown,
  max: number,
): { text: string; altered: boolean; truncated: boolean } {
  const isString = typeof value === "string";
  // Non-strings: reveal structure (F1). `JSON.stringify` returns undefined for
  // undefined/function/symbol — fall back to `String` so nothing renders blank.
  const raw = isString ? value : (JSON.stringify(value) ?? String(value));
  const clean = sanitize(raw);
  const clamped = clean.length > max ? `${clean.slice(0, max)}…` : clean;
  const carriesChrome = clamped.includes(CHROME_SEPARATOR);
  // Strings get JSON quotes+escaping (the F2 structural boundary); structured
  // values are already delimited by their JSON shape and are not re-wrapped.
  const text = isString ? JSON.stringify(clamped) : clamped;
  return {
    // `altered` = dangerous/tampered bytes (sanitization stripped something, or
    // a chrome separator survived unstripped). `truncated` = display length cap
    // only. Split so a caller flags `⚠` on tampering and, where a shortened
    // value would imply a narrower grant (a noun), on truncation too; a
    // legitimately long goal flags on tampering alone.
    text,
    altered: clean !== raw || carriesChrome,
    truncated: clamped !== clean,
  };
}

/**
 * Clamp bound for a rendered tool-call name, shared by three render sites so
 * they cannot drift: the resumed turn (`prompt.ts`), the normal chat turn
 * (`chat.ts`), and the audit render (`audit.ts`, the `tool_name` column).
 *
 * Trust differs by path, so all three route the value through
 * `renderUntrusted`. On the audit path the name IS the model's raw `tool_use`
 * name — the log is the forensic record and keeps what was asked for. On the two
 * turn paths the engine has resolved it against the registry, and the quoting is
 * kept for an older engine that has not (see `toolCallLine`).
 */
export const MAX_TOOL = 64;

/**
 * Clamp bound for a rendered tool error message. Shared by the audit render
 * (`audit.ts`, the `error_message` column) and the tool-call line
 * (`toolCallLine`), which surface the same tool-authored string on two paths.
 */
export const MAX_ERROR = 256;

/**
 * The `[tool: …]` marker for one tool call, used by BOTH turn renderers — the
 * normal turn (`chat.ts`) and the resumed turn (`prompt.ts`). One function so
 * the two cannot drift (the same reason `MAX_TOOL` lives here).
 *
 * Trust layout, left to right:
 *  - `[tool: ` and the ` — failed` suffix are engine chrome. `outcome` is typed
 *    as the wire enum, never a free string, so the suffix is safe to write
 *    plainly — the type is what makes that claim hold, so keep it. (It is only
 *    ever compared here, never printed, so no `outcome` value reaches output.)
 *  - `name` is engine-validated against the tool registry, so it is a registry
 *    id or the engine's own `<unrecognized>` token. It is still quoted and
 *    bounded, deliberately: this CLI can be pointed at an older engine that
 *    sends the model's raw `tool_use` name, and quoting is what stops a crafted
 *    name from closing the `]` and reading as prose. The cost of keeping it is
 *    one pair of quotes on a closed-set value.
 *  - `error` is the tool's own text, the least trusted token on the
 *    line. It is quoted and bounded the same way, and it sits LAST so it has no
 *    chrome after it to forge.
 */
export function toolCallLine(call: {
  name: string;
  outcome: ToolCallOutcome;
  error?: string;
}): string {
  const name = renderUntrusted(call.name, MAX_TOOL);
  if (call.outcome !== "error") return `[tool: ${name.text}]`;
  // An `error` outcome with no text is possible on an older engine, which sent
  // no `error` field at all. Fall back to the bare marker rather than render an
  // empty pair of quotes.
  if (call.error === undefined || call.error === "") {
    return `[tool: ${name.text}] — failed`;
  }
  const reason = renderUntrusted(call.error, MAX_ERROR);
  return `[tool: ${name.text}] — failed: ${reason.text}`;
}

/** The terminal width per render, with an 80-column fallback (SIGWINCH residual). */
export function terminalWidth(): number {
  const cols = process.stdout.columns;
  return cols && cols > 0 ? cols : 80;
}

/**
 * Lay out a chrome-prefixed data line so NO emitted visual row exceeds `width`
 * display columns — the terminal never soft-wraps it, so an untrusted value can
 * never spill into a flush-left continuation row reading as engine chrome.
 * This is the forge guard's width-correct-wrap step applied
 * to the value-bearing rows (the prompt action/param lines and the status grant/
 * held rows), which `attribute()` does not cover because they carry trusted
 * chrome + untrusted data on one line rather than a single speaker's text.
 *
 * The trusted, already-colored `prefix` sits on row 0; the already-sanitized
 * `value` hard-wraps by display width; continuation rows are indented so they are
 * never flush-left. An optional trailing `suffix` (colored — e.g. a "⚠ unusual
 * value" flag or a grant lifetime) lands on the last row, or its own indented row
 * if it would overflow. Widths are passed as the PLAIN display widths (SGR adds
 * zero columns), so this never strips color to measure.
 *
 * When the whole line fits (the common case), the result is a single row
 * identical to the naive `prefix + value + suffix` concatenation — so short
 * values render exactly as before.
 *
 * Degenerate narrow terminal: when the prefix alone is as wide as the
 * terminal, there is no room for even one value grapheme on row 0 without the row
 * soft-wrapping — and that wrapped grapheme (untrusted) would land flush-left, the
 * forge this guard prevents. So row 0 is then given to the prefix alone (its own
 * soft-wrap is trusted chrome, not a forged line) and the ENTIRE value moves to
 * indented continuation rows. No emitted row places an untrusted grapheme
 * flush-left, at any terminal width.
 */
export function layoutField(opts: {
  prefixColored: string;
  prefixWidth: number;
  value: string;
  width: number;
  continuationIndent: number;
  suffixColored?: string;
  suffixWidth?: number;
}): string[] {
  const width = Math.max(1, opts.width);
  // At least 1: a continuation row must never be flush-left, or an untrusted
  // value could forge an engine-attributed line. The flush-left
  // guarantee is intrinsic here, not dependent on caller discipline.
  const contPad = " ".repeat(Math.max(1, opts.continuationIndent));
  const hasSuffix = opts.suffixColored !== undefined && opts.suffixColored !== "";
  const suffixWidth = hasSuffix ? (opts.suffixWidth ?? 0) : 0;

  // No room for even one value grapheme beside the prefix → prefix owns row 0
  // alone and the value goes entirely onto indented continuation rows (see the
  // degenerate-narrow-terminal note above).
  const roomOnFirst = width - opts.prefixWidth;
  const prefixOwnsRow0 = roomOnFirst < 1;
  const budget0 = Math.max(1, roomOnFirst);
  const budgetN = Math.max(1, width - contPad.length);
  const pieces: { text: string; width: number }[] = [];
  let cur = "";
  let curW = 0;
  let onFirst = !prefixOwnsRow0;
  for (const g of graphemes(opts.value)) {
    const w = graphemeWidth(g);
    const limit = onFirst ? budget0 : budgetN;
    if (curW + w > limit && cur !== "") {
      pieces.push({ text: cur, width: curW });
      cur = "";
      curW = 0;
      onFirst = false;
    }
    cur += g;
    curW += w;
  }
  pieces.push({ text: cur, width: curW });

  const rows: string[] = [];
  if (prefixOwnsRow0) {
    rows.push(opts.prefixColored);
    for (const p of pieces) if (p.text !== "") rows.push(contPad + p.text);
  } else {
    for (const [i, p] of pieces.entries()) {
      rows.push(i === 0 ? opts.prefixColored + p.text : contPad + p.text);
    }
  }

  const lastPiece = pieces[pieces.length - 1]!;
  const lastRowWidth = prefixOwnsRow0
    ? rows.length === 1
      ? opts.prefixWidth // prefix-only row (empty value)
      : contPad.length + lastPiece.width
    : (pieces.length === 1 ? opts.prefixWidth : contPad.length) + lastPiece.width;

  if (hasSuffix) {
    if (lastRowWidth + 1 + suffixWidth <= width) {
      rows[rows.length - 1] = `${rows[rows.length - 1]} ${opts.suffixColored}`;
    } else {
      rows.push(`${contPad}${opts.suffixColored}`);
    }
  }
  return rows;
}

/**
 * Attribute `text` to a speaker: split into logical rows, sanitize each,
 * width-wrap so no row soft-wraps, and prefix EVERY resulting visual row with
 * the (colored) speaker label. The result is an array of ready-to-print rows,
 * none of which can read as a Habenula continuation unless the speaker truly is
 * Habenula. The whole row is colored in the speaker's role (agent = vermilion
 * voice; human = default fg; Habenula = brand-text chrome).
 */
export function attribute(
  speaker: Speaker,
  text: string,
  opts: { depth: ColorDepth; width?: number },
): string[] {
  const label = SPEAKER_LABEL[speaker];
  const role = SPEAKER_ROLE[speaker];
  const width = opts.width ?? terminalWidth();
  // Reserve the label + one space so label+content never exceeds the terminal.
  const available = Math.max(1, width - displayWidth(label) - 1);
  const rows: string[] = [];
  for (const logical of text.split(/\r?\n/)) {
    const clean = sanitize(logical);
    for (const piece of wrapToWidth(clean, available)) {
      rows.push(colorize(`${label} ${piece}`, role, opts.depth));
    }
  }
  return rows;
}
