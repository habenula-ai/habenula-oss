import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApiClient } from "../../src/api-client";
import { ApiError, EngineUnavailableError } from "../../src/api-client";
import { runChatRepl, type ReplIO } from "../../src/commands/chat";

/**
 * Validation gate: the proactive poll wired into the
 * live REPL. Drives `runChatRepl` with the poll enabled and a gated sleep, so a
 * held call surfaces while the user is idle — no user turn — composing over the
 * input line (erase → render → restore) rather than racing the pending read, and
 * resolving through the same line router the reactive path uses. Complements
 * poll.test.ts (which unit-tests the mechanism against fakes) by proving the
 * wiring: the real `pollableIO` adapter, the shared latch, and choice routing.
 */

const SESSION = {
  sessionId: "s1",
  startedAt: "2026-07-03T11:48:00.000Z",
  expiry: "2026-07-03T13:18:00.000Z",
};

const HELD_RECORD = {
  heldCallId: "held-1",
  service: "mock_email",
  verb: "send",
  noun: "user@example.com",
  params: { subject: "hi" },
  origin: "mcp_commission" as const,
  goal: "email the report",
};

function resumed(response: string) {
  return {
    status: "resumed" as const,
    result: {
      response,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      iterations: 1,
    },
  };
}

function stubClient(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
  return {
    apiUrl: "http://api.test",
    startSession: vi.fn(async () => ({ status: "started", activeSession: SESSION })),
    quit: vi.fn(async () => ({ ended: true })),
    listServices: vi.fn(async () => ({ services: [{ service: "mock_email", connected_at: "2026-07-01" }] })),
    getPolicy: vi.fn(async () => ({ effectiveDecision: "deny", entries: [] })),
    getStatus: vi.fn(async () => ({ session: SESSION, grants: [], held: [HELD_RECORD] })),
    resolve: vi.fn(async () => resumed("Sent.")),
    chat: vi.fn(async () => ({ response: "", toolCalls: [], iterations: 1, usage: { inputTokens: 1, outputTokens: 1 } })),
    ...overrides,
  } as unknown as ApiClient;
}

/** A sleep the test advances by hand; `stop()` unblocks it so the loop can end. */
function gatedSleep() {
  let pending: (() => void) | null = null;
  let stopped = false;
  return {
    sleep: (): Promise<void> => (stopped ? Promise.resolve() : new Promise<void>((r) => { pending = r; })),
    tick: () => { const p = pending; pending = null; p?.(); },
    stop: () => { stopped = true; const p = pending; pending = null; p?.(); },
  };
}

/**
 * A line-driven ReplIO that does NOT auto-emit on `showPrompt` (the user is
 * idle); the test emits the choice by hand. Records erase/restore/read into a
 * shared timeline so ordering against the rendered output is assertable. With
 * `selection`, it grows a `beginSelection` that records the chooser's prompt
 * mutation, so the raw editor's arrow-key path is drivable too.
 */
function manualIO(
  timeline: string[],
  opts: { selection?: boolean } = {},
): {
  io: ReplIO;
  emit: (line: string) => void;
  emitClose: () => void;
  emitSigint: () => void;
} {
  let onLine: (line: string) => void = () => {};
  let onClose: () => void = () => {};
  let onSigint: () => void = () => {};
  const io: ReplIO = {
    onLine: (cb) => { onLine = cb; },
    onClose: (cb) => { onClose = cb; },
    onSigint: (cb) => { onSigint = cb; },
    setPrompt: (prompt) => timeline.push(`prompt:${prompt}`),
    showPrompt: () => {}, // idle: no auto-emit
    currentLine: () => "",
    eraseInputLine: () => timeline.push("erase"),
    restoreInput: () => timeline.push("restore"),
    write: () => {},
    deferPoll: () => false, // idle, menu closed — the poll renders (never defers)
    setStatus: () => {}, // status-line refresh is silent in this timeline
    close: () => {},
  };
  if (opts.selection) {
    // Mirror RawLineEditor.beginSelection: entering chooser mode mutates
    // the shared prompt string before the choices draw — the same mutation the
    // typed path's choice read performs, reaching restore through the same seam.
    io.beginSelection = (prompt) => timeline.push(`prompt:${prompt}`);
  }
  return {
    io,
    emit: (line) => onLine(line),
    emitClose: () => onClose(),
    emitSigint: () => onSigint(),
  };
}

/**
 * The prompt string in force when the poll restored the input line: the last
 * `prompt:` event before the first `restore`. The invariant is that this
 * is the idle prompt — asserting on the value AT the restore (not merely that
 * a reset occurred somewhere) means a reset-then-remutate regression fails too.
 */
function promptAtRestore(timeline: string[]): string | undefined {
  const restore = timeline.indexOf("restore");
  // No restore (indexOf → -1) collapses to an empty slice → `undefined`, which
  // fails the `.toMatch` assertion — a correct failure. The callers also assert
  // the restore-vs-choice ordering explicitly, so that case is never silent.
  return timeline
    .slice(0, Math.max(restore, 0))
    .filter((e) => e.startsWith("prompt:"))
    .at(-1);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("proactive poll wired into the REPL", () => {
  let timeline: string[];
  let originalColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    timeline = [];
    vi.spyOn(console, "log").mockImplementation((m) => void timeline.push(`out:${String(m)}`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  });

  it("surfaces a held call while idle, erasing the input before the prompt and restoring it after", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient();

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush(); // boot handshake + the idle read is now pending

    g.tick(); // fire one poll interval
    await flush(); // pollTick: read → erase → render the prompt → await the choice

    m.emit("4"); // the user answers the polled confirmation ("For this session")
    await flush();

    m.emitClose(); // end the idle loop
    await flush();
    g.stop(); // unblock the poll's pending sleep so it sees isActive() === false
    const code = await done;

    expect(code).toBe(0);
    // Rendered without a user chat turn.
    expect(client.chat).not.toHaveBeenCalled();
    expect(client.resolve).toHaveBeenCalledWith("held-1", "session");
    expect(client.resolve).toHaveBeenCalledTimes(1); // rendered once, not doubled

    const out = timeline.join("\n");
    expect(out).toContain("awaiting your confirmation");
    expect(out).toContain("↑ incoming"); // commissioned hold badge

    // Interleaving: the input line was erased BEFORE the prompt drew and restored
    // AFTER it — a poll never corrupts the half-typed buffer.
    const erase = timeline.indexOf("erase");
    const firstRender = timeline.findIndex((e) => e.startsWith("out:") && e.includes("awaiting"));
    const restore = timeline.indexOf("restore");
    expect(erase).toBeGreaterThanOrEqual(0);
    expect(erase).toBeLessThan(firstRender);
    expect(firstRender).toBeLessThan(restore);
  });

 it("restores the idle prompt (not the stale choice prompt) after a polled confirmation resolves", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient();

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();

    g.tick(); // fire one poll interval — the held call surfaces over the idle read
    await flush();

    m.emit("4"); // approve; the resumed turn renders and the poll restores the input
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    // The choice read mutated the shared prompt; the restore must reset it to the
    // idle prompt BEFORE re-displaying, or the phantom picker redraws at idle and
    // input typed there routes as a chat message. The idle read is still pending
    // across the whole flow, so nothing else resets the string.
    const choicePrompt = timeline.findIndex((e) => e.startsWith("prompt:Your choice"));
    expect(choicePrompt).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("restore")).toBeGreaterThan(choicePrompt);
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

 it("resets the idle prompt even when the resolve fails and the render path throws", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient({
      resolve: vi.fn().mockRejectedValue(new ApiError(500, "internal error", "INTERNAL")),
    });
    // The failed tick routes to the muted stderr sink; spy so it stays out of
    // the test output and the routing is assertable.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();

    g.tick(); // the held call surfaces over the idle read
    await flush();

    m.emit("4"); // approve → resolve 500s → renderPrompt throws into the cooldown path
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    // The throw reached the poll's muted error sink (cooldown path), not a crash …
    expect(client.resolve).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("background check failed"));
    // … and pollTick's finally still reset the prompt before restoring — the
    // render-failure half of the fix.
    const choicePrompt = timeline.findIndex((e) => e.startsWith("prompt:Your choice"));
    expect(choicePrompt).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("restore")).toBeGreaterThan(choicePrompt);
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

 it("resets the idle prompt after an arrow-key chooser confirmation", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline, { selection: true });
    const client = stubClient();

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();

    g.tick(); // the held call surfaces; the chooser (readSelection) path mutates the prompt
    await flush();

    m.emit("4"); // "4" is the token beginSelection submits for choice 4 on Enter
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    expect(client.resolve).toHaveBeenCalledWith("held-1", "session");
    // beginSelection's prompt mutation (the raw editor's chooser) reaches
    // the same restore seam as the typed path — and gets the same reset.
    const chooserPrompt = timeline.findIndex(
      (e) => e.startsWith("prompt:") && e.includes("Choose with"),
    );
    expect(chooserPrompt).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("restore")).toBeGreaterThan(chooserPrompt);
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

  it("Ctrl-C dismissing a polled confirmation resets the idle prompt before the restore", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient();

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();
    g.tick(); // the held call surfaces over the idle read
    await flush();

    m.emitSigint(); // dismiss the open confirmation — the call stays parked
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    // Nothing was resolved; the dismissal message rendered.
    expect(client.resolve).not.toHaveBeenCalled();
    expect(timeline.join("\n")).toContain("cancelled — the call is still pending");
    // The cancel is a terminal settle: the prompt string is the idle prompt
    // again by the time the poll repaints the input line.
    const choicePrompt = timeline.findIndex((e) => e.startsWith("prompt:Your choice"));
    expect(choicePrompt).toBeGreaterThanOrEqual(0);
    expect(timeline.indexOf("restore")).toBeGreaterThan(choicePrompt);
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

  it("does not pass through the idle prompt between Tell-me-more re-reads", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient({
      resolve: vi
        .fn()
        .mockResolvedValueOnce({
          status: "info",
          metadata: {
            service: "mock_email",
            verb: "send",
            noun: "user@example.com",
            description: "Sends an email on your behalf.",
          },
        })
        .mockResolvedValueOnce(resumed("Sent.")),
    });

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();
    g.tick(); // the held call surfaces over the idle read
    await flush();

    m.emit("2"); // Tell me more — metadata renders, the prompt re-asks, nothing settles
    await flush();
    m.emit("4"); // now approve
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    expect(client.resolve).toHaveBeenNthCalledWith(1, "held-1", "tell_more");
    expect(client.resolve).toHaveBeenNthCalledWith(2, "held-1", "session");
    // The restore fires on terminal settles only: an idle reset between the two
    // choice prompts would flash `> ` mid-confirmation on an editor that
    // repaints after writes.
    const [firstChoice = -1, secondChoice = -1] = timeline
      .map((e, i) => (e.startsWith("prompt:Your choice") ? i : -1))
      .filter((i) => i >= 0);
    expect(firstChoice).toBeGreaterThanOrEqual(0);
    expect(secondChoice).toBeGreaterThan(firstChoice);
    const between = timeline.slice(firstChoice + 1, secondChoice);
    expect(between.some((e) => e.startsWith("prompt:> "))).toBe(false);
    // …and the terminal settle still restores it (the restore invariant holds).
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

  it("EOF while a polled confirmation is open still resets the prompt before the exit repaint", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient();

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();
    g.tick(); // the held call surfaces over the idle read
    await flush();

    m.emitClose(); // Ctrl-D with the confirmation still open — the call stays parked
    await flush();
    g.stop();
    const code = await done;

    expect(code).toBe(0);
    expect(client.resolve).not.toHaveBeenCalled();
    // `onClose` flips `closed` before the choice read rejects; the restore must
    // still reset the prompt string on this settle, or the poll's exit repaint
    // paints the dead choice prompt (the regression the closed-guard caused).
    const choicePrompt = timeline.findIndex((e) => e.startsWith("prompt:Your choice"));
    expect(choicePrompt).toBeGreaterThanOrEqual(0);
    expect(promptAtRestore(timeline)).toMatch(/^prompt:> /);
  });

  it("a polled confirmation whose resolve 409s re-prompts instead of crashing the poll", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient({
      resolve: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(409, "turn in progress", "TURN_IN_PROGRESS"))
        .mockResolvedValueOnce(resumed("Sent.")),
    });

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep });
    await flush();
    g.tick();
    await flush();

    m.emit("4"); // first answer → resolve 409s → re-prompt (call stays parked)
    await flush();
    m.emit("4"); // answer again → resolves
    await flush();

    m.emitClose();
    await flush();
    g.stop();
    await done;

    expect(timeline.join("\n")).toContain("Another turn is in progress");
    expect(client.resolve).toHaveBeenCalledTimes(2);
  });

  it("a background-poll DEADLINE keeps the REPL online: no announcement, foreground still dispatches (flap asymmetry)", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const client = stubClient({
      getStatus: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "deadline");
      }),
      chat: vi.fn(async () => ({
        response: "still online",
        toolCalls: [],
        iterations: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    });

    const done = runChatRepl(client, () => m.io, {
      poll: true,
      pollSleep: g.sleep,
      probeSleep: () => new Promise<never>(() => {}),
    });
    await flush();

    g.tick(); // one poll interval — the read times out (kind: "deadline")
    await flush();
    g.tick(); // and another
    await flush();

    // No offline transition was announced …
    expect(timeline.join("\n")).not.toContain("not responding");
    expect(timeline.join("\n")).not.toContain("not reachable");
    // … and a foreground chat still dispatches (the REPL never went offline).
    m.emit("hello");
    await flush();
    expect(client.chat).toHaveBeenCalledWith("hello");

    m.emitClose();
    await flush();
    g.stop();
    await done;
  });

 it("a background-poll REJECT flips offline (guidance once), pauses the poll, and recovery resumes it", async () => {
    const g = gatedSleep();
    const m = manualIO(timeline);
    const engine = { up: false };
    const getStatus = vi.fn(async () => {
      if (!engine.up) throw new EngineUnavailableError("http://api.test", "reject");
      return { session: SESSION, grants: [], held: [] };
    });
    const client = stubClient({
      getStatus,
      probeHealth: vi.fn(async () => engine.up),
      chat: vi.fn(async () => ({
        response: "back online",
        toolCalls: [],
        iterations: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    });

    // The probe interval is gated separately from the poll interval.
    let pendingProbe: (() => void) | null = null;
    const probeSleep = (): Promise<void> =>
      new Promise<void>((r) => {
        pendingProbe = r;
      });

    const done = runChatRepl(client, () => m.io, { poll: true, pollSleep: g.sleep, probeSleep });
    await flush();

    g.tick(); // poll reject → offline
    await flush();
    expect(timeline.join("\n")).toContain("not reachable");
    const readsWhenOffline = getStatus.mock.calls.length;

    // While offline the poll is paused: further intervals issue NO read.
    g.tick();
    await flush();
    g.tick();
    await flush();
    expect(getStatus.mock.calls.length).toBe(readsWhenOffline);

    // A foreground action gets the one-line notice, not silence — and no request.
    m.emit("hello while down");
    await flush();
    expect(client.chat).not.toHaveBeenCalled();

    // Engine returns → probe → handshake → online announcement.
    engine.up = true;
    expect(pendingProbe).not.toBeNull();
    pendingProbe!();
    await flush();
    await flush();
    expect(timeline.join("\n")).toContain("Engine connected.");

    // The poll resumed: the next interval issues a read again.
    g.tick();
    await flush();
    expect(getStatus.mock.calls.length).toBeGreaterThan(readsWhenOffline);

    // And foreground work flows again.
    m.emit("hello again");
    await flush();
    expect(client.chat).toHaveBeenCalledWith("hello again");

    m.emitClose();
    await flush();
    g.stop();
    await done;
  });
});
