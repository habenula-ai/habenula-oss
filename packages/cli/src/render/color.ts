// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hand-rolled terminal color. No
 * `chalk`/`kleur` dependency — the own-module path is the deliberate
 * one. Color reports governance *state* (a grant/hold/deny outcome that
 * already exists) and *speaker* role. The confirmation choices are additionally
 * tinted by outcome (Deny coral, the two grants deep seafoam, Tell-more brand text) as a
 * scanning affordance — but the choice number and text carry the meaning, so
 * that color is strictly additive and the choices stay legible under `NO_COLOR`.
 *
 * Depth is picked once from the environment. The palette stores each role's
 * primary as an RGB triple and a 16-color fallback code; the truecolor and
 * 256-color SGR sequences are derived from the triple, so there is one source
 * of truth per color and the three depths can never drift.
 */

export type ColorDepth = "truecolor" | "256" | "16" | "none";

/**
 * Role/state → color. `human` is intentionally absent from the palette: the
 * human voice renders in the terminal's default foreground (no SGR), so
 * `colorize` treats it as a pass-through.
 */
export type ColorRole =
  | "habenula"
  | "banner"
  | "agent"
  | "human"
  | "granted"
  | "pending"
  | "denied"
  | "incoming"
  | "muted";

interface PaletteEntry {
  /** 24-bit primary, also the source for the 256-color approximation. */
  rgb: [number, number, number];
  /** 16-color fallback SGR foreground code. */
  sixteen: string;
}

/**
 * The realized palette, standardized on the Habenula brand palette so the CLI
 * and habenula.ai read as one product. Every role but one takes a named brand
 * token, at the brand's dark-surface values — a terminal is a dark surface, and
 * the site styles its own terminal blocks from these same tokens: brand text for
 * a typed command, and the seafoam accent for a prompt and for success. Where the
 * CLI departs from that, it is because a terminal needs hues the site never has to
 * tell apart side by side — `muted` is one: the site spends mauve-gray on its
 * terminal body text and keeps a darker token for dim detail, while the CLI's
 * ordinary text is the terminal's own foreground, so mauve-gray is free to be the
 * recessive one.
 *
 * | role     | brand token | value     |
 * |----------|-------------|-----------|
 * | habenula | text        | `#FBF7F2` |
 * | banner   | accent      | `#4EBB9D` |
 * | agent    | accent-red  | `#E75420` |
 * | granted  | accent-dim  | `#2E9B7F` |
 * | pending  | danger-text | `#EF9376` |
 * | denied   | primary     | `#F46A80` |
 * | incoming | off-palette | `#AF87FF` |
 * | muted    | text-muted  | `#A89AA1` |
 *
 * The two greens are the two halves of the accent: the banner takes the accent
 * itself, and a granted outcome takes the deeper `accent-dim`, which despite its
 * name is the richer of the pair — more saturated and lower in luminance. That
 * separation is what lets an affirmative read as its own color rather than as the
 * boot screen's, and it satisfies the standing constraint that a granted marker
 * stay luminance-separated from whatever it sits on.
 *
 * Two roles inherit a token against the semantics the site gives it, and this is
 * a decision rather than a transposition. The stylesheet reserves `accent-red` for
 * stop — Deny has to mean stop — and keeps `primary` off decision controls, yet
 * here the agent voice takes `accent-red` and a denial takes `primary`. The CLI's
 * agent voice has been a warm orange since its first release, and reading as itself
 * to anyone who has used it won out; the decision set stays unambiguous because the
 * choice number and the outcome word carry it, exactly as they must under
 * `NO_COLOR`. A reader cross-checking the two palettes will find this pair
 * inverted, and should leave it inverted absent a fresh decision.
 *
 * `incoming` is the one hue with no brand token. The brand's chromatic range is
 * the two greens plus a warm family — vermilion, coral, peach — and every member
 * of it is already spoken for by a voice or a state. So the external-agent
 * provenance badge keeps its purple as a deliberate exception, rather than
 * colliding with a hue that already means something.
 *
 * All eight roles hold a distinct 16-color code. Seafoam approximates to cyan
 * (`36`) — nearer `#4EBB9D` than xterm's green is — which leaves green free for
 * the affirmative, the conventional reading at the floor. (The palette this
 * replaced collapsed the agent voice and the pending state both onto yellow.)
 *
 * Hues assume a dark terminal, as the brand's dark surface does. Where the
 * background is light or a hue washes out, the state word and glyph carry the
 * meaning — the same guarantee that holds under `NO_COLOR`.
 */
const PALETTE: Record<Exclude<ColorRole, "human">, PaletteEntry> = {
  // Habenula's own voice/chrome takes the brand text color — the same value
  // typed input renders in (`inputSgr`). The two are told apart structurally, by
  // the `Habenula ›` label, never by hue.
  habenula: { rgb: [251, 247, 242], sixteen: "97" }, //  text #FBF7F2 → bright white
  // Seafoam, the brand accent — the boot wordmark alone.
  banner: { rgb: [78, 187, 157], sixteen: "36" }, //     accent #4EBB9D → cyan
  agent: { rgb: [231, 84, 32], sixteen: "31" }, //       vermilion #E75420 → red
  // The deeper, richer half of the accent, and the affirmative: more saturated
  // than the banner's seafoam and darker, so the two never read as one color.
  granted: { rgb: [46, 155, 127], sixteen: "32" }, //    accent-dim #2E9B7F → green
  pending: { rgb: [239, 147, 118], sixteen: "33" }, //   peach #EF9376 → yellow
  denied: { rgb: [244, 106, 128], sixteen: "91" }, //    coral #F46A80 → bright red
  incoming: { rgb: [175, 135, 255], sixteen: "35" }, //  purple (off-palette) → magenta
  muted: { rgb: [168, 154, 161], sixteen: "90" }, //     text-muted #A89AA1 → bright black
};

/**
 * Pick the color depth once. A non-TTY forces `none`; so does `NO_COLOR` when it
 * is present *and not the empty string* (no-color.org: an empty value does not
 * suppress color, so a parent neutralizing the var with `NO_COLOR=""` keeps
 * color on). Otherwise 24-bit when `COLORTERM` advertises it, 256 when `TERM`
 * carries `256color`, else the 16-color floor.
 *
 * `env` is injected (not read from `process.env` directly) so the depth logic
 * is a pure function the verification test drives across all four depths.
 */
export function pickColorDepth(
  env: { COLORTERM?: string; TERM?: string; NO_COLOR?: string },
  isTTY: boolean,
): ColorDepth {
  if (!isTTY) return "none";
  // no-color.org: suppress only when NO_COLOR is present AND non-empty. An empty
  // value (`NO_COLOR=""`, a common way to neutralize an inherited var) is not set.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if ((env.TERM ?? "").includes("256color")) return "256";
  return "16";
}

/** Read the process's depth once, from `process.stdout` + `process.env`. */
export function detectColorDepth(): ColorDepth {
  return pickColorDepth(
    {
      COLORTERM: process.env.COLORTERM,
      TERM: process.env.TERM,
      NO_COLOR: process.env.NO_COLOR,
    },
    Boolean(process.stdout.isTTY),
  );
}

/** Round an 8-bit channel to the xterm 6×6×6 color-cube index (0–5). */
function cubeIndex(v: number): number {
  return Math.round((Math.max(0, Math.min(255, v)) / 255) * 5);
}

/** The nearest xterm-256 cube color for an RGB triple. */
function to256(r: number, g: number, b: number): number {
  return 16 + 36 * cubeIndex(r) + 6 * cubeIndex(g) + cubeIndex(b);
}

/**
 * The SGR foreground parameter for a role at a depth, or `null` when nothing
 * should be emitted (`human`, or `none`). Exposed for the palette-realization
 * test, which asserts the mapping directly.
 */
export function sgrFor(role: ColorRole, depth: ColorDepth): string | null {
  if (role === "human" || depth === "none") return null;
  const entry = PALETTE[role];
  switch (depth) {
    case "truecolor":
      return `38;2;${entry.rgb[0]};${entry.rgb[1]};${entry.rgb[2]}`;
    case "256":
      return `38;5;${to256(...entry.rgb)}`;
    case "16":
      return entry.sixteen;
  }
}

/**
 * Wrap `text` in the role's color at the given depth. A no-op (returns `text`
 * unchanged, zero SGR bytes) for `human`, `none`, or empty text — the guarantee
 * the `NO_COLOR`/non-TTY tests assert.
 */
export function colorize(text: string, role: ColorRole, depth: ColorDepth): string {
  const sgr = sgrFor(role, depth);
  if (sgr === null || text === "") return text;
  return `\x1b[${sgr}m${text}\x1b[0m`;
}

/**
 * The bare SGR opener that tints the user's typed input the brand text color.
 * Appended to the REPL prompt WITHOUT a reset, so the terminal echoes the user's
 * keystrokes in that color until the next emitted (self-resetting) output line.
 * Empty at depth `none`, so a piped / `NO_COLOR` / non-TTY session gets a plain
 * prompt with no stray escape bytes. The value is the brand text color
 * (`#FBF7F2`), shared with Habenula's own output (the `habenula` role takes the
 * same token); typed input and Habenula chrome are told apart structurally — by
 * the prompt / `Habenula ›` label — not by hue. Seafoam marks the boot banner and
 * its deeper half a granted outcome; vermilion marks the agent voice.
 */
export function inputSgr(depth: ColorDepth): string {
  // Derived from the `habenula` entry rather than spelled out, so the claim above
  // — that typed input and Habenula's chrome are the same token — is enforced by
  // construction at every depth instead of by three hand-kept literals. `sgrFor`
  // already returns null at depth `none`, which is the empty-string case.
  const sgr = sgrFor("habenula", depth);
  return sgr === null ? "" : `\x1b[${sgr}m`;
}

/** Reverse-video SGR opener — highlights a full row without depending on a color. */
const REVERSE_SGR = "\x1b[7m";

/**
 * Tint only the first occurrence of `keyword` within an already-width-safe
 * `row`, leaving the rest of the row uncolored. The confirmation choices
 * carry their meaning in the number + text; color is a scanning cue on the
 * outcome word alone (deep seafoam `Allow`, coral `Deny`, brand-text `Tell me
 * more`), not the whole line.
 *
 * `row` must be plain text: `colorize` and this helper emit zero-width SGR that
 * `truncateToWidth` (not ANSI-aware) would miscount, so callers truncate first
 * and tint after. At `depth: "none"` the row is returned verbatim (no SGR), so a
 * `NO_COLOR` / piped session stays legible.
 *
 * `reverse` wraps the ENTIRE row in reverse-video for the highlighted arrow-key
 * row. Because the keyword's own color resets with `\x1b[0m` — which also clears
 * reverse — reverse is re-opened after the keyword so the highlight spans the
 * whole row, not just its head. When the keyword was truncated away (a narrow
 * terminal), the row is still reverse-wrapped, just uncolored.
 */
export function tintKeyword(
  row: string,
  keyword: string,
  role: ColorRole,
  depth: ColorDepth,
  opts: { reverse?: boolean } = {},
): string {
  if (depth === "none") return row;
  const reverse = opts.reverse ?? false;
  const sgr = sgrFor(role, depth);
  const idx = keyword === "" ? -1 : row.indexOf(keyword);
  // No keyword to tint (human/none role, or truncated away) — honor reverse only.
  if (sgr === null || idx < 0) {
    return reverse ? `${REVERSE_SGR}${row}\x1b[0m` : row;
  }
  const pre = row.slice(0, idx);
  const kw = row.slice(idx, idx + keyword.length);
  const post = row.slice(idx + keyword.length);
  const coloredKw = `\x1b[${sgr}m${kw}\x1b[0m`;
  if (!reverse) return `${pre}${coloredKw}${post}`;
  // Re-open reverse after the keyword's reset so the tail stays highlighted.
  return `${REVERSE_SGR}${pre}${coloredKw}${REVERSE_SGR}${post}\x1b[0m`;
}
