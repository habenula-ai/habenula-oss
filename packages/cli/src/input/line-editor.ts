// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hand-rolled raw-mode line editor. It replaces
 * `node:readline`'s line editor for the interactive prompt: readline's editor
 * and a custom keystroke listener cannot coexist (both consume stdin), so the
 * editor owns the typed buffer end to end. It satisfies the existing `ReplIO`
 * seam, so `ReplController`, `runChatRepl`, and the proactive poll are unchanged
 * only the line *producer* is swapped. Zero new dependency: the
 * editor is built on `node:readline`'s `emitKeypressEvents` (keystroke parsing
 * only, not its line editor) plus raw-mode stdin.
 *
 * The file is two layers:
 *   - **Pure core** (`reduceKey`, `inputLayout`) — buffer/cursor/menu
 *     transitions and cursor geometry, no terminal I/O, unit-tested headlessly
 *     (the parts a real PTY need not cover).
 *   - **`RawLineEditor`** — the thin imperative shell: raw-mode setup, the
 *     keypress→reducer→repaint wiring, cooked-mode restoration, and the cursor
 *     choreography. Real raw-mode key delivery and cross-terminal escape
 *     variance are the one thing headless tests can't cover — that is the named
 *     real-PTY smoke check.
 */

import { emitKeypressEvents } from "node:readline";
import type { StatusResponse } from "@habenula-ai/contracts";
import type { ReplIO } from "../commands/chat";
import { displayWidth, sanitize } from "../render/attribution";
import type { ColorDepth } from "../render/color";
import { formatStatusLine } from "../render/status-line";
import { renderMenu, renderSelection, type SelectionChoice } from "./menu";
import {
  CLOSED_MENU,
  computeCompletions,
  reduceMenu,
  type Completion,
  type MenuState,
  type ServiceSource,
} from "./completion";

// ─────────────────────────────────────────────────────────────────────────────
// Pure core
// ─────────────────────────────────────────────────────────────────────────────

/** A normalized keystroke — the subset of `node:readline`'s key event the reducer needs. */
export interface KeyEvent {
  /** readline's key name (`return`, `backspace`, `up`, `escape`, `space`, `a`, …), if any. */
  readonly name?: string;
  /** Whether Ctrl was held. */
  readonly ctrl: boolean;
  /** The raw escape/byte sequence (used to detect bracketed-paste markers). */
  readonly sequence: string;
  /** The printable string this key produces (`"a"`, `" "`, …); empty for non-printing keys. */
  readonly str: string;
}

/**
 * Confirmation-selection mode (arrow-key nav). When `selection` is set the
 * editor is a chooser, not a line editor: ↑/↓ (and Tab) move the highlight,
 * digits 1–9 jump to a choice, Enter submits the highlighted choice's `token`,
 * and text editing is suppressed. Non-null only between `beginSelection` and the
 * choice's submission; a submit resets to `EMPTY_STATE`, dropping back to line
 * mode. The four confirmation choices are Habenula-authored (trusted chrome).
 */
export interface SelectionState {
  readonly choices: readonly SelectionChoice[];
  /** The highlighted choice, an index into `choices`. */
  readonly index: number;
}

/** The editor's buffer/cursor/menu state — everything the pure reducer transforms. */
export interface EditorState {
  readonly buffer: string;
  /** Insertion point as a UTF-16 index into `buffer` (0 … buffer.length). */
  readonly cursor: number;
  readonly menu: MenuState;
  /** True between a bracketed-paste start and end marker; suppresses key semantics. */
  readonly pasting: boolean;
  /** Non-null while a confirmation chooser is open (arrow-key nav); null in line mode. */
  readonly selection: SelectionState | null;
}

/** The empty editor state — a fresh, blank prompt. */
export const EMPTY_STATE: EditorState = {
  buffer: "",
  cursor: 0,
  menu: CLOSED_MENU,
  pasting: false,
  selection: null,
};

/** What the imperative shell must do after a reduced keystroke (beyond repainting). */
export type EditorEffect =
  | { readonly type: "none" }
  | { readonly type: "submit"; readonly line: string }
  | { readonly type: "close" }
  | { readonly type: "sigint" };

const NONE: EditorEffect = { type: "none" };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Recompute the completion menu for a buffer (used after every text change). */
function refreshMenu(menu: MenuState, buffer: string, services: ServiceSource): MenuState {
  return reduceMenu(menu, { type: "set", items: computeCompletions(buffer, services) });
}

/**
 * Accept the highlighted completion into the buffer. A command that takes a
 * service argument is completed with a trailing space and the menu reopens on
 * the service list; a terminal command or a completed service argument closes
 * the menu. Mirrors `computeCompletions`' command/argument split so the two
 * never disagree about where the token boundary is.
 */
function acceptCompletion(
  buffer: string,
  item: Completion,
  services: ServiceSource,
): { buffer: string; menu: MenuState } {
  const firstSpace = buffer.indexOf(" ");
  if (firstSpace === -1) {
    // Command stage: replace the whole buffer with the command.
    const next = item.expectsArg ? `${item.value} ` : item.value;
    const menu = item.expectsArg
      ? reduceMenu(CLOSED_MENU, { type: "set", items: computeCompletions(next, services) })
      : CLOSED_MENU;
    return { buffer: next, menu };
  }
  // Argument stage: keep the command, replace the argument stem with the service.
  const command = buffer.slice(0, firstSpace);
  return { buffer: `${command} ${item.value}`, menu: CLOSED_MENU };
}

/**
 * Accept the highlighted completion into the buffer — the shared action behind
 * Tab, →, and Enter while the menu is open. Returns the post-accept buffer and
 * menu; the caller decides whether to also submit (Enter) or just stay (Tab/→).
 * A post-accept `menu.open` means a service-taking command reopened its argument
 * list, so there is still a choice to make.
 */
function acceptHighlighted(
  state: EditorState,
  services: ServiceSource,
): { buffer: string; menu: MenuState } {
  return acceptCompletion(state.buffer, state.menu.items[state.menu.index]!, services);
}

/** Insert `text` at the cursor, returning the new buffer and cursor position. */
function insertAt(buffer: string, cursor: number, text: string): { buffer: string; cursor: number } {
  return {
    buffer: buffer.slice(0, cursor) + text + buffer.slice(cursor),
    cursor: cursor + text.length,
  };
}

/**
 * The confirmation-chooser reducer (arrow-key nav). Runs only while
 * `state.selection` is set. ↑/↓ (and Tab) move the highlight with wraparound;
 * a digit 1–9 jumps to that choice (jump only — Enter still confirms, per the
 * arrow-first UX); Enter submits the highlighted choice's `token` and resets to
 * `EMPTY_STATE` (back to line mode); Ctrl-C cancels the prompt (sigint → the
 * REPL's `cancelChoice`, leaving the call parked) and Ctrl-D closes on EOF. Every
 * other key — including any printable text and Esc — is a no-op, so nothing can
 * be typed into a choice and only an explicit Enter resolves it.
 */
function reduceSelection(
  state: EditorState,
  key: KeyEvent,
): { state: EditorState; effect: EditorEffect } {
  const sel = state.selection!;
  if (key.ctrl && key.name === "c") return { state, effect: { type: "sigint" } };
  if (key.ctrl && key.name === "d") return { state, effect: { type: "close" } };
  const move = (delta: number): { state: EditorState; effect: EditorEffect } => {
    const n = sel.choices.length;
    const index = n === 0 ? 0 : (((sel.index + delta) % n) + n) % n;
    return { state: { ...state, selection: { ...sel, index } }, effect: NONE };
  };
  switch (key.name) {
    case "up":
      return move(-1);
    case "down":
    case "tab":
      return move(1);
    case "return":
    case "enter": {
      const token = sel.choices[sel.index]?.token ?? "";
      // Submitting exits selection mode: EMPTY_STATE has `selection: null`.
      return { state: EMPTY_STATE, effect: { type: "submit", line: token } };
    }
    default: {
      // A digit jumps the highlight to that choice (no submit). Guarded to the
      // real range so `9` on a four-item list is ignored, not clamped.
      if (/^[1-9]$/.test(key.str)) {
        const i = Number(key.str) - 1;
        if (i < sel.choices.length) {
          return { state: { ...state, selection: { ...sel, index: i } }, effect: NONE };
        }
      }
      return { state, effect: NONE };
    }
  }
}

/**
 * The pure keypress reducer. Maps `(state, key)` to the
 * next state plus an effect the shell performs. No terminal I/O, so every
 * buffer/cursor/menu transition and the Enter/Esc/Ctrl-C/Ctrl-D semantics are
 * unit-tested by feeding synthetic key events. Menu navigation takes precedence
 * over line editing only for the keys the menu owns (↑/↓ move the highlight;
 * Tab/→ accept it; Esc closes; Enter accepts-then-submits when the menu is open);
 * every other key edits the line whether or not the menu is showing.
 */
export function reduceKey(
  state: EditorState,
  key: KeyEvent,
  services: ServiceSource,
): { state: EditorState; effect: EditorEffect } {
  // Bracketed paste: everything between the markers is literal text, so a
  // pasted newline can't submit and a pasted ESC can't dismiss the menu.
  if (key.sequence === PASTE_START) return { state: { ...state, pasting: true }, effect: NONE };
  if (key.sequence === PASTE_END) return { state: { ...state, pasting: false }, effect: NONE };
  // Confirmation chooser: a distinct mode with no text editing — every key
  // either moves/jumps the highlight, submits it, or is a no-op. Handled before
  // the paste/ctrl/line branches so pasted text can't leak into a choice and the
  // editor keys (↑/↓/Enter) mean "navigate", not "edit".
  if (state.selection) return reduceSelection(state, key);
  if (state.pasting) {
    // Escape hatch: if PASTE_END never arrives (interrupted paste, odd
    // terminal framing), a lone Esc or Ctrl-C breaks out of paste mode so the
    // editor can't wedge with Enter dead and Ctrl-C swallowed. Ctrl-C also
    // raises sigint, so a doubly-stuck user can still interrupt.
    if (key.name === "escape") return { state: { ...state, pasting: false }, effect: NONE };
    if (key.ctrl && key.name === "c") {
      return { state: { ...state, pasting: false }, effect: { type: "sigint" } };
    }
    if (key.str === "") return { state, effect: NONE };
    // Flatten newlines to spaces so a multi-line paste stays one line.
    const flat = key.str.replace(/[\r\n]+/g, " ");
    const { buffer, cursor } = insertAt(state.buffer, state.cursor, flat);
    return { state: { ...state, buffer, cursor, menu: refreshMenu(state.menu, buffer, services) }, effect: NONE };
  }

  // Control chords the editor owns (raw mode delivers these as keys, not signals).
  if (key.ctrl) {
    switch (key.name) {
      case "c":
        return { state, effect: { type: "sigint" } };
      case "d":
        // EOF only on an empty buffer, matching readline's Ctrl-D semantics.
        return state.buffer === ""
          ? { state, effect: { type: "close" } }
          : { state, effect: NONE };
      case "a":
        return { state: { ...state, cursor: 0 }, effect: NONE };
      case "e":
        return { state: { ...state, cursor: state.buffer.length }, effect: NONE };
      default:
        return { state, effect: NONE };
    }
  }

  switch (key.name) {
    case "return":
    case "enter": {
      if (state.menu.open && state.menu.items.length > 0) {
        const { buffer, menu } = acceptHighlighted(state, services);
        // Enter completes + submits: take the highlighted item, then run it. The
        // one exception is a service-taking command (`:conn` → `:connect `),
        // where accepting reopens the argument (service) menu — there is still a
        // choice to make, so stay and let the user pick it. Otherwise nothing is
        // left to complete (a terminal command, or a fully-typed argument), so
        // submit. This subsumes the single-Enter rule: a no-op accept leaves
        // the menu closed and falls through to submit.
        if (menu.open) {
          return { state: { ...state, buffer, cursor: buffer.length, menu }, effect: NONE };
        }
        return { state: EMPTY_STATE, effect: { type: "submit", line: buffer } };
      }
      // Menu closed: submit the line and reset to a blank editor.
      return { state: EMPTY_STATE, effect: { type: "submit", line: state.buffer } };
    }
    case "tab": {
      // Tab autocompletes: accept the highlighted item without submitting. On a
      // closed menu there is nothing highlighted, so open it on the current
      // completions instead (the way back after Esc). ↑/↓ move the highlight now
      // — Tab no longer cycles.
      if (state.menu.open && state.menu.items.length > 0) {
        const { buffer, menu } = acceptHighlighted(state, services);
        return { state: { ...state, buffer, cursor: buffer.length, menu }, effect: NONE };
      }
      return { state: { ...state, menu: refreshMenu(state.menu, state.buffer, services) }, effect: NONE };
    }
    case "up":
      return { state: { ...state, menu: reduceMenu(state.menu, { type: "up" }) }, effect: NONE };
    case "down":
      return { state: { ...state, menu: reduceMenu(state.menu, { type: "down" }) }, effect: NONE };
    case "escape":
      return { state: { ...state, menu: reduceMenu(state.menu, { type: "close" }) }, effect: NONE };
    case "left":
      return { state: { ...state, cursor: Math.max(0, state.cursor - 1) }, effect: NONE };
    case "right": {
      // → autocompletes when the menu is open: accept the highlighted item
      // without submitting. With the menu closed it moves the cursor right.
      if (state.menu.open && state.menu.items.length > 0) {
        const { buffer, menu } = acceptHighlighted(state, services);
        return { state: { ...state, buffer, cursor: buffer.length, menu }, effect: NONE };
      }
      return { state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) }, effect: NONE };
    }
    case "home":
      return { state: { ...state, cursor: 0 }, effect: NONE };
    case "end":
      return { state: { ...state, cursor: state.buffer.length }, effect: NONE };
    case "backspace": {
      if (state.cursor === 0) return { state, effect: NONE };
      const buffer = state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor);
      const cursor = state.cursor - 1;
      return { state: { ...state, buffer, cursor, menu: refreshMenu(state.menu, buffer, services) }, effect: NONE };
    }
    case "delete": {
      if (state.cursor >= state.buffer.length) return { state, effect: NONE };
      const buffer = state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1);
      return { state: { ...state, buffer, menu: refreshMenu(state.menu, buffer, services) }, effect: NONE };
    }
    default: {
      // A printable key (letters, digits, space, punctuation). Non-printing keys
      // arrive with an empty or control `str` and fall through as a no-op.
      if (key.str === "" || isControlStr(key.str)) return { state, effect: NONE };
      const { buffer, cursor } = insertAt(state.buffer, state.cursor, key.str);
      return { state: { ...state, buffer, cursor, menu: refreshMenu(state.menu, buffer, services) }, effect: NONE };
    }
  }
}

/** True when a string is a single C0/DEL control byte (never inserted as text). */
function isControlStr(str: string): boolean {
  if (str.length !== 1) return false;
  const cp = str.codePointAt(0)!;
  return cp < 0x20 || cp === 0x7f;
}

/**
 * The physical geometry of the prompt + buffer at `cols` columns: how many rows
 * it occupies and where the cursor sits (row, column), both relative to the top
 * of the input area. Pure, so the wrap/cursor math is unit-tested rather than
 * only dogfooded — the editor's repaint uses it to move the cursor exactly.
 * `promptWidth` is the prompt's PLAIN display width (SGR stripped by the caller),
 * so a zero-width tint never skews the geometry.
 */
export function inputLayout(
  promptWidth: number,
  buffer: string,
  cursor: number,
  cols: number,
): { rows: number; cursorRow: number; cursorCol: number } {
  const c = cols > 0 ? cols : 80;
  const total = promptWidth + displayWidth(buffer);
  const cursorAbs = promptWidth + displayWidth(buffer.slice(0, cursor));
  const cursorRow = Math.floor(cursorAbs / c);
  const cursorCol = cursorAbs % c;
  const rows = Math.max(1, Math.ceil((total || 1) / c), cursorRow + 1);
  return { rows, cursorRow, cursorCol };
}

// ─────────────────────────────────────────────────────────────────────────────
// Imperative shell
// ─────────────────────────────────────────────────────────────────────────────

/** A `keypress` listener as `node:readline` delivers it. */
type KeypressListener = (str: string | undefined, key: RawKey | undefined) => void;

/** The stdin surface the editor drives (a TTY `process.stdin`). Exported so the wiring in `chat.ts` can cast to it. */
export interface RawInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  on(event: "keypress", cb: KeypressListener): void;
  on(event: "resize", cb: () => void): void;
  removeListener(event: "keypress", cb: KeypressListener): void;
  removeListener(event: "resize", cb: () => void): void;
  resume?(): void;
  pause?(): void;
}

/** The stdout surface the editor draws to. */
export interface RawOutput {
  write(chunk: string): boolean;
  columns?: number;
}

export interface RawLineEditorOptions {
  input: RawInput;
  output: RawOutput;
  depth: ColorDepth;
  /** Current completion sources; read on each menu recompute so a late fetch is picked up. */
  getServices: () => ServiceSource;
  /** Registers a process-exit hook so cooked mode is restored even on a crash. */
  onExit?: (cb: () => void) => void;
  /**
   * Installs `keypress`-event parsing on the input. Defaults to
   * `node:readline`'s `emitKeypressEvents` (the production path); injected so a
   * headless shell test can feed already-parsed key events without a live
   * terminal. Real-terminal key parsing is the named PTY smoke check.
   */
  emitKeypress?: (input: RawInput) => void;
}

/**
 * The raw-mode editor as a `ReplIO`. One instance serves BOTH the idle read and
 * a confirmation's choice read (single stdin owner): the
 * completion menu only appears for the idle prompt because that is the only
 * context whose buffer parses to `:`-commands, but there is never a second
 * keystroke consumer.
 */
export class RawLineEditor implements ReplIO {
  private state: EditorState = EMPTY_STATE;
  private prompt = "";
  private lineCb: ((line: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private sigintCb: (() => void) | null = null;
  private started = false;
  private closed = false;
  /**
   * True while a read is outstanding — between `showPrompt` and the line's
   * submission. When false the REPL is processing a turn (no prompt shown), so
   * keystrokes must not paint over its output or submit a phantom line.
   */
  private reading = false;
  /** The colored status-line row drawn above the prompt; empty until the poll feeds a snapshot. */
  private statusLine = "";
  /** The last status snapshot, retained so a resize can re-render the line at the new width. */
  private lastStatus: StatusResponse | null = null;
  /**
   * The half-typed line set aside while a foreign prompt (a poll-surfaced
   * confirmation's choice read) borrows the editor. `eraseInputLine` stashes it
   * and blanks the state so the choice reads on a clean buffer; `restoreInput`
   * puts it back. Without this, the poll — which now surfaces over a mid-typed
   * line (`deferPoll` defers only for an open menu) — would render the choice
   * prompt prefilled with the user's text and submit it as the answer.
   */
  private stashed: { buffer: string; cursor: number } | null = null;
  /** The cursor's row within the input area after the last paint — where a repaint starts from. */
  private lastCursorRow = 0;
  private readonly keypressHandler: KeypressListener;
  private readonly resizeHandler: () => void;

  constructor(private readonly opts: RawLineEditorOptions) {
    this.keypressHandler = (str, key) => this.onKeypress(str, key);
    this.resizeHandler = () => this.onResize();
  }

  /**
   * On SIGWINCH the terminal has already reflowed at the new width, so the old
   * `lastCursorRow` is stale — walking up by it (as `paint(false)` would) can
   * clobber unrelated lines above. Redraw as if fresh instead: clear from the
   * current line down and repaint. Rows that wrapped above the cursor at the old
   * width may linger (cosmetic), but nothing above is corrupted. Only
   * while a read is outstanding — a resize mid-turn must not paint over output.
   */
  private onResize(): void {
    if (!this.reading) return;
    // Re-render the status line at the new width first: `formatStatusLine`
    // clamps to the width it was given, so the string cached at the old width
    // could exceed the new `cols()` and wrap to a second physical row that
    // `paint`'s `statusRows` (always 1) wouldn't account for.
    this.renderStatusLine();
    this.lastCursorRow = 0;
    this.paint(true);
  }

  /** Re-derive the colored status line from the last snapshot at the current width. No-op before any snapshot. */
  private renderStatusLine(): void {
    if (!this.lastStatus) return;
    this.statusLine = formatStatusLine({
      session: this.lastStatus.session,
      connected: this.opts.getServices().connected,
      now: new Date(),
      depth: this.opts.depth,
      width: this.cols(),
    });
  }

  // ── ReplIO ────────────────────────────────────────────────────────────────

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onSigint(cb: () => void): void {
    this.sigintCb = cb;
  }
  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }
  currentLine(): string {
    return this.state.buffer;
  }

  deferPoll(): boolean {
    // The editor owns the buffer, so it can lift a half-typed line aside and
    // restore it — the poll no longer defers on mid-typing. It defers only while
    // the completion menu is open, where drawing a confirmation over the menu
    // would be visually incoherent (reversing the
    // defer-while-typing trade-off).
    return this.state.menu.open;
  }

  setStatus(status: StatusResponse): void {
    // Cache the snapshot and re-derive the line from the poll's session data +
    // the completion cache's connected set. The poll feeds this every tick, so
    // the cached line always reflects the latest `~Nm left`.
    this.lastStatus = status;
    const prev = this.statusLine;
    this.renderStatusLine();
    // Skip the repaint when the rendered line is unchanged: the poll fires every
    // interval but `~Nm left` only ticks once a minute, and a full erase+repaint
    // each time flickers a multi-row buffer for no content change.
    if (this.statusLine === prev) return;
    // Repaint only while a read is outstanding AND the menu is closed. Mid-turn
    // (`reading` false) a repaint would draw the status line + prompt over the
    // turn's streaming output — the exact regression the guard prevents;
    // with the menu open (`deferPoll`) it would flicker the menu every tick (P3).
    // The cached line still updated above, so the next real paint shows it fresh.
    if (this.started && !this.closed && this.reading && !this.deferPoll()) this.paint(false);
  }

  showPrompt(): void {
    this.ensureStarted();
    // A read is now outstanding: keystrokes edit the line again.
    this.reading = true;
    // A fresh prompt starts a new input area at the current cursor line.
    this.lastCursorRow = 0;
    this.paint(true);
  }

  /**
   * Enter confirmation-chooser mode (arrow-key nav): show `prompt` with the
   * `choices` listed beneath it, `defaultIndex` highlighted. ↑/↓ move the
   * highlight, digits jump, Enter submits the choice's token (routed through the
   * normal `onLine` path, so the `ReplController` resolves it like a typed line).
   * The buffer is blanked so no completion menu computes and no stray typed text
   * survives. `defaultIndex` is clamped into range; the caller passes Deny so an
   * accidental Enter denies rather than grants.
   */
  beginSelection(prompt: string, choices: readonly SelectionChoice[], defaultIndex: number): void {
    const index = choices.length === 0 ? 0 : Math.min(Math.max(0, defaultIndex), choices.length - 1);
    this.setPrompt(prompt);
    this.state = { ...EMPTY_STATE, selection: { choices, index } };
    this.showPrompt();
  }

  eraseInputLine(): void {
    if (!this.opts.input.isTTY) return;
    // Set the half-typed line aside and blank the state before the poll draws a
    // confirmation: the choice read reuses this editor, so a non-empty buffer
    // would otherwise be painted into (and submitted as) the choice.
    this.stashed = { buffer: this.state.buffer, cursor: this.state.cursor };
    this.state = EMPTY_STATE;
    // Move to the top-left of the input area and clear everything below (input
    // rows + any menu), so the caller (the poll) can draw from column 0.
    const up = this.lastCursorRow > 0 ? `\x1b[${this.lastCursorRow}A` : "";
    this.opts.output.write(`\r${up}\x1b[0J`);
    this.lastCursorRow = 0;
  }

  restoreInput(): void {
    // Called after the poll drew a confirmation over the idle prompt: the idle
    // read is still outstanding, so re-arm `reading` (the choice's submit cleared
    // it) — otherwise the restored idle prompt would ignore every keystroke.
    this.reading = true;
    // Put the stashed half-typed line back (the choice's submit reset state to
    // EMPTY_STATE); no stash → nothing was borrowed, so leave state as is.
    if (this.stashed) {
      this.state = { ...EMPTY_STATE, buffer: this.stashed.buffer, cursor: this.stashed.cursor };
      this.stashed = null;
    }
    this.lastCursorRow = 0;
    this.paint(true);
  }

  write(text: string): void {
    // Compose over the input line: lift it, print the line above, redraw.
    this.eraseInputLine();
    this.opts.output.write(`${text}\n`);
    this.paint(true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    const cb = this.closeCb;
    this.closeCb = null;
    cb?.();
  }

  // ── raw-mode plumbing ───────────────────────────────────────────────────────

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const { input } = this.opts;
    (this.opts.emitKeypress ?? emitKeypressEvents)(input);
    if (input.isTTY) {
      input.setRawMode?.(true);
      // Enable bracketed paste so a paste's bytes are framed and can't submit.
      this.opts.output.write("\x1b[?2004h");
    }
    input.resume?.();
    input.on("keypress", this.keypressHandler);
    input.on("resize", this.resizeHandler);
    this.opts.onExit?.(() => this.teardown());
  }

  private teardown(): void {
    const { input } = this.opts;
    input.removeListener("keypress", this.keypressHandler);
    input.removeListener("resize", this.resizeHandler);
    if (input.isTTY) {
      this.opts.output.write("\x1b[?2004l"); // disable bracketed paste
      input.setRawMode?.(false);
    }
    input.pause?.();
  }

  private onKeypress(str: string | undefined, key: RawKey | undefined): void {
    if (this.closed) return;
    const event: KeyEvent = {
      name: key?.name,
      ctrl: Boolean(key?.ctrl),
      sequence: key?.sequence ?? str ?? "",
      str: str ?? "",
    };
    // No read outstanding → the REPL is mid-turn (spinner / streaming output).
    // Discard type-ahead so a keystroke can't repaint over that output and Enter
    // can't submit a phantom line the router would silently drop. Ctrl-C still
    // flows through, so chat.ts can show its mid-turn hint or detach.
    if (!this.reading) {
      if (event.ctrl && event.name === "c") this.sigintCb?.();
      return;
    }
    const { state, effect } = reduceKey(this.state, event, this.opts.getServices());
    this.state = state;
    switch (effect.type) {
      case "sigint":
        this.sigintCb?.();
        return;
      case "close":
        this.close();
        return;
      case "submit":
        this.finalizeSubmit(effect.line);
        return;
      case "none":
        this.paint(false);
    }
  }

  /**
   * Hand off the submitted line, leaving history clean: erase the whole input
   * area (status line + prompt + any menu) and redraw only the prompt + command
   * on one line, so the status line does not accumulate a stale copy per command
   * in the scrollback. Then drop to a fresh line for the turn's output.
   */
  private finalizeSubmit(line: string): void {
    const { output, input, depth } = this.opts;
    if (input.isTTY) {
      const up = this.lastCursorRow > 0 ? `\x1b[${this.lastCursorRow}A` : "";
      let out = `\r${up}\x1b[0J${this.prompt}${line}`;
      if (depth !== "none") out += "\x1b[0m";
      out += "\r\n";
      output.write(out);
    }
    // Keep `statusLine` (not cleared): the clean-history redraw above omits it,
    // but the next prompt repaints it immediately so there is no gap until the
    // next poll tick refreshes the time.
    this.lastCursorRow = 0;
    // The line is handed off; the REPL now processes the turn. Stop treating
    // stdin as line input until the next `showPrompt` (type-ahead guard).
    this.reading = false;
    const cb = this.lineCb;
    cb?.(line);
  }

  /**
   * Repaint the status line + prompt + buffer + menu, then park the cursor at
   * the edit position. The input area is, top to bottom: the status line (one
   * row, when set), the prompt + buffer (wrapping across `layout.rows`), then the
   * menu (one row per item). `lastCursorRow` is the cursor's row within that
   * whole block, so a later erase walks up to the block's top.
   */
  private paint(fresh: boolean): void {
    const { output, input, depth } = this.opts;
    if (!input.isTTY) return;
    const cols = this.cols();
    const layout = inputLayout(this.promptWidth(), this.state.buffer, this.state.cursor, cols);
    const statusRows = this.statusLine === "" ? 0 : 1;

    let out = "";
    // Erase the previously-painted area unless this is a fresh prompt (nothing drawn yet).
    if (!fresh) {
      const up = this.lastCursorRow > 0 ? `\x1b[${this.lastCursorRow}A` : "";
      out += `\r${up}\x1b[0J`;
    } else {
      out += "\r\x1b[0J";
    }
    // Status line above the prompt, on its own row.
    if (statusRows) out += `${this.statusLine}\r\n`;
    // Prompt + buffer. The prompt carries the (no-reset) typed-input tint, so the
    // buffer echoes in it; reset before the menu so its rows aren't tinted.
    out += this.prompt + this.state.buffer;
    if (depth !== "none") out += "\x1b[0m";

    // Below the prompt, each row on its own physical line: the confirmation
    // chooser's choices (arrow-key nav) when a selection is open, else the
    // completion menu. The two never coexist — selection mode blanks the buffer,
    // so no `:`-command completions compute.
    const menuRows = this.state.selection
      ? renderSelection(
          this.state.selection.choices,
          this.state.selection.index,
          cols,
          depth,
        )
      : this.state.menu.open && this.state.menu.items.length > 0
        ? renderMenu(this.state.menu.items, this.state.menu.index, cols, { color: depth !== "none" })
        : [];
    for (const row of menuRows) out += `\r\n${row}`;

    // Reposition to the edit point. Rows are measured within the whole input
    // area: the status line offsets the prompt block down by `statusRows`.
    const cursorRow = statusRows + layout.cursorRow;
    const bottomRow = statusRows + (layout.rows - 1) + menuRows.length;
    const upToCursor = bottomRow - cursorRow;
    if (upToCursor > 0) out += `\x1b[${upToCursor}A`;
    out += "\r";
    if (layout.cursorCol > 0) out += `\x1b[${layout.cursorCol}C`;

    output.write(out);
    this.lastCursorRow = cursorRow;
  }

  private cols(): number {
    const c = this.opts.output.columns;
    return c && c > 0 ? c : 80;
  }

  /** The prompt's plain display width (SGR stripped), for the wrap/cursor math. */
  private promptWidth(): number {
    return displayWidth(sanitize(this.prompt));
  }
}

/** The raw key shape `node:readline`'s `keypress` event delivers. */
interface RawKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}
