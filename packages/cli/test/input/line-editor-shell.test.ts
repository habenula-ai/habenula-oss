import { describe, it, expect, beforeEach } from "vitest";
import { RawLineEditor, type RawInput, type RawOutput } from "../../src/input/line-editor";
import type { ServiceSource } from "../../src/input/completion";
import type { SelectionChoice } from "../../src/input/menu";
import type { StatusResponse } from "@habenula-ai/contracts";

/** A status snapshot with a live session (expiry null → no volatile `~Nm left`) or none. */
function status(live: boolean): StatusResponse {
  return {
    session: live ? { sessionId: "s1", startedAt: "2026-07-03T11:48:00.000Z", expiry: null } : null,
    grants: [],
    held: [],
    auditTail: null,
  } as StatusResponse;
}

/**
 * The editor's imperative shell driven through a fake TTY:
 * keypress → reducer → onLine / onSigint / onClose, plus raw-mode setup and
 * teardown. This covers the wiring the pure reducer tests can't — that a
 * completed line reaches the `ReplIO` line handler, Ctrl-C reaches `onSigint`,
 * and close restores cooked mode. Real raw-mode key PARSING (emitKeypressEvents
 * against a live terminal) remains the named PTY smoke check; here we
 * feed already-parsed key events straight to the registered listener.
 */

type KeyArg = { name?: string; ctrl?: boolean; sequence?: string };

class FakeInput implements RawInput {
  isTTY = true;
  rawMode = false;
  resumed = false;
  private keypress: ((str: string | undefined, key: KeyArg | undefined) => void)[] = [];
  private resizeCbs: (() => void)[] = [];
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  on(event: "keypress" | "resize", cb: never): void {
    if (event === "keypress") this.keypress.push(cb as never);
    else if (event === "resize") this.resizeCbs.push(cb as never);
  }
  removeListener(event: "keypress" | "resize", cb: never): void {
    if (event === "keypress") this.keypress = this.keypress.filter((f) => f !== (cb as never));
    else if (event === "resize") this.resizeCbs = this.resizeCbs.filter((f) => f !== (cb as never));
  }
  /** Simulate a SIGWINCH: the editor's resize handler fires (width is read from the output). */
  fireResize(): void {
    for (const cb of [...this.resizeCbs]) cb();
  }
  resume(): void {
    this.resumed = true;
  }
  pause(): void {}
  /** Simulate an already-parsed keystroke. */
  press(str: string | undefined, key?: KeyArg): void {
    for (const cb of [...this.keypress]) cb(str, key);
  }
  get keypressListeners(): number {
    return this.keypress.length;
  }
}

class FakeOutput implements RawOutput {
  columns = 80;
  buf = "";
  write(chunk: string): boolean {
    this.buf += chunk;
    return true;
  }
}

const services: ServiceSource = { connectable: ["gmail"], connected: [] };

function make(): { editor: RawLineEditor; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new RawLineEditor({
    input,
    output,
    depth: "none",
    getServices: () => services,
    // Feed already-parsed key events (see the fake's `press`); skip the real
    // terminal keypress decoder, which needs a live stream (PTY smoke).
    emitKeypress: () => {},
  });
  return { editor, input, output };
}

describe("RawLineEditor shell", () => {
  let editor: RawLineEditor;
  let input: FakeInput;
  let output: FakeOutput;

  beforeEach(() => {
    ({ editor, input, output } = make());
  });

  it("enables raw mode and shows the prompt on first showPrompt", () => {
    editor.setPrompt("> ");
    editor.showPrompt();
    expect(input.rawMode).toBe(true);
    expect(input.resumed).toBe(true);
    expect(output.buf).toContain("> ");
  });

  it("routes a completed line to the onLine handler", () => {
    const lines: string[] = [];
    editor.onLine((l) => lines.push(l));
    editor.setPrompt("> ");
    editor.showPrompt();
    input.press("h", { name: "h" });
    input.press("i", { name: "i" });
    expect(editor.currentLine()).toBe("hi");
    input.press("\r", { name: "return" });
    expect(lines).toEqual(["hi"]);
    expect(editor.currentLine()).toBe(""); // reset after submit
  });

 it("beginSelection draws the choices and routes an Enter pick to onLine as its token", () => {
    const lines: string[] = [];
    editor.onLine((l) => lines.push(l));
    const choices = [
      { label: "1. Deny", role: "denied" as const, token: "1", keyword: "Deny" },
      { label: "2. Tell me more", role: "muted" as const, token: "2", keyword: "Tell me more" },
      { label: "3. For this task", role: "granted" as const, token: "3", keyword: "For" },
    ];
    editor.beginSelection("Choose:", choices, 0);
    // The chooser is painted: prompt + all three choices, Deny marked by default.
    expect(output.buf).toContain("Choose:");
    expect(output.buf).toContain("→ 1. Deny");
    expect(output.buf).toContain("  3. For this task");
    // ↓ then Enter selects "For this task" → token "3" reaches onLine.
    input.press(undefined, { name: "down" });
    input.press(undefined, { name: "down" });
    input.press("\r", { name: "return" });
    expect(lines).toEqual(["3"]);
    expect(editor.currentLine()).toBe(""); // back to line mode after submit
  });

 it("beginSelection: Ctrl-C cancels to onSigint and text keys don't edit", () => {
    let sigints = 0;
    editor.onSigint(() => sigints++);
    editor.beginSelection("Choose:", [{ label: "1. Deny", role: "denied", token: "1", keyword: "Deny" }], 0);
    input.press("x", { name: "x" }); // no buffer to type into
    expect(editor.currentLine()).toBe("");
    input.press(undefined, { name: "c", ctrl: true });
    expect(sigints).toBe(1);
  });

  it("delivers Ctrl-C to onSigint without closing or clearing the buffer", () => {
    let sigints = 0;
    let closed = false;
    editor.onSigint(() => sigints++);
    editor.onClose(() => (closed = true));
    editor.setPrompt("> ");
    editor.showPrompt();
    input.press("a", { name: "a" });
    input.press(undefined, { name: "c", ctrl: true });
    expect(sigints).toBe(1);
    expect(closed).toBe(false);
    expect(editor.currentLine()).toBe("a");
  });

  it("closes and restores cooked mode on Ctrl-D at an empty prompt", () => {
    let closed = false;
    editor.onClose(() => (closed = true));
    editor.setPrompt("> ");
    editor.showPrompt();
    input.press(undefined, { name: "d", ctrl: true });
    expect(closed).toBe(true);
    expect(input.rawMode).toBe(false); // teardown restored cooked mode
    expect(input.keypressListeners).toBe(0); // listener removed
  });

  it("closes only once and detaches the keypress listener", () => {
    let closes = 0;
    editor.onClose(() => closes++);
    editor.setPrompt("> ");
    editor.showPrompt();
    editor.close();
    editor.close();
    expect(closes).toBe(1);
  });

 it("discards type-ahead while no read is outstanding, but still delivers Ctrl-C", () => {
    const lines: string[] = [];
    let sigints = 0;
    editor.onLine((l) => lines.push(l));
    editor.onSigint(() => sigints++);
    editor.setPrompt("> ");
    editor.showPrompt();
    input.press("h", { name: "h" });
    input.press("\r", { name: "return" }); // submit → reading=false (mid-turn now)
    expect(lines).toEqual(["h"]);

    const before = output.buf.length;
    input.press("x", { name: "x" }); // type-ahead over turn output
    expect(editor.currentLine()).toBe(""); // not buffered
    expect(output.buf.length).toBe(before); // no repaint over output
    input.press("\r", { name: "return" }); // phantom Enter
    expect(lines).toEqual(["h"]); // dropped — no stray line, no injected newline

    input.press(undefined, { name: "c", ctrl: true }); // Ctrl-C still flows
    expect(sigints).toBe(1);
  });

  it("restoreInput re-arms reading so the idle prompt accepts input after a poll confirmation", () => {
    editor.setPrompt("> ");
    editor.showPrompt(); // idle read outstanding
    input.press("1", { name: "1" });
    input.press("\r", { name: "return" }); // a (choice) submit clears `reading`
    editor.restoreInput(); // poll restores the still-pending idle prompt
    input.press("y", { name: "y" });
    expect(editor.currentLine()).toBe("y"); // keystrokes accepted again — prompt not dead
  });
});

describe("RawLineEditor — cursor choreography (escape sequences)", () => {
  let editor: RawLineEditor;
  let input: FakeInput;
  let output: FakeOutput;

  beforeEach(() => {
    ({ editor, input, output } = make());
  });

  it("eraseInputLine clears the input area from column 0 (empty prompt)", () => {
    editor.setPrompt("> ");
    editor.showPrompt();
    output.buf = "";
    editor.eraseInputLine();
    // Empty buffer → cursor on row 0 → carriage return + clear-to-end, no up-walk.
    expect(output.buf).toBe("\r\x1b[0J");
  });

  it("restoreInput repaints the prompt after a confirmation drew over it", () => {
    editor.setPrompt("> ");
    editor.showPrompt();
    output.buf = "";
    editor.restoreInput();
    expect(output.buf.startsWith("\r\x1b[0J")).toBe(true);
    expect(output.buf).toContain("> ");
  });

  it("write lifts the input, prints a line above, and redraws the prompt", () => {
    editor.setPrompt("> ");
    editor.showPrompt();
    output.buf = "";
    editor.write("a line above");
    expect(output.buf).toContain("a line above\n");
    expect(output.buf).toContain("> "); // prompt redrawn beneath
  });

  it("erases a wrapped multi-row input by walking up to the top row", () => {
    output.columns = 10; // narrow: prompt(2) + 12 chars = 14 cols → 2 rows
    editor.setPrompt("> ");
    editor.showPrompt();
    for (const ch of "abcdefghijkl") input.press(ch, { name: ch });
    output.buf = "";
    editor.eraseInputLine();
    // Cursor was on row 1 (abs col 14 / 10) → walk up one row, then clear.
    expect(output.buf).toBe("\r\x1b[1A\x1b[0J");
  });
});

describe("RawLineEditor — live status line", () => {
  let editor: RawLineEditor;
  let input: FakeInput;
  let output: FakeOutput;

  beforeEach(() => {
    ({ editor, input, output } = make());
    editor.setPrompt("> ");
  });

  it("paints the status line above the prompt while a read is outstanding", () => {
    editor.showPrompt(); // reading = true
    output.buf = "";
    editor.setStatus(status(true));
    // Status row, then CR/LF, then the prompt — the line sits above the input.
    expect(output.buf).toContain("● live · no services connected\r\n");
    expect(output.buf).toContain("> ");
  });

  it("does NOT repaint mid-turn, but the next prompt shows the cached line", () => {
    editor.showPrompt();
    input.press("h", { name: "h" });
    input.press("\r", { name: "return" }); // submit → reading = false (mid-turn)
    output.buf = "";
    editor.setStatus(status(true)); // a poll tick lands during the turn
    expect(output.buf).toBe(""); // no paint over the turn's output
    editor.showPrompt(); // next read → the cached line is painted now
    expect(output.buf).toContain("● live · no services connected");
  });

  it("does NOT repaint while the completion menu is open (P3)", () => {
    editor.showPrompt();
    input.press(":", { name: ":" }); // opens the command menu
    expect(editor.deferPoll()).toBe(true);
    output.buf = "";
    editor.setStatus(status(true)); // poll tick while the menu is up
    expect(output.buf).toBe(""); // no flicker repaint over the menu
  });

  it("deferPoll tracks the menu: closed → false, open → true", () => {
    editor.showPrompt();
    expect(editor.deferPoll()).toBe(false);
    input.press(":", { name: ":" }); // menu opens
    expect(editor.deferPoll()).toBe(true);
    input.press("z", { name: "z" }); // ":z" matches no command → menu closes
    expect(editor.deferPoll()).toBe(false);
  });

  it("re-renders the status line at the new width on resize (P2)", () => {
    editor.showPrompt();
    editor.setStatus(status(true)); // formatted at width 80 → full text fits
    output.buf = "";
    output.columns = 16; // shrink below the status line's natural width
    input.fireResize();
    // Reformatted at 16 cols: truncated with an ellipsis, so the full text is
    // gone. Before the fix the stale wide string would repaint verbatim.
    expect(output.buf).toContain("…");
    expect(output.buf).not.toContain("no services connected");
  });

  it("does NOT repaint when the rendered status line is unchanged", () => {
    editor.showPrompt();
    editor.setStatus(status(true)); // first snapshot → paints
    output.buf = "";
    editor.setStatus(status(true)); // identical snapshot → nothing to redraw
    expect(output.buf).toBe(""); // no flicker repaint
  });
});

describe("RawLineEditor — poll takeover stashes the half-typed line", () => {
  let editor: RawLineEditor;
  let input: FakeInput;
  let output: FakeOutput;
  let lines: string[];

  beforeEach(() => {
    ({ editor, input, output } = make());
    lines = [];
    editor.onLine((l) => lines.push(l));
    editor.setPrompt("> ");
  });

  it("clears the buffer for the borrowed choice read, then restores it after", () => {
    editor.showPrompt();
    for (const ch of "hello wor") input.press(ch, { name: ch });
    expect(editor.currentLine()).toBe("hello wor");

    // The poll surfaces a held call over the half-typed line (deferPoll is false
    // — no menu open), borrowing the editor for the confirmation's choice read.
    editor.eraseInputLine();
    expect(editor.currentLine()).toBe(""); // stashed + blanked, not prefilled

    // The choice read draws its own prompt on the clean buffer.
    editor.setPrompt("Your choice [1-4]: ");
    output.buf = "";
    editor.showPrompt();
    expect(output.buf).not.toContain("hello wor"); // no stale text in the choice line

    input.press("3", { name: "3" });
    input.press("\r", { name: "return" }); // submits as "3", not "hello wor3"
    expect(lines).toEqual(["3"]);

    // The confirmation resolved; the idle prompt is restored with the typed line.
    editor.setPrompt("> ");
    editor.restoreInput();
    expect(editor.currentLine()).toBe("hello wor");
  });

  it("restoreInput without a prior takeover leaves state untouched", () => {
    editor.showPrompt();
    for (const ch of "draft") input.press(ch, { name: ch });
    editor.restoreInput(); // no eraseInputLine happened → nothing stashed
    expect(editor.currentLine()).toBe("draft");
  });

 it("restoreInput repaints the reset idle prompt after an arrow-key chooser confirmation, not the stale chooser prompt", () => {
    const choices: readonly SelectionChoice[] = [
      { token: "1", role: "denied", label: "1. Deny", keyword: "Deny" },
      { token: "4", role: "granted", label: "4. For this session", keyword: "For" },
    ];
    editor.showPrompt();
    for (const ch of "draft") input.press(ch, { name: ch });

    // The poll surfaces a held call over the half-typed line and borrows the
    // editor for the arrow-key chooser (readSelection → beginSelection),
    // which mutates the shared prompt to the chooser instruction.
    editor.eraseInputLine();
    editor.beginSelection("Choose with ↑/↓ then Enter (or press 1–4):", choices, 0);
    input.press("\r", { name: "return" }); // Enter submits the default highlight
    expect(lines).toEqual(["1"]); // token of index 0 (Deny) — routed like a typed line

    // The adapter (`pollableIO.restoreInputLine`) resets the prompt to idle THEN
    // restores. The real editor must repaint the idle `> `, not the chooser prompt
    // `beginSelection` set — the end-to-end half of the fix on the raw editor.
    output.buf = "";
    editor.setPrompt("> ");
    editor.restoreInput();
    expect(output.buf).toContain("> ");
    expect(output.buf).not.toContain("Choose with");
    expect(editor.currentLine()).toBe("draft"); // stashed buffer survives the chooser
  });
});
