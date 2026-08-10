import { describe, it, expect } from "vitest";
import {
  reduceKey,
  inputLayout,
  EMPTY_STATE,
  type EditorState,
  type KeyEvent,
} from "../../src/input/line-editor";
import type { ServiceSource } from "../../src/input/completion";

/**
 * The editor's pure core — the keypress reducer and the
 * wrap/cursor geometry. Headless: synthetic key events drive every buffer /
 * cursor / menu transition and the Enter / Esc / Ctrl-C / Ctrl-D / paste
 * semantics. Real raw-mode key delivery is the one thing this can't cover — the
 * named real-PTY smoke check.
 */

const services: ServiceSource = {
  connectable: ["mock_email", "gmail", "google_calendar"],
  connected: ["gmail"],
};

/** Build a normalized key event. `str` defaults to the name for printable convenience. */
function k(partial: Partial<KeyEvent> & { name?: string; str?: string }): KeyEvent {
  return {
    name: partial.name,
    ctrl: partial.ctrl ?? false,
    sequence: partial.sequence ?? partial.str ?? "",
    str: partial.str ?? "",
  };
}

/** Type a printable string one char at a time through the reducer. */
function type(state: EditorState, text: string): EditorState {
  let s = state;
  for (const ch of text) {
    ({ state: s } = reduceKey(s, k({ name: ch, str: ch }), services));
  }
  return s;
}

describe("reduceKey — text editing", () => {
  it("inserts printable characters at the cursor", () => {
    const s = type(EMPTY_STATE, "hi");
    expect(s.buffer).toBe("hi");
    expect(s.cursor).toBe(2);
  });

  it("inserts a space (name=space is not a control key)", () => {
    const s = reduceKey(type(EMPTY_STATE, "a"), k({ name: "space", str: " " }), services).state;
    expect(s.buffer).toBe("a ");
  });

  it("backspaces the character before the cursor", () => {
    const s = reduceKey(type(EMPTY_STATE, "abc"), k({ name: "backspace", str: "\x7f" }), services).state;
    expect(s.buffer).toBe("ab");
    expect(s.cursor).toBe(2);
  });

  it("backspace at column 0 is a no-op", () => {
    const { state, effect } = reduceKey(EMPTY_STATE, k({ name: "backspace" }), services);
    expect(state.buffer).toBe("");
    expect(effect.type).toBe("none");
  });

  it("inserts mid-buffer at the cursor and forward-deletes", () => {
    let s = type(EMPTY_STATE, "ac");
    s = reduceKey(s, k({ name: "left" }), services).state; // cursor between a and c
    s = reduceKey(s, k({ name: "b", str: "b" }), services).state;
    expect(s.buffer).toBe("abc");
    expect(s.cursor).toBe(2);
    s = reduceKey(s, k({ name: "delete" }), services).state; // deletes 'c'
    expect(s.buffer).toBe("ab");
  });

  it("moves the cursor with arrows, home, and end (clamped)", () => {
    let s = type(EMPTY_STATE, "abc");
    s = reduceKey(s, k({ name: "home" }), services).state;
    expect(s.cursor).toBe(0);
    s = reduceKey(s, k({ name: "left" }), services).state; // clamped
    expect(s.cursor).toBe(0);
    s = reduceKey(s, k({ name: "end" }), services).state;
    expect(s.cursor).toBe(3);
    s = reduceKey(s, k({ name: "right" }), services).state; // clamped
    expect(s.cursor).toBe(3);
  });

  it("ctrl-a jumps home, ctrl-e jumps to end", () => {
    let s = type(EMPTY_STATE, "abc");
    s = reduceKey(s, k({ name: "a", ctrl: true }), services).state;
    expect(s.cursor).toBe(0);
    s = reduceKey(s, k({ name: "e", ctrl: true }), services).state;
    expect(s.cursor).toBe(3);
  });

  it("ignores a stray control byte as text", () => {
    const { state } = reduceKey(EMPTY_STATE, k({ str: "\x00" }), services);
    expect(state.buffer).toBe("");
  });
});

describe("reduceKey — submit / close / interrupt", () => {
  it("Enter on a closed menu submits the line and resets the editor", () => {
    const s = type(EMPTY_STATE, "hello");
    const { state, effect } = reduceKey(s, k({ name: "return" }), services);
    expect(effect).toEqual({ type: "submit", line: "hello" });
    expect(state).toEqual(EMPTY_STATE);
  });

  it("Ctrl-C emits sigint without touching the buffer", () => {
    const s = type(EMPTY_STATE, "half typed");
    const { state, effect } = reduceKey(s, k({ name: "c", ctrl: true }), services);
    expect(effect).toEqual({ type: "sigint" });
    expect(state.buffer).toBe("half typed");
  });

  it("Ctrl-D on an empty buffer closes; on a non-empty buffer is a no-op", () => {
    expect(reduceKey(EMPTY_STATE, k({ name: "d", ctrl: true }), services).effect).toEqual({
      type: "close",
    });
    const s = type(EMPTY_STATE, "x");
    expect(reduceKey(s, k({ name: "d", ctrl: true }), services).effect.type).toBe("none");
  });
});

describe("reduceKey — completion menu", () => {
  it("opens the command menu as the user types a colon-stem", () => {
    const s = type(EMPTY_STATE, ":co");
    expect(s.menu.open).toBe(true);
    expect(s.menu.items.map((i) => i.value)).toEqual([":connect"]);
  });

  it("Enter accepts a service-taking command, appends a space, and reopens on the service list", () => {
    let s = type(EMPTY_STATE, ":conn");
    const r = reduceKey(s, k({ name: "return" }), services);
    expect(r.effect.type).toBe("none"); // accept, not submit
    s = r.state;
    expect(s.buffer).toBe(":connect ");
    expect(s.menu.open).toBe(true);
    expect(s.menu.items.map((i) => i.value)).toEqual(["mock_email", "gmail", "google_calendar"]);
  });

  it("Enter completes a partial terminal stem and submits it on one press", () => {
    // Option A: Enter takes the highlighted `:status` and runs it — no separate
    // accept-then-submit. Accepting a terminal command leaves nothing to
    // complete (menu closed), so Enter submits.
    const s = type(EMPTY_STATE, ":stat");
    const { state, effect } = reduceKey(s, k({ name: "return" }), services);
    expect(effect).toEqual({ type: "submit", line: ":status" });
    expect(state).toEqual(EMPTY_STATE);
  });

  it("Tab accepts the highlighted terminal command without submitting", () => {
    const s = type(EMPTY_STATE, ":stat");
    const r = reduceKey(s, k({ name: "tab" }), services);
    expect(r.effect.type).toBe("none");
    expect(r.state.buffer).toBe(":status");
    expect(r.state.cursor).toBe(":status".length);
    expect(r.state.menu.open).toBe(false);
    // A following Enter (menu now closed) submits.
    expect(reduceKey(r.state, k({ name: "return" }), services).effect).toEqual({
      type: "submit",
      line: ":status",
    });
  });

  it("→ accepts the highlighted completion (no submit) while the menu is open", () => {
    const s = type(EMPTY_STATE, ":stat");
    const r = reduceKey(s, k({ name: "right" }), services);
    expect(r.effect.type).toBe("none");
    expect(r.state.buffer).toBe(":status");
    expect(r.state.menu.open).toBe(false);
  });

  it("→ moves the cursor once the menu is closed", () => {
    let s = type(EMPTY_STATE, ":stat"); // 5 chars, cursor at 5
    s = reduceKey(s, k({ name: "escape" }), services).state; // close the menu
    s = reduceKey(s, k({ name: "left" }), services).state; // cursor at 4
    expect(s.cursor).toBe(4);
    const r = reduceKey(s, k({ name: "right" }), services);
    expect(r.state.cursor).toBe(5);
    expect(r.state.buffer).toBe(":stat"); // buffer untouched — just moved
  });

  it("Tab and → accept a service-taking command and keep the argument menu open", () => {
    for (const key of ["tab", "right"] as const) {
      const s = type(EMPTY_STATE, ":conn");
      const r = reduceKey(s, k({ name: key }), services);
      expect(r.effect.type).toBe("none");
      expect(r.state.buffer).toBe(":connect ");
      expect(r.state.menu.open).toBe(true);
      expect(r.state.menu.items.map((i) => i.value)).toEqual([
        "mock_email",
        "gmail",
        "google_calendar",
      ]);
    }
  });

  it("Enter on a fully-typed no-arg command submits on one press (no double-Enter)", () => {
    // The exact-match menu item is still open, but accepting it would change
    // nothing — so Enter submits rather than swallowing the first press.
    const s = type(EMPTY_STATE, ":clear");
    expect(s.menu.open).toBe(true);
    expect(s.menu.items.map((i) => i.value)).toEqual([":clear"]);
    const { state, effect } = reduceKey(s, k({ name: "return" }), services);
    expect(effect).toEqual({ type: "submit", line: ":clear" });
    expect(state).toEqual(EMPTY_STATE);
  });

 it("Enter on a fully-typed service argument submits on one press", () => {
    const s = type(EMPTY_STATE, ":connect gmail");
    expect(s.menu.open).toBe(true);
    expect(s.menu.items.map((i) => i.value)).toEqual(["gmail"]);
    const { effect } = reduceKey(s, k({ name: "return" }), services);
    expect(effect).toEqual({ type: "submit", line: ":connect gmail" });
  });

 it("Enter on a fully-typed service-taking command still advances to the argument, not submit", () => {
    // `:connect` exactly typed matches only itself, but it expects an argument —
    // Enter appends the space and reopens on the service list rather than running.
    const s = type(EMPTY_STATE, ":connect");
    const r = reduceKey(s, k({ name: "return" }), services);
    expect(r.effect.type).toBe("none");
    expect(r.state.buffer).toBe(":connect ");
    expect(r.state.menu.open).toBe(true);
  });

  it("arrows move the highlight; Enter accepts the highlighted service and submits it", () => {
    let s = type(EMPTY_STATE, ":connect g");
    expect(s.menu.items.map((i) => i.value)).toEqual(["gmail", "google_calendar"]);
    s = reduceKey(s, k({ name: "down" }), services).state; // highlight google_calendar
    // Accepting a service closes the menu (nothing left to complete), so Enter
    // completes + submits in one press.
    const r = reduceKey(s, k({ name: "return" }), services);
    expect(r.effect).toEqual({ type: "submit", line: ":connect google_calendar" });
    expect(r.state).toEqual(EMPTY_STATE);
  });

  it("Esc dismisses the menu so the next Enter submits", () => {
    let s = type(EMPTY_STATE, ":co");
    s = reduceKey(s, k({ name: "escape" }), services).state;
    expect(s.menu.open).toBe(false);
    expect(reduceKey(s, k({ name: "return" }), services).effect).toEqual({
      type: "submit",
      line: ":co",
    });
  });

  it("Tab reopens a dismissed menu, then accepts the highlighted item", () => {
    let s = type(EMPTY_STATE, ":connect "); // three services
    s = reduceKey(s, k({ name: "escape" }), services).state; // dismissed
    s = reduceKey(s, k({ name: "tab" }), services).state; // closed → reopen, top
    expect(s.menu.open).toBe(true);
    expect(s.menu.index).toBe(0);
    // ↓ moves the highlight (Tab no longer cycles), then Tab accepts it.
    s = reduceKey(s, k({ name: "down" }), services).state;
    expect(s.menu.index).toBe(1);
    const r = reduceKey(s, k({ name: "tab" }), services);
    expect(r.effect.type).toBe("none");
    expect(r.state.buffer).toBe(":connect gmail");
    expect(r.state.menu.open).toBe(false);
  });

  it("no menu for a chat message", () => {
    const s = type(EMPTY_STATE, "send an email");
    expect(s.menu.open).toBe(false);
  });
});

describe("reduceKey — bracketed paste", () => {
  it("inserts pasted text literally and flattens newlines to spaces", () => {
    let s = reduceKey(EMPTY_STATE, k({ sequence: "\x1b[200~" }), services).state;
    expect(s.pasting).toBe(true);
    // A pasted newline must not submit — it becomes a space.
    s = reduceKey(s, k({ name: "return", str: "\r", sequence: "\r" }), services).state;
    s = reduceKey(s, k({ str: "line", name: "line" }), services).state;
    s = reduceKey(s, k({ sequence: "\x1b[201~" }), services).state;
    expect(s.pasting).toBe(false);
    expect(s.buffer).toBe(" line");
  });

  it("a paste's leading ESC does not close the menu", () => {
    let s = type(EMPTY_STATE, ":co");
    expect(s.menu.open).toBe(true);
    s = reduceKey(s, k({ sequence: "\x1b[200~" }), services).state;
    s = reduceKey(s, k({ sequence: "\x1b[201~" }), services).state;
    expect(s.menu.open).toBe(true);
  });

  it("a lone Esc breaks out of a stuck paste (no PASTE_END arrives)", () => {
    let s = reduceKey(EMPTY_STATE, k({ sequence: "\x1b[200~" }), services).state;
    expect(s.pasting).toBe(true);
    s = reduceKey(s, k({ name: "escape" }), services).state;
    expect(s.pasting).toBe(false);
    // Enter now submits again rather than flattening to a space.
    expect(reduceKey(type(s, "hi"), k({ name: "return" }), services).effect.type).toBe("submit");
  });

  it("Ctrl-C breaks out of a stuck paste and still raises sigint", () => {
    const paste = reduceKey(EMPTY_STATE, k({ sequence: "\x1b[200~" }), services).state;
    const r = reduceKey(paste, k({ name: "c", ctrl: true }), services);
    expect(r.state.pasting).toBe(false);
    expect(r.effect).toEqual({ type: "sigint" });
  });
});

describe("inputLayout", () => {
  it("one row when the prompt + buffer fit", () => {
    // prompt "> " = 2 cols, buffer "abc" = 3, cursor at end → col 5, row 0.
    expect(inputLayout(2, "abc", 3, 80)).toEqual({ rows: 1, cursorRow: 0, cursorCol: 5 });
  });

  it("wraps onto a second row past the column count", () => {
    // 2 + 10 = 12 cols across a 10-col terminal → 2 rows; cursor at abs 12 → row 1 col 2.
    const l = inputLayout(2, "0123456789", 10, 10);
    expect(l.rows).toBe(2);
    expect(l.cursorRow).toBe(1);
    expect(l.cursorCol).toBe(2);
  });

  it("places the cursor mid-buffer", () => {
    // cursor after 3 chars → abs 5, row 0 col 5; buffer still 3 rows? no, one row.
    expect(inputLayout(2, "abcdef", 3, 80)).toMatchObject({ cursorRow: 0, cursorCol: 5 });
  });

  it("falls back to 80 columns on a zero/absent width", () => {
    expect(inputLayout(2, "abc", 3, 0).rows).toBe(1);
  });
});

describe("reduceKey — confirmation chooser (arrow-key nav)", () => {
  const CHOICES = [
    { label: "1. Deny", role: "denied" as const, token: "1", keyword: "Deny" },
    { label: "2. Tell me more", role: "muted" as const, token: "2", keyword: "Tell me more" },
    { label: "3. For this task", role: "granted" as const, token: "3", keyword: "For" },
    { label: "4. For this session", role: "granted" as const, token: "4", keyword: "For" },
  ];
  const selecting = (index = 0): EditorState => ({
    ...EMPTY_STATE,
    selection: { choices: CHOICES, index },
  });

  it("↓ moves the highlight down and ↑ moves it up", () => {
    const down = reduceKey(selecting(0), k({ name: "down" }), services).state;
    expect(down.selection?.index).toBe(1);
    const up = reduceKey(down, k({ name: "up" }), services).state;
    expect(up.selection?.index).toBe(0);
  });

  it("wraps around at both ends", () => {
    // ↑ from the first choice wraps to the last.
    expect(reduceKey(selecting(0), k({ name: "up" }), services).state.selection?.index).toBe(3);
    // ↓ from the last choice wraps to the first.
    expect(reduceKey(selecting(3), k({ name: "down" }), services).state.selection?.index).toBe(0);
  });

  it("Tab advances the highlight (like ↓)", () => {
    expect(reduceKey(selecting(0), k({ name: "tab" }), services).state.selection?.index).toBe(1);
  });

  it("a digit jumps the highlight to that choice without submitting", () => {
    const r = reduceKey(selecting(0), k({ name: "3", str: "3" }), services);
    expect(r.state.selection?.index).toBe(2);
    expect(r.effect.type).toBe("none");
  });

  it("an out-of-range digit is ignored", () => {
    const r = reduceKey(selecting(1), k({ name: "9", str: "9" }), services);
    expect(r.state.selection?.index).toBe(1);
    expect(r.effect.type).toBe("none");
  });

  it("Enter submits the highlighted choice's token and exits selection mode", () => {
    const r = reduceKey(selecting(2), k({ name: "return" }), services);
    expect(r.effect).toEqual({ type: "submit", line: "3" });
    expect(r.state.selection).toBeNull(); // back to line mode
    expect(r.state.buffer).toBe("");
  });

  it("Deny (index 0) is submittable as the safe default", () => {
    expect(reduceKey(selecting(0), k({ name: "enter" }), services).effect).toEqual({
      type: "submit",
      line: "1",
    });
  });

  it("Ctrl-C cancels (sigint); text keys and Esc are no-ops (no typing into a choice)", () => {
    expect(reduceKey(selecting(1), k({ name: "c", ctrl: true }), services).effect).toEqual({
      type: "sigint",
    });
    // A printable key does not edit — selection has no buffer.
    const typed = reduceKey(selecting(1), k({ name: "x", str: "x" }), services);
    expect(typed.state.buffer).toBe("");
    expect(typed.state.selection?.index).toBe(1);
    expect(typed.effect.type).toBe("none");
    // Esc is inert in selection mode (cancel is Ctrl-C).
    expect(reduceKey(selecting(1), k({ name: "escape" }), services).effect.type).toBe("none");
  });

  it("Ctrl-D closes on EOF", () => {
    expect(reduceKey(selecting(0), k({ name: "d", ctrl: true }), services).effect.type).toBe("close");
  });
});
