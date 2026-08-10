import { describe, it, expect } from "vitest";
import {
  renderMenu,
  menuHeight,
  MAX_MENU_ROWS,
  renderSelection,
  type SelectionChoice,
} from "../../src/input/menu";
import type { Completion } from "../../src/input/completion";

/** A list of `n` distinct service completions, `svc0…svc{n-1}`. */
function many(n: number): Completion[] {
  return Array.from({ length: n }, (_, i) => ({ value: `svc${i}`, expectsArg: false }));
}

/**
 * The inline menu renderer — highlight marking, width
 * truncation, and the reverse-video degradation under NO_COLOR. Pure and
 * headless; the cursor choreography that draws these rows lives in the editor
 * (real-PTY smoke check).
 */

const items: Completion[] = [
  { value: ":connect", expectsArg: true },
  { value: ":disconnect", expectsArg: true },
  { value: ":kill", expectsArg: false },
];

describe("renderMenu", () => {
  it("marks the highlighted row with the arrow and indents the rest", () => {
    const rows = renderMenu(items, 1, 40, { color: false });
    expect(rows).toEqual(["  :connect", "→ :disconnect", "  :kill"]);
  });

  it("wraps the highlighted row in reverse video when color is on", () => {
    const rows = renderMenu(items, 0, 40, { color: true });
    expect(rows[0]).toBe("\x1b[7m→ :connect\x1b[0m");
    expect(rows[1]).toBe("  :disconnect"); // unhighlighted rows carry no SGR
  });

  it("emits no SGR bytes under NO_COLOR (color: false), keeping the arrow affordance", () => {
    const rows = renderMenu(items, 0, 40, { color: false });
    expect(rows[0]).toBe("→ :connect");
    expect(rows.join("")).not.toContain("\x1b");
  });

  it("truncates a row wider than the terminal with an ellipsis", () => {
    const long: Completion[] = [{ value: "a_very_long_service_name_indeed", expectsArg: false }];
    const rows = renderMenu(long, 0, 12, { color: false });
    // marker(2) + 9 chars + ellipsis(1) = 12 columns
    expect(rows[0]).toBe("→ a_very_lo…");
    expect(rows[0]!.length).toBeLessThanOrEqual(12);
  });

  it("returns nothing for an empty list", () => {
    expect(renderMenu([], 0, 40, { color: false })).toEqual([]);
  });
});

describe("renderSelection — confirmation chooser (arrow-key nav)", () => {
  const choices: SelectionChoice[] = [
    { label: "1. Deny — don't run this.", role: "denied", token: "1", keyword: "Deny" },
    { label: "2. Tell me more — no decision yet.", role: "habenula", token: "2", keyword: "Tell me more" },
    { label: "3. Allow — for this task.", role: "granted", token: "3", keyword: "Allow" },
  ];

  it("marks the highlighted row with the arrow and indents the rest (depth none)", () => {
    const rows = renderSelection(choices, 1, 60, "none");
    expect(rows).toEqual([
      "  1. Deny — don't run this.",
      "→ 2. Tell me more — no decision yet.",
      "  3. Allow — for this task.",
    ]);
  });

  it("emits no SGR under depth none, keeping the arrow affordance", () => {
    expect(renderSelection(choices, 0, 60, "none").join("")).not.toContain("\x1b");
  });

 it("tints only the outcome keyword, and reverse-video spans the whole highlighted row", () => {
    const rows = renderSelection(choices, 0, 60, "truecolor");
    // Highlighted Deny: reverse opens the row, only "Deny" is coral, and
    // reverse re-opens after the keyword's reset so the tail stays highlighted.
    expect(rows[0]).toBe("\x1b[7m→ 1. \x1b[38;2;244;106;128mDeny\x1b[0m\x1b[7m — don't run this.\x1b[0m");
    // Unhighlighted Tell me more: only the keyword takes the brand text color, no reverse video.
    expect(rows[1]).toBe("  2. \x1b[38;2;251;247;242mTell me more\x1b[0m — no decision yet.");
    expect(rows[1]).not.toContain("\x1b[7m");
    // Unhighlighted Allow: only the keyword is deep seafoam; the granularity text is plain.
    expect(rows[2]).toBe("  3. \x1b[38;2;46;155;127mAllow\x1b[0m — for this task.");
  });

  it("leaves the row uncolored but still highlighted when the keyword is truncated away", () => {
    const narrow: SelectionChoice[] = [
      { label: "2. Tell me more — later", role: "habenula", token: "2", keyword: "Tell me more" },
    ];
    // At width 10 the keyword doesn't survive truncation → no color SGR, but the
    // highlighted row is still reverse-wrapped and legible.
    const rows = renderSelection(narrow, 0, 10, "truecolor");
    expect(rows[0]).not.toContain("\x1b[38;2;251;247;242m");
    expect(rows[0]!.startsWith("\x1b[7m")).toBe(true);
  });

  it("truncates a row wider than the terminal with an ellipsis", () => {
    const long: SelectionChoice[] = [
      { label: "1. an extremely long choice label", role: "denied", token: "1", keyword: "Deny" },
    ];
    const rows = renderSelection(long, 0, 12, "none");
    expect(rows[0]).toBe("→ 1. an ext…");
    expect(rows[0]!.length).toBeLessThanOrEqual(12);
  });

  it("returns nothing for an empty choice list", () => {
    expect(renderSelection([], 0, 40, "none")).toEqual([]);
  });
});

describe("menuHeight", () => {
  it("is one row per item, capped at MAX_MENU_ROWS", () => {
    expect(menuHeight(items)).toBe(3);
    expect(menuHeight([])).toBe(0);
    expect(menuHeight(many(100))).toBe(MAX_MENU_ROWS);
  });
});

describe("renderMenu — windowing (bounded height)", () => {
  it("never emits more than MAX_MENU_ROWS rows for a long list", () => {
    const rows = renderMenu(many(100), 0, 40, { color: false });
    expect(rows).toHaveLength(MAX_MENU_ROWS);
    expect(menuHeight(many(100))).toBe(rows.length); // budget matches output exactly
  });

  it("shows the top window when the highlight is near the start", () => {
    const rows = renderMenu(many(20), 0, 40, { color: false });
    expect(rows[0]).toBe("→ svc0"); // highlighted first item visible
    expect(rows[rows.length - 1]).toBe(`  svc${MAX_MENU_ROWS - 1}`);
  });

  it("scrolls the window to keep a mid-list highlight visible", () => {
    const rows = renderMenu(many(20), 10, 40, { color: false });
    // window start = clamp(10 - 4, 0, 20 - 8) = 6, so rows are svc6..svc13.
    expect(rows[0]).toBe("  svc6");
    expect(rows).toContain("→ svc10"); // the highlighted item is in the window
    expect(rows).toHaveLength(MAX_MENU_ROWS);
  });

  it("clamps the window at the end for a highlight near the last item", () => {
    const rows = renderMenu(many(20), 19, 40, { color: false });
    // window start = clamp(19 - 4, 0, 12) = 12, so rows are svc12..svc19.
    expect(rows[rows.length - 1]).toBe("→ svc19");
    expect(rows[0]).toBe("  svc12");
  });
});
