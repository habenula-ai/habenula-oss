import { describe, it, expect } from "vitest";
import { wrappedRowCount } from "../../src/commands/chat";

/**
 * The wrapped-row-count math behind `eraseInputLine`. This is
 * the one input-erase behavior previously verified only by dogfooding — the risk
 * being that the prompt's zero-width typed-input SGR gets counted
 * as visible columns and over-counts the rows to walk up and clear.
 */
describe("wrappedRowCount", () => {
  const INPUT_SGR = "\x1b[38;2;251;247;242m";

  it("counts one row when the prompt + buffer fit", () => {
    expect(wrappedRowCount("> ", "hi", 80)).toBe(1);
  });

  it("ignores a zero-width SGR in the prompt — same count as the plain prompt", () => {
    const buffer = "x".repeat(100);
    expect(wrappedRowCount(`> ${INPUT_SGR}`, buffer, 40)).toBe(wrappedRowCount("> ", buffer, 40));
  });

  it("counts the wrapped rows for a buffer past the terminal width", () => {
    // visible prompt width 2 + 100-char buffer = 102 cols; at 40 cols → 3 rows,
    // and the SGR-bearing prompt yields the same (the SGR is stripped before measuring).
    expect(wrappedRowCount("> ", "x".repeat(100), 40)).toBe(3);
    expect(wrappedRowCount(`> ${INPUT_SGR}`, "x".repeat(100), 40)).toBe(3);
  });

  it("never returns less than 1, even for an empty prompt + buffer", () => {
    expect(wrappedRowCount("", "", 80)).toBe(1);
  });

  it("falls back to 80 columns when cols is 0", () => {
    expect(wrappedRowCount("> ", "x".repeat(100), 0)).toBe(wrappedRowCount("> ", "x".repeat(100), 80));
  });
});
