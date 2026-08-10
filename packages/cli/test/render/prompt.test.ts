import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderPrompt,
  parseChoice,
  choiceLines,
  confirmChoices,
  type PromptContext,
} from "../../src/render/prompt";
import { ApiError, type ApiClient, type ResolveChoice } from "../../src/api-client";
import type { HeldCallRecord } from "@habenula-ai/contracts";
import type { ColorDepth } from "../../src/render/color";

/**
 * The reactive confirmation prompt. renderPrompt is driven
 * directly with a scripted readline, a stubbed client (resolve/getStatus), and
 * a captured write sink — no terminal, no wire.
 */

const RECORD: HeldCallRecord = {
  heldCallId: "held-1",
  service: "mock_email",
  verb: "list",
  noun: "INBOX",
  params: { label: "INBOX" },
};

const SESSION = {
  sessionId: "s1",
  startedAt: "2026-07-03T11:48:00.000Z",
  expiry: "2026-07-03T13:18:00.000Z",
};

const NOW = new Date("2026-07-03T12:00:00.000Z");

function resumed(response: string, held?: { heldCallId: string }) {
  return {
    status: "resumed" as const,
    result: {
      response,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      iterations: 1,
      ...(held ? { held } : {}),
    },
  };
}

/** A scripted choice reader: serves queued answers, then throws (no more). */
function scriptedChoice(answers: string[]): (prompt: string) => Promise<string> {
  const queue = [...answers];
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("no more scripted answers");
    return next;
  };
}

/** A captured call to the arrow-key chooser. */
interface SelectionCall {
  prompt: string;
  choices: readonly { label: string; role: string; token: string; keyword: string }[];
  defaultIndex: number;
}

/**
 * A scripted arrow-key chooser: records each call's args into `capture`
 * and serves queued tokens, then throws — the selection analogue of
 * `scriptedChoice`, standing in for the TTY editor's `readSelection`.
 */
function scriptedSelection(
  tokens: string[],
  capture: SelectionCall[],
): NonNullable<PromptContext["readSelection"]> {
  const queue = [...tokens];
  return async (prompt, choices, defaultIndex) => {
    capture.push({ prompt, choices, defaultIndex });
    const next = queue.shift();
    if (next === undefined) throw new Error("no more scripted selections");
    return next;
  };
}

interface RunOpts {
  answers: string[];
  resolve: ApiClient["resolve"];
  getStatus?: ApiClient["getStatus"];
  record?: HeldCallRecord;
  depth?: ColorDepth;
  confirmPresence?: PromptContext["confirmPresence"];
}

async function run(opts: RunOpts): Promise<{ lines: string[]; client: ApiClient }> {
  const lines: string[] = [];
  const client = {
    resolve: opts.resolve,
    getStatus: opts.getStatus ?? vi.fn(),
  } as unknown as ApiClient;
  const ctx: PromptContext = {
    client,
    record: opts.record ?? RECORD,
    session: SESSION,
    readChoice: scriptedChoice(opts.answers),
    depth: opts.depth ?? "none",
    now: NOW,
    write: (l) => lines.push(l),
    ...(opts.confirmPresence ? { confirmPresence: opts.confirmPresence } : {}),
  };
  await renderPrompt(ctx);
  return { lines, client };
}

// Pin the terminal width so wrap-boundary assertions are deterministic (the
// renderer reads process.stdout.columns, which varies by the test runner's TTY).
let originalColumns: PropertyDescriptor | undefined;
beforeEach(() => {
  originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
  if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
});

describe("parseChoice", () => {
  it("maps numbers and phrases to the four choices; junk to null", () => {
    expect(parseChoice("1")).toBe("deny");
    expect(parseChoice("2")).toBe("tell_more");
    expect(parseChoice("3")).toBe("task");
    expect(parseChoice("4")).toBe("session");
    expect(parseChoice("For this session")).toBe("session");
    expect(parseChoice("tell me more")).toBe("tell_more");
    expect(parseChoice("")).toBeNull();
    expect(parseChoice("yes")).toBeNull();
  });
});

describe("choiceLines", () => {
  it("annotates the session choice with the remaining lifetime", () => {
    const lines = choiceLines(SESSION, NOW, "none");
    expect(lines[3]).toContain("~78m left");
  });

  it("omits the lifetime when the session/expiry is unknown", () => {
    expect(choiceLines(null, NOW, "none")[3]).not.toContain("left");
  });
});

describe("renderPrompt", () => {
  it.each([
    ["1", "deny"],
    ["3", "task"],
    ["4", "session"],
  ])("choice %s resolves with %s", async (answer, expected) => {
    const resolve = vi.fn(async () => resumed("done"));
    const { client } = await run({ answers: [answer], resolve });
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, expected as ResolveChoice);
  });

  it("tints only the outcome keyword at a color depth (Deny coral, Tell-more brand text, Allow deep seafoam)", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const { lines } = await run({ answers: ["1"], resolve, depth: "truecolor" });
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const choiceRows = lines.filter((l) => /^ {2}[1-4]\. /.test(strip(l)));
    expect(choiceRows).toHaveLength(4);
    // The color SGR wraps the keyword alone — it opens immediately before it.
    expect(choiceRows[0]).toContain("\x1b[38;2;244;106;128mDeny\x1b[0m"); //   1 Deny → coral
    expect(choiceRows[1]).toContain("\x1b[38;2;251;247;242mTell me more\x1b[0m"); // 2 → brand text
    expect(choiceRows[2]).toContain("\x1b[38;2;46;155;127mAllow\x1b[0m"); //   3 Allow → deep seafoam
    expect(choiceRows[3]).toContain("\x1b[38;2;46;155;127mAllow\x1b[0m"); //   4 Allow → deep seafoam
    // The number prefix and the granularity text after the keyword carry no SGR.
    expect(choiceRows[0]!.startsWith("  1. \x1b[38;2;244;106;128mDeny")).toBe(true);
    expect(choiceRows[0]!.split("Deny\x1b[0m")[1]).not.toContain("\x1b[");
  });

  it("choices degrade to plain, legible text under NO_COLOR (meaning is additive)", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const { lines } = await run({ answers: ["1"], resolve, depth: "none" });
    const choiceRows = lines.filter((l) => /^ {2}[1-4]\. /.test(l));
    expect(choiceRows).toHaveLength(4);
    expect(choiceRows.every((l) => !l.includes("\x1b"))).toBe(true);
  });

 it("renders structured params (object/array), never [object Object] or comma-flattening", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record: HeldCallRecord = {
      heldCallId: "held-1",
      service: "mock_email",
      verb: "send",
      noun: "compose",
      params: { to: { name: "Alice", email: "attacker@evil.com" }, cc: ["a@x", "b@y"] },
    };
    const { lines } = await run({ answers: ["1"], resolve, record });
    const out = lines.join("\n");
    expect(out).toContain('"to": {"name":"Alice","email":"attacker@evil.com"}');
    expect(out).toContain('"cc": ["a@x","b@y"]');
    expect(out).not.toContain("[object Object]");
  });

 it("quotes and flags a param value carrying the chrome separator", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record: HeldCallRecord = { ...RECORD, verb: "send", params: { label: "all · calendar · read" } };
    const { lines } = await run({ answers: ["1"], resolve, record });
    const out = lines.join("\n");
    expect(out).toContain('"label": "all · calendar · read"'); // bounded in quotes, not chrome
    expect(out).toContain("⚠ unusual value"); // tamper flag fires (was dropped before)
  });

 it("drops the user-requested maxResults from the readout, keeping other params", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record: HeldCallRecord = { ...RECORD, verb: "list", params: { label: "INBOX", maxResults: 5 } };
    const { lines } = await run({ answers: ["1"], resolve, record });
    const out = lines.join("\n");
    expect(out).toContain("requested with:");
    expect(out).toContain('"label": "INBOX"'); // other params stay visible
    expect(out).not.toContain("maxResults"); // the echoed count is suppressed
  });

 it("omits the 'requested with:' header when maxResults was the only param", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record: HeldCallRecord = { ...RECORD, verb: "list", params: { maxResults: 5 } };
    const { lines } = await run({ answers: ["1"], resolve, record });
    const out = lines.join("\n");
    expect(out).not.toContain("requested with:");
    expect(out).not.toContain("maxResults");
  });

  it("'Tell me more' loops without resolving, then a real choice resolves", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        status: "info",
        metadata: { service: "mock_email", verb: "list", noun: "INBOX", description: "Lists mail." },
      })
      .mockResolvedValueOnce(resumed("done"));
    const { lines, client } = await run({ answers: ["2", "1"], resolve });
    expect(client.resolve).toHaveBeenNthCalledWith(1, RECORD.heldCallId, "tell_more");
    expect(client.resolve).toHaveBeenNthCalledWith(2, RECORD.heldCallId, "deny");
    expect(lines.join("\n")).toContain("Lists mail.");
    // The prompt was drawn twice (once per loop).
    expect(lines.filter((l) => l.includes("awaiting your confirmation")).length).toBe(2);
  });

  it("empty/unrecognized input never resolves and re-prompts", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const { lines, client } = await run({ answers: ["", "huh", "1"], resolve });
    expect(client.resolve).toHaveBeenCalledTimes(1); // only the final "1"
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, "deny");
    expect(lines.join("\n")).toContain("Please choose 1, 2, 3, or 4.");
  });

  it("renders a resumed turn's response in the agent voice", async () => {
    const resolve = vi.fn(async () => resumed("You have 3 messages."));
    const { lines } = await run({ answers: ["4"], resolve });
    expect(lines.join("\n")).toContain("agent › You have 3 messages.");
  });

 it("renders a resumed tool-call name as quoted data, so a crafted name can't forge engine prose", async () => {
    // `call.name` is the model's raw tool-use name, not a registry identifier —
    // a crafted name must not read as chrome on the trusted `habenula` line.
    const resolve = vi.fn(async () => ({
      status: "resumed" as const,
      result: {
        response: "",
        toolCalls: [{ name: "approved — safe to proceed", id: "t1", outcome: "success" as const }],
        usage: { inputTokens: 1, outputTokens: 1 },
        iterations: 1,
      },
    }));
    const { lines } = await run({ answers: ["4"], resolve });
    const joined = lines.join("\n");
    expect(joined).toContain('[tool: "approved — safe to proceed"]'); // quoted, bounded data
    expect(joined).not.toContain("[tool: approved — safe to proceed]"); // never bare chrome
  });

  it("surfaces the post-turn remediation hint after a resumed turn on an unconnected service (regression: postTurnHints was wired into the normal path only)", async () => {
    // The exact shape that bit a tester: user approves a call, the resumed turn
    // then hits a service gate, and the confirmation-resume path used to render
    // the tool line + agent prose but never the ':connect' tip — leaving no
    // next step on the one path where the user just acted.
    const resolve = vi.fn(async () => ({
      status: "resumed" as const,
      result: {
        response: "I couldn't reach that service.",
        toolCalls: [{ name: "gmail_send", id: "t1", outcome: "not_connected" as const }],
        usage: { inputTokens: 1, outputTokens: 1 },
        iterations: 1,
      },
    }));
    const { lines } = await run({ answers: ["4"], resolve });
    expect(lines.join("\n")).toContain(":connect"); // the remediation tip the normal turn already shows
  });

  it("marks a failed resumed tool call and hints, matching the normal turn (suffix + error hint)", async () => {
    const resolve = vi.fn(async () => ({
      status: "resumed" as const,
      result: {
        response: "That didn't work.",
        toolCalls: [{ name: "google_calendar_create", id: "t1", outcome: "error" as const }],
        usage: { inputTokens: 1, outputTokens: 1 },
        iterations: 1,
      },
    }));
    const { lines } = await run({ answers: ["4"], resolve });
    const joined = lines.join("\n");
    expect(joined).toContain('[tool: "google_calendar_create"] — failed'); // failure marker on the trusted line
    expect(joined).toContain("ran and failed"); // the error-outcome remediation hint
  });

  it("shows WHY an approved call then failed, as a bounded token", async () => {
    // The highest-value case for the reason: the user just approved this call,
    // so "it failed" with no cause is the least useful thing to tell them.
    const resolve = vi.fn(async () => ({
      status: "resumed" as const,
      result: {
        response: "That didn't work.",
        toolCalls: [
          {
            name: "google_calendar_create",
            id: "t1",
            outcome: "error" as const,
            error: 'Calendar "team" is read-only',
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        iterations: 1,
      },
    }));
    const { lines } = await run({ answers: ["4"], resolve });
    // At 80 columns the reason wraps, so assert on the rows: the marker and the
    // start of the reason on one, the remainder on the next.
    const toolRows = lines.filter((l) => l.includes("google_calendar_create"));
    expect(toolRows[0]).toContain(
      '[tool: "google_calendar_create"] — failed: "Calendar \\"team\\"',
    );
    // The embedded quotes are escaped, so the reason cannot close its own token
    // and read as engine chrome on this trusted line.
    expect(lines.join("\n")).not.toContain('failed: "Calendar "team"');
    // Every wrapped row is re-attributed — the tail of an untrusted reason can
    // never begin a flush-left row and read as engine prose.
    const start = lines.indexOf(toolRows[0]!);
    expect(lines[start + 1]).toBe('Habenula › read-only"');
  });

  it("does not fire a post-turn hint on a cascading resumed turn — hints are gated to the terminal turn, matching chat.ts", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        status: "resumed" as const,
        result: {
          response: "",
          toolCalls: [{ name: "gmail_send", id: "t1", outcome: "not_connected" as const }],
          usage: { inputTokens: 1, outputTokens: 1 },
          iterations: 1,
          held: { heldCallId: "held-2" },
        },
      })
      .mockResolvedValueOnce(resumed("done"));
    const getStatus = vi.fn(async () => ({
      session: SESSION,
      grants: [],
      held: [{ heldCallId: "held-2", service: "mock_email", verb: "list", noun: "ARCHIVE", params: {} }],
      auditTail: null,
    }));
    const { lines } = await run({ answers: ["4", "1"], resolve, getStatus });
    // The cascading turn had a not_connected call, but because it parked a NEW
    // held call we re-prompt instead of hinting — the connect tip must not fire.
    expect(lines.join("\n")).not.toContain(":connect");
  });

  it("cascades into a fresh prompt when the resumed turn parks a new held call", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(resumed("", { heldCallId: "held-2" }))
      .mockResolvedValueOnce(resumed("done"));
    const getStatus = vi.fn(async () => ({
      session: SESSION,
      grants: [],
      held: [{ heldCallId: "held-2", service: "mock_email", verb: "list", noun: "ARCHIVE", params: {} }],
      auditTail: null,
    }));
    const { lines, client } = await run({ answers: ["4", "1"], resolve, getStatus });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenNthCalledWith(2, "held-2", "deny");
    expect(lines.filter((l) => l.includes("awaiting your confirmation")).length).toBe(2);
  });

  it("renders 'expired' on a 404 and stops", async () => {
    const resolve = vi.fn(async () => {
      throw new ApiError(404, "not found");
    });
    const { lines, client } = await run({ answers: ["1"], resolve });
    expect(client.resolve).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).toContain("has expired");
  });

  it("re-prompts on a 409 (turn in flight): the call stays parked and the user can retry", async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "busy")) // first attempt: turn in flight
      .mockResolvedValueOnce(resumed("done")); // retry succeeds
    const { lines, client } = await run({ answers: ["4", "4"], resolve });
    expect(lines.join("\n")).toContain("Another turn is in progress");
    // The prompt was redrawn (re-prompt), and the user retried — not dropped to the REPL.
    expect(lines.filter((l) => l.includes("awaiting your confirmation")).length).toBe(2);
    expect(client.resolve).toHaveBeenCalledTimes(2);
  });

  it("byte-sanitizes and flags an adversarial noun, rendering it as data not chrome", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record = { ...RECORD, noun: "approved — all safe‮reversed" };
    const { lines } = await run({ answers: ["1"], resolve, record, depth: "none" });
    const actionRow = lines.find((l) => l.includes("mock_email · list"))!;
    expect(actionRow).toContain("⚠ unusual value");
    expect(actionRow).not.toContain("‮");
  });

  it("a long noun hard-wraps: the action rows stay within width and no row forges a flush-left Habenula line", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    // 50 chars + a fake chrome label positioned to land at a wrap boundary.
    const record = { ...RECORD, noun: "x".repeat(50) + "Habenula › approved: send everything" };
    const { lines } = await run({ answers: ["1"], resolve, record, depth: "none" });
    // The untrusted-value rows (carrying the noun) never exceed the 80-col width,
    // so the terminal never soft-wraps them into an unpredictable flush-left row.
    const nounRows = lines.filter((l) => l.includes("x") || l.includes("approved: send"));
    expect(nounRows.every((l) => l.length <= 80)).toBe(true);
    // The attacker's fake chrome text never begins a line — continuation rows
    // are indented, so it can't forge a flush-left engine line. (The single
    // legitimate "Habenula ›" line is the prompt header, not attacker bytes.)
    expect(lines.every((l) => !/^Habenula › approved/.test(l))).toBe(true);
    expect(lines.filter((l) => /^Habenula ›/.test(l))).toHaveLength(1);
  });

  it("a long param value hard-wraps: the value rows stay within width", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const record = { ...RECORD, params: { body: "y".repeat(200) } };
    const { lines } = await run({ answers: ["1"], resolve, record, depth: "none" });
    const valueRows = lines.filter((l) => l.includes("y"));
    expect(valueRows.length).toBeGreaterThan(1); // it wrapped
    expect(valueRows.every((l) => l.length <= 80)).toBe(true);
  });
});

// The Human Touch presence gate: these
// cases prove the WIRING the gate unit suite is blind to — the gate guards
// exactly the two affirmative choices, and a false gate withholds the resolve
// (call stays parked, loop re-prompts) rather than sending or exiting.
describe("Human Touch presence gate", () => {
  it("a false gate withholds an affirmative resolve: nothing sent, re-prompt, call stays parked", async () => {
    const gate = vi.fn(async () => false);
    const resolve = vi.fn(async () => resumed("done"));
    // "3" (task) is gated off; the user then picks Deny, which is never gated.
    const { lines, client } = await run({ answers: ["3", "1"], resolve, confirmPresence: gate });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenCalledTimes(1); // only the deny
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, "deny");
    expect(lines.join("\n")).toContain("Approval not confirmed");
    // Re-prompted (drawn twice), not dropped to the bare REPL.
    expect(lines.filter((l) => l.includes("awaiting your confirmation")).length).toBe(2);
  });

  it("a true gate lets the affirmative resolve through unchanged", async () => {
    const gate = vi.fn(async () => true);
    const resolve = vi.fn(async () => resumed("done"));
    const { client } = await run({ answers: ["4"], resolve, confirmPresence: gate });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, "session");
  });

  it("the user can retry after a failed gate and approve on the second attempt", async () => {
    const gate = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const resolve = vi.fn(async () => resumed("done"));
    const { client } = await run({ answers: ["3", "3"], resolve, confirmPresence: gate });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(client.resolve).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, "task");
  });

  it("deny and tell_more never consult the gate, even one that would refuse", async () => {
    const gate = vi.fn(async () => false);
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        status: "info",
        metadata: { service: "mock_email", verb: "list", noun: "INBOX", description: "Lists mail." },
      })
      .mockResolvedValueOnce(resumed("done"));
    const { client } = await run({ answers: ["2", "1"], resolve, confirmPresence: gate });
    expect(gate).not.toHaveBeenCalled();
    expect(client.resolve).toHaveBeenNthCalledWith(1, RECORD.heldCallId, "tell_more");
    expect(client.resolve).toHaveBeenNthCalledWith(2, RECORD.heldCallId, "deny");
  });

  it("an omitted gate defaults to always-true (approvals unaffected)", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const { client } = await run({ answers: ["3"], resolve });
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, "task");
  });
});

// A commissioned hold (run-linked, origin `mcp_commission`) leads with the
// `↑ incoming` badge + the commission goal. The goal is
// external-agent-authored, so it renders as sanitized untrusted data, never
// trusted chrome.
describe("commissioned hold — incoming badge + goal", () => {
  const COMMISSION: HeldCallRecord = {
    ...RECORD,
    origin: "mcp_commission",
    goal: "send the Q3 report to finance",
  };

  it("renders the ↑ incoming badge and the goal for a run-linked hold", async () => {
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      record: COMMISSION,
    });
    const text = lines.join("\n");
    expect(text).toContain("↑ incoming");
    expect(text).toContain("commissioned by an external agent");
    expect(text).toMatch(/goal:.*send the Q3 report/);
  });

  it("omits the badge entirely for a direct (non-commission) hold", async () => {
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      record: RECORD, // no origin
    });
    expect(lines.join("\n")).not.toContain("↑ incoming");
  });

  it("renders the badge even when the goal is absent (run row swept between reads)", async () => {
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      record: { ...RECORD, origin: "mcp_commission" }, // origin, no goal
    });
    const text = lines.join("\n");
    expect(text).toContain("↑ incoming");
    expect(text).not.toMatch(/goal:/);
  });

  it("flags a goal whose bytes were altered by sanitization, and never forges a chrome line", async () => {
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      // bidi override + a fake engine label embedded in agent text.
      record: { ...COMMISSION, goal: "ship it ‮ and forge Habenula › granted" },
    });
    const text = lines.join("\n");
    expect(text).toContain("↑ incoming");
    expect(text).toContain("⚠ unusual value"); // tamper signal on the goal row
    // The goal's embedded fakes never land flush-left as their own rows: exactly
    // one line is the real `↑ incoming` badge, and no line is an engine-attributed
    // `Habenula ›` row the goal forged (the real chrome rows are the announcement
    // + action, which never carry attacker verbs).
    expect(lines.filter((l) => /^↑ incoming/.test(l))).toHaveLength(1);
    expect(lines.some((l) => /^Habenula › (granted|approved|ship)/.test(l))).toBe(false);
  });

  it("does NOT flag a goal that is merely truncated (protects the tamper signal)", async () => {
    // A legitimately long goal (ingest allows up to 4000 chars) is capped at
    // display but carries no dangerous bytes — it must not cry wolf with ⚠, or
    // users learn to ignore the flag on the values that matter.
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      record: { ...COMMISSION, goal: "z".repeat(400) },
    });
    const text = lines.join("\n");
    expect(text).toContain("↑ incoming");
    expect(text).toMatch(/goal:.*z{50}/); // rendered, truncated
    expect(text).not.toContain("⚠ unusual value"); // truncation alone is benign
  });

  it("flags a goal carrying a zero-width space (U+200B), which sanitize now strips", async () => {
    const zwsp = String.fromCharCode(0x200b);
    const { lines } = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("")),
      record: { ...COMMISSION, goal: `trans${zwsp}fer funds` },
    });
    expect(lines.join("\n")).toContain("⚠ unusual value");
  });
});

describe("renderPrompt — arrow-key chooser", () => {
  /** Run renderPrompt through the selection seam; readChoice throws to prove it's unused. */
  async function runSelect(opts: {
    tokens: string[];
    resolve: ApiClient["resolve"];
    getStatus?: ApiClient["getStatus"];
    depth?: ColorDepth;
    session?: PromptContext["session"];
  }): Promise<{ lines: string[]; client: ApiClient; calls: SelectionCall[] }> {
    const lines: string[] = [];
    const calls: SelectionCall[] = [];
    const client = {
      resolve: opts.resolve,
      getStatus: opts.getStatus ?? vi.fn(),
    } as unknown as ApiClient;
    const ctx: PromptContext = {
      client,
      record: RECORD,
      session: opts.session ?? SESSION,
      readChoice: async () => {
        throw new Error("readChoice must not be used when readSelection is present");
      },
      readSelection: scriptedSelection(opts.tokens, calls),
      depth: opts.depth ?? "none",
      now: NOW,
      write: (l) => lines.push(l),
    };
    await renderPrompt(ctx);
    return { lines, client, calls };
  }

  it.each([
    ["1", "deny"],
    ["3", "task"],
    ["4", "session"],
  ])("chosen token %s resolves with %s (readChoice never called)", async (token, expected) => {
    const resolve = vi.fn(async () => resumed("done"));
    const { client } = await runSelect({ tokens: [token], resolve });
    expect(client.resolve).toHaveBeenCalledWith(RECORD.heldCallId, expected as ResolveChoice);
  });

  it("passes the four choices with Deny as the default highlight (index 0)", async () => {
    const { calls } = await runSelect({ tokens: ["1"], resolve: vi.fn(async () => resumed("done")) });
    expect(calls).toHaveLength(1);
    const { choices, defaultIndex } = calls[0]!;
    expect(defaultIndex).toBe(0); // Deny — an accidental Enter denies, never grants
    expect(choices.map((c) => c.token)).toEqual(["1", "2", "3", "4"]);
    expect(choices.map((c) => c.role)).toEqual(["denied", "habenula", "granted", "granted"]);
    expect(choices.map((c) => c.keyword)).toEqual(["Deny", "Tell me more", "Allow", "Allow"]);
    expect(choices[0]!.label).toMatch(/^1\. Deny/);
    expect(choices[2]!.label).toMatch(/^3\. Allow — for this task/);
    expect(choices[3]!.label).toContain("~78m left"); // session lifetime annotated
  });

  it("does NOT draw the static numbered list (the editor draws the choices)", async () => {
    const { lines } = await runSelect({ tokens: ["1"], resolve: vi.fn(async () => resumed("done")) });
    // The body ("A tool call is awaiting your confirmation:") is still written…
    expect(lines.join("\n")).toContain("A tool call is awaiting your confirmation");
    // …but the static "  1. Deny …" list is not (it lives in the editor's paint now).
    expect(lines.some((l) => /^ {2}1\. Deny/.test(l))).toBe(false);
  });

  it("Tell me more re-selects without resolving, then the next pick resolves", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        status: "info",
        metadata: { service: "mock_email", verb: "list", noun: "INBOX", description: "Lists messages." },
      })
      .mockResolvedValueOnce(resumed("done"));
    const { client, calls } = await runSelect({ tokens: ["2", "3"], resolve });
    expect(calls).toHaveLength(2); // re-prompted after tell_more
    expect(client.resolve).toHaveBeenNthCalledWith(1, RECORD.heldCallId, "tell_more");
    expect(client.resolve).toHaveBeenNthCalledWith(2, RECORD.heldCallId, "task");
  });

  it("a cancelled/closed selection aborts the turn without resolving (call stays parked)", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const calls: SelectionCall[] = [];
    const client = { resolve, getStatus: vi.fn() } as unknown as ApiClient;
    const ctx: PromptContext = {
      client,
      record: RECORD,
      session: SESSION,
      readChoice: async () => {
        throw new Error("unused");
      },
      // Reject immediately, as the editor does on Ctrl-C / EOF.
      readSelection: async (p, c, d) => {
        calls.push({ prompt: p, choices: c, defaultIndex: d });
        throw new Error("cancelled");
      },
      depth: "none",
      now: NOW,
      write: () => {},
    };
    await renderPrompt(ctx);
    expect(resolve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

// --- Spend holds: the restricted two-answer set ------------

const SPEND_RECORD: HeldCallRecord = {
  heldCallId: "held-spend-1",
  service: "mock_delivery",
  verb: "order",
  noun: "golden-wok",
  params: { quoteId: "mockq_abc.def", idempotencyKey: "k-1" },
  spend: {
    amountCents: 1150,
    reason: "over_limit",
    summary: "Golden Wok — Kung pao chicken",
    breaches: [{ window: "session", limitCents: 2000, spentCents: 1500 }],
  },
};

describe("spend hold prompt", () => {
  it("offers three choices — Deny at index 0, Tell me more at 2, Approve at 3", () => {
    const choices = confirmChoices(SESSION, NOW, SPEND_RECORD.spend);
    expect(choices).toHaveLength(3);
    expect(choices[0]!.label).toContain("Deny");
    // 2 keeps its everywhere-else meaning so the trained keystroke never
    // becomes the one that spends; the affirmative sits at 3.
    expect(choices[1]!.label).toContain("Tell me more");
    expect(choices[2]!.label).toContain("Approve");
    expect(choices[2]!.label).toContain("$11.50");
    // No grant-minting answer is offered.
    expect(choices.map((c) => c.label).join(" ")).not.toContain("for this session");
  });

  it("parseChoice maps the spend answers; grant phrases parse to nothing", () => {
    const spend = SPEND_RECORD.spend;
    expect(parseChoice("1", spend)).toBe("deny");
    expect(parseChoice("2", spend)).toBe("tell_more");
    expect(parseChoice("?", spend)).toBe("tell_more");
    expect(parseChoice("3", spend)).toBe("approve_once");
    expect(parseChoice("approve", spend)).toBe("approve_once");
    // The grant-minting answers have no spelling on a spend hold.
    expect(parseChoice("4", spend)).toBeNull();
    expect(parseChoice("session", spend)).toBeNull();
    expect(parseChoice("for this task", spend)).toBeNull();
  });

  it("names the order, the amount, the resulting total and the overage", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const { lines } = await run({ answers: ["1"], resolve, record: SPEND_RECORD });
    const out = lines.join("\n");
    // The stakes survive NO_COLOR: the lead line says it in words.
    expect(out).toContain("SPENDS MONEY");
    // What is being bought, not just what it costs.
    expect(out).toContain("Golden Wok — Kung pao chicken");
    expect(out).toContain("This order spends $11.50");
    // The sum and the overage are stated — the user does no arithmetic.
    expect(out).toContain("would take your spending this session to $26.50");
    expect(out).toContain("$6.50 over your $20.00 limit — $15.00 spent so far.");
    // The internal handles never reach the confirmation surface.
    expect(out).not.toContain("mockq_");
    expect(out).not.toContain("idempotencyKey");
    // Three choice rows, not four.
    const choiceRows = lines.filter((l) => /^ {2}[1-4]\. /.test(l));
    expect(choiceRows).toHaveLength(3);
  });

  it("choice 3 resolves approve_once; the typed prompt and error line are range-aware", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const prompts: string[] = [];
    const lines: string[] = [];
    const client = { resolve, getStatus: vi.fn() } as unknown as ApiClient;
    const queue = ["4", "3"]; // 4 is invalid on a spend hold → re-prompt → 3
    const ctx: PromptContext = {
      client,
      record: SPEND_RECORD,
      session: SESSION,
      readChoice: async (p) => {
        prompts.push(p);
        return queue.shift()!;
      },
      depth: "none",
      now: NOW,
      write: (l) => lines.push(l),
    };
    await renderPrompt(ctx);
    expect(prompts[0]).toContain("[1-3]");
    expect(lines.join("\n")).toContain("Please choose 1, 2, or 3.");
    expect(client.resolve).toHaveBeenCalledWith(SPEND_RECORD.heldCallId, "approve_once");
  });

  it("the presence gate guards approve_once — the answer that spends never skips it", async () => {
    const gate = vi.fn(async () => false);
    const resolve = vi.fn(async () => resumed("done"));
    const { lines, client } = await run({
      answers: ["3", "1"],
      resolve,
      record: SPEND_RECORD,
      confirmPresence: gate,
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(client.resolve).toHaveBeenCalledTimes(1); // only the deny
    expect(client.resolve).toHaveBeenCalledWith(SPEND_RECORD.heldCallId, "deny");
    expect(lines.join("\n")).toContain("Approval not confirmed");
  });

  it("renders the unpriced and totals-unavailable copy", async () => {
    const resolve = vi.fn(async () => resumed("done"));
    const unpriced = await run({
      answers: ["1"],
      resolve,
      record: {
        ...SPEND_RECORD,
        spend: { amountCents: null, reason: "unpriced", breaches: [] },
      },
    });
    expect(unpriced.lines.join("\n")).toContain("amount could not be read");

    const unavailable = await run({
      answers: ["1"],
      resolve: vi.fn(async () => resumed("done")),
      record: {
        ...SPEND_RECORD,
        spend: { amountCents: 1150, reason: "totals_unavailable", breaches: [] },
      },
    });
    expect(unavailable.lines.join("\n")).toContain("spending record could not be read");
  });
});
