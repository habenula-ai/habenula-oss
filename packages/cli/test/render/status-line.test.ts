import { describe, it, expect } from "vitest";
import { formatStatusLine } from "../../src/render/status-line";
import type { ActiveSessionView } from "../../src/api-client";

/**
 * The live status line. Pure: a session snapshot + the
 * connected set in, one width-bounded colored row out. Tested at depth "none"
 * for content (no SGR to strip) plus one colored-depth case for the muted wrap.
 */

const NOW = new Date("2026-07-03T12:00:00.000Z");

/** A session started 12m ago, expiring 78m from NOW. */
const SESSION: ActiveSessionView = {
  sessionId: "s1",
  startedAt: "2026-07-03T11:48:00.000Z",
  expiry: "2026-07-03T13:18:00.000Z",
};

function line(over: Partial<Parameters<typeof formatStatusLine>[0]> = {}): string {
  return formatStatusLine({
    session: SESSION,
    connected: ["gmail", "slack"],
    now: NOW,
    depth: "none",
    width: 80,
    ...over,
  });
}

describe("formatStatusLine", () => {
  it("shows a filled dot, live, time remaining, and the connected services", () => {
    expect(line()).toBe("● live · ~78m left · gmail, slack");
  });

  it("uses a hollow dot and 'no active session' when there is no session", () => {
    expect(line({ session: null })).toBe("○ no active session · gmail, slack");
  });

  it("says 'no services connected' when the connected set is empty", () => {
    expect(line({ connected: [] })).toBe("● live · ~78m left · no services connected");
  });

  it("omits '~Nm left' when the session has no expiry", () => {
    expect(line({ session: { ...SESSION, expiry: null } })).toBe("● live · gmail, slack");
  });

  it("clamps time-remaining at zero rather than going negative past expiry", () => {
    const past = new Date("2026-07-03T14:00:00.000Z"); // 42m after expiry
    expect(line({ now: past })).toBe("● live · ~0m left · gmail, slack");
  });

  it("truncates to the width with an ellipsis and never exceeds it", () => {
    const out = line({ connected: ["gmail", "slack", "github", "calendar", "drive"], width: 24 });
    // 24 columns max, ellipsis marks the cut.
    expect([...out].length).toBeLessThanOrEqual(24);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("● live")).toBe(true);
  });

  it("wraps the whole line in the muted SGR at a color depth", () => {
    const out = line({ depth: "16" });
    expect(out.startsWith("\x1b[")).toBe(true); // opening SGR
    expect(out.endsWith("\x1b[0m")).toBe(true); // reset
    expect(out).toContain("● live · ~78m left · gmail, slack");
  });
});
