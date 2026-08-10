import { describe, it, expect } from "vitest";
import {
  pickColorDepth,
  colorize,
  sgrFor,
  inputSgr,
  type ColorDepth,
  type ColorRole,
} from "../../src/render/color";

/**
 * Color depth detection + palette realization across depths.
 * The load-bearing signal is the state word/glyph, not the hue — so the
 * degradation tests live where that text is rendered (prompt/status). Here we
 * pin the depth picker and the role → SGR mapping at each depth.
 */

describe("pickColorDepth", () => {
  it("forces none on a non-TTY, regardless of COLORTERM", () => {
    expect(pickColorDepth({ COLORTERM: "truecolor" }, false)).toBe("none");
  });

  it("forces none when NO_COLOR is present and non-empty, even on a truecolor TTY", () => {
    expect(pickColorDepth({ COLORTERM: "truecolor", NO_COLOR: "1" }, true)).toBe("none");
    expect(pickColorDepth({ COLORTERM: "truecolor", NO_COLOR: "0" }, true)).toBe("none");
  });

  it("does NOT suppress color when NO_COLOR is the empty string (no-color.org)", () => {
    // `NO_COLOR=""` is a common way to neutralize an inherited var — not 'set'.
    expect(pickColorDepth({ COLORTERM: "truecolor", NO_COLOR: "" }, true)).toBe("truecolor");
    expect(pickColorDepth({ TERM: "xterm-256color", NO_COLOR: "" }, true)).toBe("256");
  });

  it("picks truecolor / 256 / 16 by COLORTERM then TERM", () => {
    expect(pickColorDepth({ COLORTERM: "truecolor" }, true)).toBe("truecolor");
    expect(pickColorDepth({ COLORTERM: "24bit" }, true)).toBe("truecolor");
    expect(pickColorDepth({ TERM: "xterm-256color" }, true)).toBe("256");
    expect(pickColorDepth({ TERM: "xterm" }, true)).toBe("16");
    expect(pickColorDepth({}, true)).toBe("16");
  });
});

/** Every role that carries a color. One list, so no two sweeps can disagree. */
const COLORED_ROLES: Exclude<ColorRole, "human">[] = [
  "habenula",
  "banner",
  "agent",
  "granted",
  "pending",
  "denied",
  "incoming",
  "muted",
];

describe("sgrFor — role → SGR across depths", () => {
  const depths: ColorDepth[] = ["truecolor", "256", "16"];

  it("emits a code for every colored role at every non-none depth", () => {
    for (const depth of depths) {
      for (const role of COLORED_ROLES) {
        expect(sgrFor(role, depth), `${role}@${depth}`).not.toBeNull();
      }
    }
  });

  it("human and none never emit a code", () => {
    expect(sgrFor("human", "truecolor")).toBeNull();
    expect(sgrFor("agent", "none")).toBeNull();
  });

  it("agent and pending stay distinct at every depth, including the 16-color floor", () => {
    // The brand palette separates the agent voice (vermilion) from the pending
    // state (peach) all the way down: the palette this replaced collapsed both
    // onto yellow.
    expect(sgrFor("agent", "truecolor")).not.toBe(sgrFor("pending", "truecolor"));
    expect(sgrFor("agent", "256")).not.toBe(sgrFor("pending", "256"));
    expect(sgrFor("agent", "16")).toBe("31"); //   vermilion → red
    expect(sgrFor("pending", "16")).toBe("33"); // peach     → yellow
    expect(sgrFor("denied", "16")).toBe("91"); //  coral     → bright red
  });

  it("gives every colored role a distinct code at every depth", () => {
    // 256 matters as much as the floor: it is the one depth whose codes come from
    // lossy 6×6×6 cube quantization, so two distinct hues can land on one code
    // there while truecolor and 16 both stay distinct.
    for (const depth of depths) {
      const codes = COLORED_ROLES.map((role) => sgrFor(role, depth));
      expect(new Set(codes).size, depth).toBe(COLORED_ROLES.length);
    }
  });

  it("uses the 24-bit form at truecolor and the 256-cube form at 256", () => {
    expect(sgrFor("banner", "truecolor")).toBe("38;2;78;187;157"); // seafoam accent #4EBB9D
    expect(sgrFor("banner", "256")).toMatch(/^38;5;\d+$/);
  });

  it("takes its hues from the brand palette", () => {
    expect(sgrFor("habenula", "truecolor")).toBe("38;2;251;247;242"); // text #FBF7F2
    expect(sgrFor("habenula", "16")).toBe("97"); //                      bright white
    expect(sgrFor("agent", "truecolor")).toBe("38;2;231;84;32"); //       accent-red #E75420
    expect(sgrFor("granted", "truecolor")).toBe("38;2;46;155;127"); //    accent-dim #2E9B7F
    expect(sgrFor("pending", "truecolor")).toBe("38;2;239;147;118"); //   danger-text #EF9376
    expect(sgrFor("denied", "truecolor")).toBe("38;2;244;106;128"); //    primary #F46A80
    expect(sgrFor("muted", "truecolor")).toBe("38;2;168;154;161"); //     text-muted #A89AA1
    // The one role with no brand token. Every brand hue already means a voice or a
    // state, so external-agent provenance must not be folded onto one of them.
    expect(sgrFor("incoming", "truecolor")).toBe("38;2;175;135;255"); //   off-palette purple
    expect(sgrFor("incoming", "16")).toBe("35"); //                        magenta
  });

  it("keeps the banner's seafoam and a granted outcome's deeper half apart", () => {
    // The two greens are the two halves of the accent, and an affirmative must
    // not read as the boot screen: distinct at truecolor, and at the floor too.
    expect(sgrFor("banner", "truecolor")).not.toBe(sgrFor("granted", "truecolor"));
    expect(sgrFor("banner", "16")).not.toBe(sgrFor("granted", "16"));
    // Which role holds which floor code is load-bearing, not incidental: green is
    // the conventional affirmative there, so the banner yields it and takes cyan.
    expect(sgrFor("banner", "16")).toBe("36"); //  accent #4EBB9D     → cyan
    expect(sgrFor("granted", "16")).toBe("32"); // accent-dim #2E9B7F → green
  });

  it("dresses Habenula's chrome and the boot banner in different brand tokens", () => {
    // Every Habenula surface but the banner takes the brand text color, the same
    // token typed input renders in.
    expect(sgrFor("banner", "truecolor")).not.toBe(sgrFor("habenula", "truecolor"));
    expect(colorize("x", "habenula", "truecolor")).toBe(`${inputSgr("truecolor")}x\x1b[0m`);
  });
});

describe("inputSgr — the trailing brand-text opener for typed input", () => {
  it("emits a bare brand-text foreground opener (no reset) at each color depth", () => {
    expect(inputSgr("truecolor")).toBe("\x1b[38;2;251;247;242m"); // text #FBF7F2
    expect(inputSgr("256")).toBe("\x1b[38;5;231m");
    expect(inputSgr("16")).toBe("\x1b[97m");
  });

  it("is exactly the habenula role's color at every depth, not a second copy of it", () => {
    // Typed input and Habenula's chrome are one token by design. Assert it at all
    // three depths, so the two cannot drift at 256 or at the floor.
    for (const depth of ["truecolor", "256", "16"] as const) {
      expect(inputSgr(depth), depth).toBe(`\x1b[${sgrFor("habenula", depth)}m`);
    }
  });

  it("is empty at depth none, so a piped / NO_COLOR prompt carries no escape bytes", () => {
    expect(inputSgr("none")).toBe("");
  });
});

describe("colorize", () => {
  it("emits zero SGR bytes at depth none", () => {
    expect(colorize("hello", "agent", "none")).toBe("hello");
    expect(colorize("hello", "agent", "none")).not.toContain("\x1b");
  });

  it("wraps text in the role SGR and a reset at a color depth", () => {
    const out = colorize("hi", "banner", "truecolor");
    expect(out).toBe("\x1b[38;2;78;187;157mhi\x1b[0m");
  });

  it("is a no-op for empty text (no stray reset)", () => {
    expect(colorize("", "agent", "truecolor")).toBe("");
  });
});
