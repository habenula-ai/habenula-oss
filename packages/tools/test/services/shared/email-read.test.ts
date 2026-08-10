import { describe, it, expect } from "vitest";
import {
  EMAIL_READ_BODY_MAX_CHARS,
  truncateEmailBody,
} from "../../../src/services/shared/email-read";

/**
 * The shared read-body truncation contract (extracted from the Gmail client
 * so every mail service's read tool bounds its body identically). Gmail's own
 * end-to-end coverage lives in gmail-read.test.ts via the retained
 * GMAIL_READ_BODY_MAX_CHARS re-export.
 */
describe("truncateEmailBody", () => {
  it("passes a body under the ceiling through untouched", () => {
    expect(truncateEmailBody("")).toBe("");
    expect(truncateEmailBody("short body")).toBe("short body");
  });

  it("passes a body exactly at the ceiling through unmarked", () => {
    const atCeiling = "y".repeat(EMAIL_READ_BODY_MAX_CHARS);
    expect(truncateEmailBody(atCeiling)).toBe(atCeiling);
  });

  it("caps an oversized body at the ceiling with an explicit truncation marker", () => {
    const oversized = "x".repeat(EMAIL_READ_BODY_MAX_CHARS + 500);

    const result = truncateEmailBody(oversized);

    expect(result).toContain(
      `[... body truncated: 500 of ${String(oversized.length)} characters omitted]`,
    );
    expect(result.length).toBeLessThan(EMAIL_READ_BODY_MAX_CHARS + 100);
    expect(result.startsWith("x".repeat(EMAIL_READ_BODY_MAX_CHARS))).toBe(true);
  });

  it("never leaves a lone surrogate at the truncation boundary", () => {
    // An astral character (two UTF-16 code units) straddling the ceiling
    // must be dropped whole, not cut into a lone high surrogate.
    const straddling =
      "x".repeat(EMAIL_READ_BODY_MAX_CHARS - 1) + "😀" + "y".repeat(100);

    const result = truncateEmailBody(straddling);

    const kept = result.slice(0, result.indexOf("\n[..."));
    expect(kept).toBe("x".repeat(EMAIL_READ_BODY_MAX_CHARS - 1));
    // The omitted count reflects the actual cut (emoji's 2 units + tail).
    expect(result).toContain(
      `[... body truncated: 102 of ${String(straddling.length)} characters omitted]`,
    );
  });
});
