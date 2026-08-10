import { describe, it, expect } from "vitest";
import { renderAuditPage } from "../../src/render/audit";
import { sgrFor } from "../../src/render/color";
import type { AuditChainEntry } from "../../src/api-client";

/**
 * The `habenula log` page render. Pure: rows in, width-bounded colored lines
 * out. Tested at depth "none" for content (no SGR to strip), plus colored
 * cases where the hue is the assertion — a lifecycle row must not be painted
 * as a governance verdict, and a glyph alone is what carries that under
 * NO_COLOR.
 */

const NOW = new Date("2026-07-01T09:10:00.000Z");

/** A governed, allowed tool call. */
const GOVERNED: AuditChainEntry = {
  epochId: "2026-07-01",
  sequenceNum: 3,
  prevHash: "aa".repeat(32),
  id: "entry-00003",
  timestamp: "2026-07-01T09:05:00.000Z",
  userId: "user-1",
  agentId: "agent-mail",
  sessionId: "session-1",
  origin: "human",
  service: "gmail",
  verb: "read",
  noun: "messages",
  toolName: "gmail_list_messages",
  parametersMetadata: '{"maxResults":{"type":"number"}}',
  decision: "allow",
  outcome: "success",
  errorMessage: null,
  decisionEntryId: null,
  latencyMs: 42,
  costUsd: null,
  hash: "bb".repeat(32),
  epochPrevHash: null,
};

/** `writeSessionEnd`'s row: deny/timeout are FIXED PLACEHOLDERS, and the real
 * reason lives in errorMessage. */
const SESSION_END: AuditChainEntry = {
  ...GOVERNED,
  id: "entry-00004",
  sequenceNum: 4,
  service: "session",
  verb: "end",
  noun: "-",
  toolName: "session.end",
  parametersMetadata: "{}",
  decision: "deny",
  outcome: "timeout",
  errorMessage: "quit",
  latencyMs: 0,
};

/** `createSessionInTxn`'s row: allow/success, no disposition. */
const SESSION_START: AuditChainEntry = {
  ...SESSION_END,
  id: "entry-00002",
  sequenceNum: 2,
  verb: "start",
  toolName: "session.start",
  decision: "allow",
  outcome: "success",
  errorMessage: null,
};

/** `writeTaskCancelAudit`'s row: the disposition is a descriptive sentence,
 * not a failure. */
const TASK_CANCEL: AuditChainEntry = {
  ...SESSION_END,
  id: "entry-00005",
  sequenceNum: 5,
  service: "task",
  verb: "cancel",
  noun: "task-7f2c",
  toolName: "task.cancel",
  decision: "allow",
  outcome: "success",
  errorMessage: "Task cancelled by the user (habenula task cancel)",
};

function page(
  entries: AuditChainEntry[],
  over: { depth?: "none" | "16"; width?: number; nextCursor?: string | null } = {},
): string[] {
  return renderAuditPage(entries, over.nextCursor ?? null, {
    now: NOW,
    depth: over.depth ?? "none",
    width: over.width ?? 100,
  });
}

/** The outcome entry closing GOVERNED — together they are the healthy
 * two-entry pair, which must render byte-identically to a build without the
 * closure check. */
const GOVERNED_CLOSER: AuditChainEntry = {
  ...GOVERNED,
  id: "entry-00006",
  sequenceNum: 6,
  decisionEntryId: "entry-00003",
};

describe("renderAuditPage", () => {
  it("says the log is empty rather than rendering a bare header", () => {
    expect(page([])).toEqual([
      "Audit log is empty. Governed actions are recorded here as they run.",
    ]);
  });

  it("renders a healthy pair byte-identically — no marker on a clean decision or its closer", () => {
    const rows = page([GOVERNED_CLOSER, GOVERNED]); // newest first
    expect(rows[0]).toBe("Audit log — newest first:");
    expect(rows[1]).toBe('  ✓ allow · success  gmail · read · "messages" 5m ago');
    expect(rows[2]).toBe('    id entry-00006 · tool "gmail_list_messages"');
    expect(rows[3]).toBe('    params "{\\"maxResults\\":{\\"type\\":\\"number\\"}}"');
    expect(rows[4]).toBe('  ✓ allow · success  gmail · read · "messages" 5m ago');
    expect(rows[5]).toBe('    id entry-00003 · tool "gmail_list_messages"');
    expect(rows[6]).toBe('    params "{\\"maxResults\\":{\\"type\\":\\"number\\"}}"');
    expect(rows).toHaveLength(7);
  });

  it("renders a failed governed call with the error line under a red label", () => {
    const rows = page([{ ...GOVERNED, outcome: "error", errorMessage: "upstream 503" }], {
      depth: "16",
    });
    expect(rows[1]).toContain("✗");
    const errorLine = rows.find((r) => r.includes("upstream 503"));
    expect(errorLine).toBeDefined();
    // 91 is the denied role's 16-color code: a real failure keeps the denied
    // hue on its error label.
    expect(errorLine).toContain("[91merror");
  });

  it("does not read a session end as a denied action", () => {
    const rows = page([SESSION_END]);
    // The row would otherwise render "✗ deny · timeout" from the placeholders.
    expect(rows[1]).toBe('  ○ event  session · end · "-" 5m ago');
    expect(rows.join("\n")).not.toContain("deny");
    expect(rows.join("\n")).not.toContain("timeout");
    expect(rows.join("\n")).not.toContain("✗");
  });

  it("labels a lifecycle disposition a reason, not an error", () => {
    expect(page([SESSION_END])).toContain('    reason "quit"');
  });

  it("paints a lifecycle row muted, never the denied hue", () => {
    const rows = page([SESSION_END], { depth: "16" });
    expect(rows[1]).toContain(`[${sgrFor("muted", "16")}m○ event`);
    // Both codes are derived, not spelled: a palette repoint moved `denied` off the
    // code this line used to name, which silently disarmed the guard.
    expect(rows.join("\n")).not.toContain(`[${sgrFor("denied", "16")}m`);
  });

  it("treats session.start as an event too, not an allowed action", () => {
    const rows = page([SESSION_START]);
    expect(rows[1]).toBe('  ○ event  session · start · "-" 5m ago');
    expect(rows.join("\n")).not.toContain("allow");
  });

  it("treats task.cancel as an event, keeping its sentence off the error line", () => {
    const rows = page([TASK_CANCEL]);
    expect(rows[1]).toBe('  ○ event  task · cancel · "task-7f2c" 5m ago');
    expect(rows).toContain('    reason "Task cancelled by the user (habenula task cancel)"');
    expect(rows.join("\n")).not.toContain("error");
  });

  it("keeps verdict and lifecycle rows distinguishable on one page", () => {
    const rows = page([SESSION_END, GOVERNED]).join("\n");
    expect(rows).toContain("○ event");
    expect(rows).toContain("✓ allow · success");
  });

  it("footers the page when older entries remain", () => {
    const rows = page([GOVERNED], { nextCursor: "cursor-1" });
    expect(rows[rows.length - 1]).toContain("older entries not shown");
  });
});

describe("renderAuditPage — the closure markers", () => {
  const SWEPT_CLOSER: AuditChainEntry = {
    ...GOVERNED,
    id: "entry-00007",
    sequenceNum: 7,
    decision: "deny",
    outcome: "timeout",
    errorMessage: "Held call expired with its session",
    decisionEntryId: "entry-00003",
  };

  it("marks a conflicted decision and lists its complete closers line with the agreement label", () => {
    const rows = page([SWEPT_CLOSER, GOVERNED_CLOSER, GOVERNED]); // newest first
    const decisionLine = rows.find((r) => r.includes("⚠ conflicted"));
    expect(decisionLine).toBeDefined();
    // The marker is appended beside the stored words, never replacing them.
    expect(decisionLine).toContain("✓ allow · success ⚠ conflicted");
    const closersLine = rows.find((r) => r.includes("closers"));
    expect(closersLine).toBeDefined();
    expect(closersLine).toContain("allow·success id entry-00006");
    expect(closersLine).toContain("deny·timeout id entry-00007");
    expect(closersLine).toContain("(contradictory)");
    // No per-closer unchecked case exists: page one's upper edge is the tip,
    // so a rendered decision has every closer of it on the page.
    expect(rows.join("\n")).not.toContain("unchecked");
  });

  it("marks the conflict in the denied hue", () => {
    const rows = page([SWEPT_CLOSER, GOVERNED_CLOSER, GOVERNED], { depth: "16" });
    const decisionLine = rows.find((r) => r.includes("conflicted"));
    expect(decisionLine).toContain("[91m⚠ conflicted");
  });

  it("reads a dispatched decision with no closer as unresolved — the real gap", () => {
    const rows = page([GOVERNED]);
    expect(rows[1]).toBe('  ✓ allow · success ⚠ unresolved  gmail · read · "messages" 5m ago');
  });

  it("reads an open prompt as awaiting — the ordinary state, not a warning word", () => {
    const pending: AuditChainEntry = { ...GOVERNED, decision: "pending" };
    const rows = page([pending]);
    expect(rows[1]).toBe('  ● pending · success … awaiting  gmail · read · "messages" 5m ago');
  });

  it("puts no marker on a pending that does carry a closer — awaiting is not a restatement of pending", () => {
    const pending: AuditChainEntry = { ...GOVERNED, decision: "pending" };
    const closer: AuditChainEntry = {
      ...GOVERNED,
      id: "entry-00008",
      sequenceNum: 8,
      decision: "deny",
      outcome: "error",
      errorMessage: "Denied by user",
      decisionEntryId: "entry-00003",
    };
    const rows = page([closer, pending]);
    expect(rows.join("\n")).not.toContain("awaiting");
    expect(rows.join("\n")).not.toContain("conflicted");
  });

  it("shows nothing for a decision below the page edge, and the footer names that limit", () => {
    // The page holds only the closer; its decision is older than the page.
    // There is no tuple line to hang a marker on — asserted as invisible —
    // and the footer clause is where the limit is said.
    const rows = page([GOVERNED_CLOSER], { nextCursor: "cursor-1" });
    const entryLines = rows.slice(0, -1).join("\n"); // all but the footer
    expect(entryLines).not.toContain("conflicted");
    expect(entryLines).not.toContain("unresolved");
    expect(entryLines).not.toContain("awaiting");
    expect(rows[rows.length - 1]).toContain("older entries not shown");
    expect(rows[rows.length - 1]).toContain("conflicted or unresolved");
    expect(rows[rows.length - 1]).toContain("habenula log verify");
  });

  it("keeps the footer clause off a log that fits on one page", () => {
    const rows = page([GOVERNED_CLOSER, GOVERNED], { nextCursor: null });
    expect(rows.join("\n")).not.toContain("conflicted or unresolved");
  });
});
