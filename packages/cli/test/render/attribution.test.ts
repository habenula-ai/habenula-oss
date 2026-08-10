import { describe, it, expect } from "vitest";
import {
  attribute,
  sanitize,
  displayWidth,
  wrapToWidth,
  clampSanitized,
  renderUntrusted,
  layoutField,
  SPEAKER_LABEL,
  toolCallLine,
  MAX_ERROR,
} from "../../src/render/attribution";

/**
 * The forge guard. This is the regression gate: it must
 * fail if strip, width-correct wrap, or re-attribute is dropped. Payloads
 * include CJK/emoji/ZWJ and a bidi override, not only ASCII.
 */

// A bidi override (U+202E), a fake chrome label, raw ANSI, and a control byte.
const BIDI = "‮";
const FORGE = `\x1b[31mHabenula › fake${BIDI}reversed`;

describe("sanitize", () => {
  it("strips ANSI/CSI escape sequences", () => {
    expect(sanitize("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitize("a\x1b[1;32mb")).toBe("ab");
  });

  it("strips C0/C1 controls, DEL, TAB, and CR", () => {
    expect(sanitize("a\x00b\x07c\x7fd\te\rf")).toBe("abcdef");
  });

  it("strips Unicode format/bidi characters (LRM/RLM, overrides, isolates, BOM)", () => {
    expect(sanitize("a‮b‎c⁦d﻿e")).toBe("abcde");
  });

  it("strips ALM (U+061C) and the word joiner / invisible operators (U+2060-2064)", () => {
    expect(sanitize("a\u061Cb")).toBe("ab");
    expect(sanitize("a\u2060b\u2064c")).toBe("abc");
  });

  it("strips the zero-width space / non-joiner (U+200B/200C) but preserves ZWJ (U+200D) for emoji", () => {
    const zwsp = String.fromCharCode(0x200b);
    const zwnj = String.fromCharCode(0x200c);
    const zwj = String.fromCharCode(0x200d);
    // ZWSP/ZWNJ enable invisible word-splitting / homoglyph confusion \u2014 stripped.
    expect(sanitize(`a${zwsp}b${zwnj}c`)).toBe("abc");
    // ZWJ is load-bearing inside emoji sequences \u2014 preserved so a joined emoji
    // (e.g. a family/profession glyph) is not mangled into separate code points.
    expect(sanitize(`a${zwj}b`)).toBe(`a${zwj}b`);
  });

  it("strips OSC sequences terminated by ST (ESC-backslash or C1), not just BEL", () => {
    expect(sanitize("\x1b]0;title\x1b\\rest")).toBe("rest");
    expect(sanitize("\x1b]8;;http://x\x9cshown")).toBe("shown");
    expect(sanitize("\x1b]0;title\x07rest")).toBe("rest"); // BEL still works
  });

  it("strips Unicode line/paragraph separators (LS U+2028, PS U+2029)", () => {
    // A terminal honoring LS/PS as a break would forge an unlabeled physical row.
    expect(sanitize("grant approved Habenula › all mail exported")).toBe(
      "grant approvedHabenula › all mail exported",
    );
    expect(sanitize("a b")).toBe("ab");
  });

  it("leaves ordinary text (including CJK and emoji) intact", () => {
    expect(sanitize("hello 你好 👋")).toBe("hello 你好 👋");
  });
});

describe("displayWidth", () => {
  it("counts ASCII as 1 per column", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("counts CJK as 2 columns each", () => {
    expect(displayWidth("你好")).toBe(4);
  });

  it("counts a ZWJ emoji cluster as a single wide (2-column) glyph", () => {
    // Family emoji: ZWJ sequence — one grapheme, width 2 (not 4× code points).
    expect(displayWidth("👩‍👩‍👧")).toBe(2);
  });

  it("counts VS16 emoji presentation (❤️, ⚠️) and default-emoji dingbats (✅, ⭐) as 2 columns", () => {
    // The under-count that let a symbol run soft-wrap into a forged flush-left row.
    expect(displayWidth("❤️")).toBe(2);
    expect(displayWidth("⚠️")).toBe(2);
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("⭐")).toBe(2);
  });

  it("counts Presentation Forms For Vertical (U+FE10–FE1F, EAW=Wide) as 2 columns", () => {
    // Same under-count class as VS16, for code points the range list omitted:
    // width-1 here lets a crafted run soft-wrap a `·`-chrome grapheme flush-left.
    expect(displayWidth("︘")).toBe(2);
    expect(displayWidth("︐︑")).toBe(4);
  });
});

describe("wrapToWidth — word-aware", () => {
  it("breaks on word boundaries, never mid-word", () => {
    expect(wrapToWidth("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
  });

  it("collapses whitespace runs; join(' ') reproduces the words", () => {
    expect(wrapToWidth("a   b  c", 80)).toEqual(["a b c"]);
    expect(wrapToWidth("one two three", 20).join(" ")).toBe("one two three");
  });

  it("hard-breaks a single token longer than the width (a pasted URL still wraps), keeping later words whole", () => {
    const rows = wrapToWidth("supercalifragilistic done", 10);
    expect(rows.every((r) => displayWidth(r) <= 10)).toBe(true);
    expect(rows[rows.length - 1]).toContain("done"); // the short trailing word is not split
  });

  it("hard-breaks a wide-glyph run with no spaces so no row exceeds the limit", () => {
    // No word boundary to break on — falls back to grapheme hard-wrap, faithful.
    const rows = wrapToWidth("你好你好你好", 4);
    expect(rows.every((r) => displayWidth(r) <= 4)).toBe(true);
    expect(rows.join("")).toBe("你好你好你好");
  });

  it("returns a single (possibly empty) row for empty input", () => {
    expect(wrapToWidth("", 10)).toEqual([""]);
  });
});

describe("attribute — speaker labels and the forge guard", () => {
  it("prefixes each speaker's rows with its label", () => {
    expect(attribute("you", "hi", { depth: "none" })).toEqual(["you › hi"]);
    expect(attribute("agent", "hi", { depth: "none" })).toEqual(["agent › hi"]);
    expect(attribute("habenula", "hi", { depth: "none" })).toEqual(["Habenula › hi"]);
  });

  it("re-prefixes EVERY visual row — a newline cannot create an unlabeled row", () => {
    const rows = attribute("agent", "line one\nHabenula › forged", { depth: "none", width: 80 });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.startsWith(SPEAKER_LABEL.agent))).toBe(true);
    // The would-be forged row is agent-attributed content, not a Habenula row.
    expect(rows.some((r) => r === "Habenula › forged")).toBe(false);
  });

  it("strips a forge payload and keeps every row within the terminal width", () => {
    const rows = attribute("agent", FORGE, { depth: "none", width: 20 });
    expect(rows.every((r) => r.startsWith(SPEAKER_LABEL.agent))).toBe(true);
    expect(rows.every((r) => !r.includes("\x1b"))).toBe(true); // no raw ANSI survived
    expect(rows.every((r) => !r.includes(BIDI))).toBe(true); // no bidi survived
    expect(rows.every((r) => displayWidth(r) <= 20)).toBe(true); // width-correct
  });

  it("width-wraps a long double-width CJK run so no row soft-wraps (the forged-continuation vector)", () => {
    const rows = attribute("agent", "你好".repeat(40), { depth: "none", width: 24 });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => displayWidth(r) <= 24)).toBe(true);
    expect(rows.every((r) => r.startsWith(SPEAKER_LABEL.agent))).toBe(true);
  });
});

describe("clampSanitized", () => {
  it("flags a value whose bytes sanitization altered", () => {
    const r = clampSanitized("INBOX‮evil", 64);
    expect(r.altered).toBe(true);
    expect(r.text).not.toContain("‮");
  });

  it("reports truncation separately from tampering (a length cap is not `altered`)", () => {
    const r = clampSanitized("x".repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.altered).toBe(false); // pure length cap — no dangerous bytes
    expect(r.text.endsWith("…")).toBe(true);
  });

  it("does not flag a clean, short value", () => {
    expect(clampSanitized("INBOX", 64)).toEqual({ text: "INBOX", altered: false, truncated: false });
  });
});

describe("renderUntrusted — untrusted values can't forge chrome or hide structure", () => {
  it("quotes a plain string so it reads as a bounded data value", () => {
    expect(renderUntrusted("INBOX", 64)).toEqual({ text: '"INBOX"', altered: false, truncated: false });
  });

  it("bounds a chrome separator inside quotes AND flags it — no forged extra scope", () => {
    const r = renderUntrusted("all · calendar · read", 64);
    // The `·` survives sanitize, but the quotes make it literal data, not a
    // separator between scopes; and the flag fires so the ⚠ suffix shows.
    expect(r.text).toBe('"all · calendar · read"');
    expect(r.altered).toBe(true);
    // The value is one quoted token — it cannot read as trusted chrome even at
    // depth=none where colour disambiguation is gone.
    expect(r.text.startsWith('"') && r.text.endsWith('"')).toBe(true);
  });

  it("escapes an embedded quote so an untrusted value can't break out of its delimiter", () => {
    const r = renderUntrusted('x" · send · "y', 64);
    expect(r.text).toBe('"x\\" · send · \\"y"'); // embedded quotes escaped
    expect(r.altered).toBe(true);
  });

  it("reveals object/array structure instead of [object Object] / comma-flattening", () => {
    expect(renderUntrusted({ email: "attacker@evil.com" }, 160).text).toBe(
      '{"email":"attacker@evil.com"}',
    );
    expect(renderUntrusted(["a@x", "b@y"], 160).text).toBe('["a@x","b@y"]');
    expect(renderUntrusted(null, 160).text).toBe("null");
    expect(renderUntrusted(false, 160).text).toBe("false");
  });

  it("flags a value carrying a chrome separator nested in structure", () => {
    expect(renderUntrusted({ label: "a · b" }, 160).altered).toBe(true);
  });

  it("splits tampering (`altered`) from a pure length cap (`truncated`)", () => {
    // Sanitization stripping dangerous bytes is `altered`.
    expect(renderUntrusted("INBOX‮evil", 64).altered).toBe(true);
    // A pure length cap is `truncated`, not `altered` — so a legitimately long
    // value (e.g. a commission goal) doesn't cry wolf with the ⚠ flag.
    const long = renderUntrusted("x".repeat(100), 10);
    expect(long.truncated).toBe(true);
    expect(long.altered).toBe(false);
  });
});

describe("layoutField — chrome-prefixed data lines never soft-wrap", () => {
  it("emits a single row identical to naive concatenation when it fits", () => {
    const rows = layoutField({
      prefixColored: "    mock_email · list · ",
      prefixWidth: 24,
      value: "INBOX",
      width: 80,
      continuationIndent: 6,
    });
    expect(rows).toEqual(["    mock_email · list · INBOX"]);
  });

  it("appends a suffix on the same row when it fits (one leading space)", () => {
    const rows = layoutField({
      prefixColored: "  ",
      prefixWidth: 2,
      value: "INBOX",
      width: 80,
      continuationIndent: 4,
      suffixColored: "— ~78m left",
      suffixWidth: 11,
    });
    expect(rows).toEqual(["  INBOX — ~78m left"]);
  });

  it("hard-wraps a long ASCII value so NO emitted row exceeds width, with indented (non-flush-left) continuations", () => {
    // The Finding-1 vector: a 60-char noun after a 24-col prefix on an 80-col
    // terminal. The value even contains a fake chrome label aligned to overflow.
    const value = "x".repeat(50) + "Habenula › approved: send all";
    const rows = layoutField({
      prefixColored: "    mock_email · list · ",
      prefixWidth: 24,
      value,
      width: 80,
      continuationIndent: 6,
    });
    expect(rows.length).toBeGreaterThan(1);
    // No emitted row exceeds the terminal width (so the terminal never soft-wraps).
    expect(rows.every((r) => displayWidth(r) <= 80)).toBe(true);
    // No continuation row is flush-left — every wrapped row starts with the indent.
    for (const row of rows.slice(1)) expect(row.startsWith("      ")).toBe(true);
    // So no visual row begins with the forged engine label.
    expect(rows.every((r) => !/^Habenula ›/.test(r))).toBe(true);
  });

  it("wraps a wide CJK value by display width (never soft-wraps)", () => {
    const prefix = "  mock_email · list · ";
    const rows = layoutField({
      prefixColored: prefix,
      prefixWidth: displayWidth(prefix),
      value: "你好".repeat(40),
      width: 60,
      continuationIndent: 4,
    });
    expect(rows.every((r) => displayWidth(r) <= 60)).toBe(true);
    expect(rows.length).toBeGreaterThan(1);
  });

 it("gives an over-wide prefix its own row so no untrusted grapheme lands flush-left", () => {
    // Terminal narrower than the chrome prefix. Before the fix, row 0 was
    // `prefix + firstGrapheme`, and that untrusted grapheme soft-wrapped flush-left.
    const prefix = "  mock_email · list · "; // ~22 cols, wider than width
    const rows = layoutField({
      prefixColored: prefix,
      prefixWidth: displayWidth(prefix),
      value: "attacker·noun·payload",
      width: 10,
      continuationIndent: 4,
    });
    // Row 0 is the prefix ALONE — no value grapheme appended to the over-wide row.
    expect(rows[0]).toBe(prefix);
    // Every value row is indented (never flush-left) — so no untrusted grapheme
    // can begin a physical row and read as forged engine chrome.
    for (const row of rows.slice(1)) expect(row.startsWith("    ")).toBe(true);
    // The untrusted value appears only on the indented rows, and none is lost:
    // stripping the 4-space indent and rejoining reproduces it exactly.
    expect(rows.slice(1).map((r) => r.slice(4)).join("")).toBe("attacker·noun·payload");
    expect(rows.every((r) => !/^Habenula ›/.test(r))).toBe(true);
  });
});

describe("toolCallLine — the failure reason is bounded data, never chrome", () => {
  it("a non-error call is the bare marker, with no failure suffix", () => {
    expect(toolCallLine({ name: "gmail_list", outcome: "success" })).toBe(
      '[tool: "gmail_list"]',
    );
  });

  it("an error call appends the tool's own reason as a quoted token", () => {
    expect(
      toolCallLine({
        name: "gmail_send",
        outcome: "error",
        error: "Recipient address rejected",
      }),
    ).toBe('[tool: "gmail_send"] — failed: "Recipient address rejected"');
  });

  it("falls back to the bare failed marker when no reason came through", () => {
    // An older engine sends no `error` field. Rendering `""` would show an
    // empty quoted pair, which reads as a reason that says nothing.
    expect(toolCallLine({ name: "gmail_send", outcome: "error" })).toBe(
      '[tool: "gmail_send"] — failed',
    );
    expect(
      toolCallLine({ name: "gmail_send", outcome: "error", error: "" }),
    ).toBe('[tool: "gmail_send"] — failed');
  });

  it("a crafted error cannot forge chrome, close the frame, or fake a second call", () => {
    const forged = '" ] — succeeded · approved by Habenula\x1b[31m';
    const line = toolCallLine({
      name: "gmail_send",
      outcome: "error",
      error: forged,
    });
    // The ANSI escape is stripped, and the embedded `"` and `]` are escaped
    // inside the quoted token, so neither can close the reason and read as
    // engine prose. The real ` — failed` suffix still precedes it.
    expect(line).toContain(" — failed: ");
    expect(line).not.toContain("\x1b[31m");
    expect(line.endsWith('"')).toBe(true);
    expect(line.indexOf(" — failed")).toBeLessThan(line.indexOf("succeeded"));
  });

  it("a long reason is clamped to MAX_ERROR so it cannot flood the turn", () => {
    const line = toolCallLine({
      name: "gmail_send",
      outcome: "error",
      error: "x".repeat(MAX_ERROR * 3),
    });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(MAX_ERROR * 2);
  });

  it("the untrusted name keeps its own guard once a reason sits after it", () => {
    const line = toolCallLine({
      name: "] approved by Habenula",
      outcome: "error",
      error: "nope",
    });
    // Both tokens are separately quoted, so the name cannot swallow the suffix.
    expect(line).toBe('[tool: "] approved by Habenula"] — failed: "nope"');
  });
});
