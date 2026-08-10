import { describe, it, expect } from "vitest";
import { shouldShowBanner, renderBanner } from "../../src/render/banner";

/** Boot banner gating + width degradation. */

describe("shouldShowBanner", () => {
  it("shows on a TTY with no suppression env", () => {
    expect(shouldShowBanner({}, true)).toBe(true);
  });

  it("is suppressed on a non-TTY", () => {
    expect(shouldShowBanner({}, false)).toBe(false);
  });

  it("is suppressed when HABENULA_NO_BANNER is set", () => {
    expect(shouldShowBanner({ HABENULA_NO_BANNER: "1" }, true)).toBe(false);
  });
});

describe("renderBanner", () => {
  it("renders the block wordmark plus a rule beneath it when it fits", () => {
    const lines = renderBanner("none", 100);
    // Five glyph rows + one rule row.
    expect(lines).toHaveLength(6);
    // The last row is the rule: only box-drawing horizontals.
    expect(/^─+$/.test(lines[lines.length - 1]!)).toBe(true);
    // The rule matches the wordmark's width (all rows equal), so it never soft-wraps.
    expect(lines[lines.length - 1]!.length).toBe(lines[0]!.length);
  });

  it("degrades to a one-line wordmark when the terminal is too narrow", () => {
    const lines = renderBanner("none", 10);
    expect(lines).toEqual(["HABENULA"]);
  });

  it("emits no SGR at depth none", () => {
    expect(renderBanner("none", 100).every((l) => !l.includes("\x1b"))).toBe(true);
  });

  it("colors the wordmark in the seafoam brand accent at a color depth", () => {
    const [line] = renderBanner("truecolor", 10);
    expect(line).toContain("\x1b[38;2;78;187;157m"); // accent #4EBB9D
  });
});
