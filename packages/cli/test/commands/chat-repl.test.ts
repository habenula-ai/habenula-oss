import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { ApiClient, EngineUnavailableError, type FetchFn } from "../../src/api-client";
import { sseToolResult, toolNameOf } from "../helpers/internal-wire";
import {
  runChatRepl,
  SESSION_UNVERIFIED_NOTICE,
  type ReplIO,
  type RunChatReplOptions,
} from "../../src/commands/chat";

/**
 * Neutralize the real platform browser opener at the module boundary. The
 * `:connect` opener (`openInBrowser` in commands/connect.ts) shells out through
 * `child_process.spawn`, so stubbing spawn here makes it impossible for ANY
 * test in this file to launch a browser — even one that scripts `:connect` and
 * loses the `openBrowser` seam, because the fallback path now spawns
 * nothing. This is the airtight half of the guard: `runRepl`'s no-op default
 * and the guard test's spy prove the injected opener WAS reached, and this stub
 * guarantees the real one is inert regardless. The guard test also asserts spawn
 * stays untouched — proof the fallback was never taken. (`confirm-presence.ts`
 * imports spawn too, but these wiring tests run the always-true default gate, so
 * its spawn path is never exercised.)
 */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(() => ({ unref: () => {} })) };
});

/**
 * Wiring tests for the REPL control flow — the layer the pure-helper and
 * runner tests are structurally blind to (does the loop CALL the handshake,
 * print the notice on the right branch, dispatch quit then exit?). An earlier
 * re-minting bug shipped because primitives were tested and wiring wasn't;
 * these pin the CLI's wiring.
 *
 * Stubs sit at the ApiClient METHOD level (typed results, no wire bodies) —
 * deliberately migration-proof: the shared response-contract migration can rewrite
 * api-client.ts without touching these tests. Parse-layer coverage (raw JSON,
 * the 409 carve-out) lives in api-client.test.ts.
 */

const VIEW = {
  sessionId: "session-abc",
  startedAt: "2026-07-03T11:48:00.000Z",
  expiry: "2026-07-03T13:18:00.000Z",
};

/** Queue sentinel: fire the registered SIGINT handler instead of a line. */
const SIGINT = "<SIGINT>";

/**
 * Scripted line-driven ReplIO: each `showPrompt()` bumps `prompts` and emits the
 * next queued line (async, so the awaiter is registered first); an empty queue
 * emits close (EOF, Ctrl-D). `prompts` counts every prompt shown (idle + choice),
 * as the old `question()` count did. A queued `SIGINT` sentinel fires the
 * registered Ctrl-C handler instead of a line, and `fireSigint()` fires it
 * directly (for mid-dispatch cancels). `close()` invokes the close handler,
 * mirroring readline's close event.
 */
function scriptedIO(lines: string[]): {
  io: ReplIO;
  prompts: number;
  fireSigint: () => void;
} {
  const queue = [...lines];
  let onLine: (line: string) => void = () => {};
  let onClose: () => void = () => {};
  let onSigint: () => void = () => {};
  let closed = false;
  const state = {
    io: undefined as unknown as ReplIO,
    prompts: 0,
    fireSigint: () => onSigint(),
  };
  state.io = {
    onLine: (cb) => {
      onLine = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    onSigint: (cb) => {
      onSigint = cb;
    },
    setPrompt: () => {},
    showPrompt: () => {
      state.prompts += 1;
      queueMicrotask(() => {
        const next = queue.shift();
        if (next === undefined) onClose();
        else if (next === SIGINT) onSigint();
        else onLine(next);
      });
    },
    currentLine: () => "",
    eraseInputLine: () => {},
    restoreInput: () => {},
    write: () => {},
    deferPoll: () => false,
    setStatus: () => {},
    close: () => {
      if (closed) return;
      closed = true;
      onClose();
    },
  };
  return state;
}

/** ApiClient stub: every method the REPL path can reach, overridable per test. */
function stubClient(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
  return {
    apiUrl: "http://api.test",
    startSession: vi.fn(async () => ({ status: "started", activeSession: VIEW })),
    quit: vi.fn(async () => ({ ended: true })),
    chat: vi.fn(async () => ({
      response: "ok",
      toolCalls: [],
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    // Non-empty services + allow → the first-run nudge stays quiet.
    listServices: vi.fn(async () => ({
      services: [{ service: "mock_email", connected_at: "2026-07-01" }],
    })),
    getPolicy: vi.fn(async () => ({ effectiveDecision: "deny", entries: [] })),
    getActiveSession: vi.fn(async () => ({ active: null })),
    ...overrides,
  } as unknown as ApiClient;
}

/**
 * Drive `runChatRepl` with a safe default `openBrowser`. The `:connect` dispatch
 * otherwise falls back to the real platform opener (`open <url>`), so any test
 * that scripts `:connect` with an authorize-URL response spawns a browser during
 * the run. Routing this file's tests through `runRepl` defaults a no-op,
 * so a new `:connect` test *here* can't re-leak it by forgetting the override;
 * the trailing spread lets a test that needs to assert the opener pass its own
 * spy, which wins. The guard is scoped to this helper — a test that calls
 * `runChatRepl` directly (here or in another file) still owns the injection.
 */
function runRepl(
  client: ApiClient,
  createIO?: () => ReplIO,
  opts: RunChatReplOptions = {},
): Promise<number> {
  return runChatRepl(client, createIO, { openBrowser: () => {}, ...opts });
}

describe("runChatRepl wiring", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the launch handshake exactly once; a started result prints no notice", async () => {
    const client = stubClient();
    const { io } = scriptedIO([":exit"]);

    const code = await runRepl(client, () => io);

    expect(code).toBe(0);
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain("Resuming active session");
    expect(logs.join("\n")).not.toContain(SESSION_UNVERIFIED_NOTICE);
  });

  it("prints the resume notice when the handshake is refused", async () => {
    const client = stubClient({
      startSession: vi.fn(async () => ({ status: "refused", activeSession: VIEW })),
    });
    const { io } = scriptedIO([":exit"]);

    await runRepl(client, () => io);

    const out = logs.join("\n");
    expect(out).toContain("Resuming active session");
    expect(out).toContain(":quit");
  });

  it("prints the unverified notice when the handshake throws, and the REPL still opens", async () => {
    const client = stubClient({
      startSession: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const script = scriptedIO([":exit"]);

    const code = await runRepl(client, () => script.io);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(SESSION_UNVERIFIED_NOTICE);
    expect(script.prompts).toBeGreaterThan(0); // the loop ran despite the failure
  });

  it("prints the unverified notice on an unrecognized handshake payload", async () => {
    const client = stubClient({
      startSession: vi.fn(async () => ({ error: "weird body" })),
    });
    const { io } = scriptedIO([":exit"]);

    await runRepl(client, () => io);

    expect(logs.join("\n")).toContain(SESSION_UNVERIFIED_NOTICE);
  });

  it(":quit ends the session (client.quit) and exits the loop", async () => {
    const client = stubClient();
    const script = scriptedIO([":quit", "should-never-be-read"]);

    const code = await runRepl(client, () => script.io);

    expect(code).toBe(0);
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(script.prompts).toBe(1); // exited after quit, second line never read
    expect(logs.join("\n")).toContain("Session ended");
  });

  it("a failed :quit is reported but still exits", async () => {
    const client = stubClient({
      quit: vi.fn(async () => {
        throw new Error("worker unreachable");
      }),
    });
    const script = scriptedIO([":quit", "should-never-be-read"]);

    const code = await runRepl(client, () => script.io);

    expect(code).toBe(0);
    expect(script.prompts).toBe(1);
    expect(errors.join("\n")).toContain("worker unreachable");
  });

  it(":exit detaches WITHOUT calling client.quit", async () => {
    const client = stubClient();
    const { io } = scriptedIO([":exit"]);

    await runRepl(client, () => io);

    expect(client.quit).not.toHaveBeenCalled();
  });

  it("EOF (Ctrl-D) detaches without calling client.quit", async () => {
    const client = stubClient();
    const { io } = scriptedIO([]); // first question() rejects

    const code = await runRepl(client, () => io);

    expect(code).toBe(0);
    expect(client.quit).not.toHaveBeenCalled();
  });

  it("a chat line dispatches to client.chat and prints the response", async () => {
    const client = stubClient();
    const { io } = scriptedIO(["hello there", ":exit"]);

    await runRepl(client, () => io);

    expect(client.chat).toHaveBeenCalledWith("hello there");
    expect(logs.join("\n")).toContain("ok");
  });

 it("re-seeds completion sources after :connect and :disconnect but not after a chat turn", async () => {
    // The mid-session refresh seam: each :connect/:disconnect dispatch calls
    // the IO's optional refreshCompletions once (the credential-less connect
    // path keeps the dispatch synchronous — no OAuth wait to script). The chat
    // line between them must not trigger it, so exactly two calls prove the
    // trigger is scoped to the service-changing commands.
    const client = stubClient({
      disconnect: vi.fn(async () => ({ removed: true })),
      connect: vi.fn(async () => ({ connected: true })),
    });
    const script = scriptedIO([":disconnect mock_email", "hello", ":connect mock_email", ":exit"]);
    const refresh = vi.fn();
    script.io.refreshCompletions = refresh;

    await runRepl(client, () => script.io);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("re-seeds completions even when the dispatch throws (finally placement)", async () => {
    // "Unconditional on the outcome": a `:disconnect` that throws may still
    // have landed server-side, so the refresh must fire from the dispatch's
    // `finally`, not its success path. A plain error (not availability) keeps
    // the tracker online, so the offline gate below stays out of the picture.
    const client = stubClient({
      disconnect: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const script = scriptedIO([":disconnect mock_email", ":exit"]);
    const refresh = vi.fn();
    script.io.refreshCompletions = refresh;

    await runRepl(client, () => script.io);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

 it("skips the refresh when the dispatch itself took the engine offline", async () => {
    // The health probe is the only offline traffic: a `:disconnect` failing
    // with an availability error transitions the tracker offline, and the
    // refresh — two more reads at the same dead engine — must not fire.
    const client = stubClient({
      disconnect: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "reject");
      }),
      // Stays down; with the probe sleep parked below, the loop never reaches it.
      probeHealth: vi.fn(async () => false),
    });
    const script = scriptedIO([":disconnect mock_email", ":exit"]);
    const refresh = vi.fn();
    script.io.refreshCompletions = refresh;

    await runRepl(client, () => script.io, {
      probeSleep: () => new Promise<never>(() => {}),
    });

    expect(refresh).not.toHaveBeenCalled();
  });

 it("SIGINT during :connect cancels the wait and the session survives", async () => {
    const cancelConnectFlow = vi.fn(async () => ({ cancelled: true }));
    const client = stubClient({
      connect: vi.fn(async () => ({ authorizeUrl: "http://x/auth", flow: "flow-1" })),
      getConnectFlowStatus: vi.fn(async () => ({ status: "pending" })),
      cancelConnectFlow,
    });
    const script = scriptedIO([":connect mock_email", "hello after", ":exit"]);

    // The connect wait's sleep never resolves: only the injected cancel
    // signal can end it. Fire Ctrl-C once the wait is pending.
    let fired = false;
    // Spy opener rather than a bare no-op so we can assert the seam is actually
    // threaded: drop the openBrowser pass-down and `toHaveBeenCalledWith` below
    // fails instead of the leak silently returning. The module-level
    // spawn stub is the backstop — even if this spy were removed, the fallback
    // opener could not launch a browser.
    const opener = vi.fn();
    const code = await runRepl(client, () => script.io, {
      openBrowser: opener,
      connectSleep: () =>
        new Promise<void>(() => {
          if (!fired) {
            fired = true;
            queueMicrotask(() => script.fireSigint());
          }
        }),
    });

    expect(code).toBe(0);
    // The injected opener received the authorize URL — proof the REPL threaded
    // `openBrowser` to `runConnect` instead of falling back to the real opener.
    expect(opener).toHaveBeenCalledWith("http://x/auth");
    // …and the real platform opener was never reached: the fallback shells out
    // via child_process.spawn, so an untouched spawn proves the seam held and no
    // browser could have launched (the negative half of the guard).
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    // The cancel POSTed the flow handle, the dispatch returned, and the NEXT
    // queued line still dispatched — the loop and session survived Ctrl-C.
    // Flow handle first; the abort signal bounds the cleanup POST.
    expect(cancelConnectFlow).toHaveBeenCalledWith("flow-1", expect.any(AbortSignal));
    expect(client.chat).toHaveBeenCalledWith("hello after");
    expect(client.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Cancelled connecting mock_email");
  });

 it("SIGINT during a :kill retry gives up, transitions the REPL offline, and the session survives", async () => {
    // The engine is unavailable, so :kill retries internally. Ctrl-C mid-retry
    // must give up promptly rather than freeze the full 30s window, and the
    // give-up must flip the tracker offline — so the NEXT command gets the
    // offline notice instead of freezing again.
    const client = stubClient({
      kill: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "reject");
      }),
      // Stays down; with the probe sleep parked below, the loop never reaches it.
      probeHealth: vi.fn(async () => false),
    });
    const script = scriptedIO([":kill", "hello after", ":exit"]);

    // The retry sleep never resolves on its own: only the injected Ctrl-C ends
    // it, proving the give-up races the abort rather than waiting the window.
    let fired = false;
    const code = await runRepl(client, () => script.io, {
      killSleep: () =>
        new Promise<void>(() => {
          if (!fired) {
            fired = true;
            queueMicrotask(() => script.fireSigint());
          }
        }),
      // Park the offline probe loop so it can't spin during the assertions.
      probeSleep: () => new Promise<void>(() => {}),
    });

    expect(code).toBe(0);
    // The kill was attempted, then abandoned on Ctrl-C.
    expect(client.kill).toHaveBeenCalled();
    // Give-up transitioned the REPL offline: the next line hit the offline gate
    // (no chat request went out), and the loop survived to process :exit.
    expect(client.chat).not.toHaveBeenCalled();
    expect(client.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("engine not reachable");
  });

 it("`:kill` is exempt from the offline gate — the emergency stop still attempts while offline", async () => {
    // Boot offline (startSession fails), so a generic engine-touching command
    // is gated. But :kill must NOT be swallowed with the offline notice: it is
    // the emergency stop, and runKill retries against an unavailable engine
    // until the kill lands (a mid-restart kill must still land). Here the engine
    // is reachable for the kill itself, so it lands despite the offline gate.
    const kill = vi.fn(async () => ({ killed: true as const }));
    const client = stubClient({
      startSession: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "reject");
      }),
      kill,
    });
    const script = scriptedIO([":kill", ":exit"]);

    const code = await runRepl(client, () => script.io, {
      // Park the probe loop so the offline state holds for the whole test.
      probeSleep: () => new Promise<never>(() => {}),
    });

    expect(code).toBe(0);
    // The kill was attempted despite the offline gate — not swallowed. Before
    // the fix, :kill hit the gate and client.kill was never called.
    expect(kill).toHaveBeenCalled();
  });

  it("SIGINT with nothing pending closes the REPL like Ctrl-D (detach, no quit)", async () => {
    const client = stubClient();
    const script = scriptedIO([SIGINT, "never-read"]);

    const code = await runRepl(client, () => script.io);

    expect(code).toBe(0);
    expect(client.quit).not.toHaveBeenCalled();
    expect(script.prompts).toBe(1); // closed on the first prompt's Ctrl-C
  });

 it("SIGINT during an open confirmation dismisses the prompt and the session survives", async () => {
    const HELD_RECORD = {
      heldCallId: "held-1",
      service: "mock_email",
      verb: "list",
      noun: "INBOX",
      params: { label: "INBOX" },
    };
    // The first chat turn parks a held call → the confirmation opens; the
    // second turn is a normal reply.
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        response: "",
        toolCalls: [],
        iterations: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
        held: { heldCallId: "held-1" },
      })
      .mockResolvedValue({
        response: "ok",
        toolCalls: [],
        iterations: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const resolve = vi.fn(async () => ({ status: "info", metadata: {} }));
    const client = stubClient({
      chat,
      resolve,
      getStatus: vi.fn(async () => ({ session: VIEW, grants: [], held: [HELD_RECORD] })),
    });

    // The SIGINT sentinel is the "answer" the choice prompt shows — Ctrl-C
    // while the confirmation is open. The next queued line must still dispatch.
    const script = scriptedIO(["list inbox", SIGINT, "hello after", ":exit"]);
    const code = await runRepl(client, () => script.io);

    expect(code).toBe(0);
    // The prompt was dismissed, not answered: nothing was resolved/granted.
    expect(resolve).not.toHaveBeenCalled();
    // The session survived — the next line dispatched and quit never ran.
    expect(chat).toHaveBeenCalledWith("hello after");
    expect(client.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("the call is still pending");
  });

 it("boot against a dead engine opens offline: guidance once, engine-touching actions gated, no crash", async () => {
    const client = stubClient({
      startSession: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "reject");
      }),
    });
    const script = scriptedIO(["hello", ":status", ":exit"]);

    const code = await runRepl(client, () => script.io, {
      // Park the probe loop so the offline state holds for the whole test.
      probeSleep: () => new Promise<never>(() => {}),
    });

    expect(code).toBe(0);
    const out = logs.join("\n");
    // The canonical guidance, not the unverified notice — availability is no
    // longer swallowed into SESSION_UNVERIFIED_NOTICE.
    expect(out).toContain("not reachable");
    expect(out).toContain("http://api.test");
    expect(out).not.toContain(SESSION_UNVERIFIED_NOTICE);
    // Foreground actions were gated: notice per action, no request issued.
    expect(client.chat).not.toHaveBeenCalled();
    expect(out.match(/not reachable/g)!.length).toBeGreaterThanOrEqual(3); // guidance + two notices
  });

  it("offline :quit prints the notice and exits the loop without issuing the request", async () => {
    const client = stubClient({
      startSession: vi.fn(async () => {
        throw new EngineUnavailableError("http://api.test", "reject");
      }),
    });
    const script = scriptedIO([":quit", "never-read"]);

    const code = await runRepl(client, () => script.io, {
      probeSleep: () => new Promise<never>(() => {}),
    });

    expect(code).toBe(0);
    expect(client.quit).not.toHaveBeenCalled();
    expect(script.prompts).toBe(1);
  });

  it("driving scenario: a REPL started before the engine recovers a chat turn without restart", async () => {
    // One fake fetch driven from rejecting to serving —
    // the real ApiClient, the real tracker, the real wiring.
    const engine = { up: false };
    const hits: string[] = [];
    const fetchFn: FetchFn = async (input, init) => {
      const path = new URL(input).pathname;
      hits.push(path);
      if (!engine.up) throw new TypeError("fetch failed");
      const body = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status });
      if (path === "/api/health") {
        return body({ status: "ok", engine: "habenula-engine", version: "0.0.0" });
      }
      if (path === "/api/session/start") {
        return body({ status: "started", activeSession: VIEW });
      }
      // chat + status now drive the trusted internal MCP interface
      // SSE-framed JSON-RPC tool results.
      if (path === "/internal/mcp") {
        const name = toolNameOf(init?.body);
        if (name === "send") {
          return new Response(
            sseToolResult({
              response: "hi from the engine",
              toolCalls: [],
              iterations: 1,
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
            { status: 200 },
          );
        }
        return new Response(
          sseToolResult({ session: null, grants: [], held: [] }),
          { status: 200 },
        );
      }
      if (path === "/api/services") {
        return body({ services: [{ service: "mock_email", connected_at: "2026-07-01" }] });
      }
      if (path === "/api/policy") {
        return body({ effectiveDecision: "deny", entries: [] });
      }
      return body({ error: "Not found" }, 404);
    };
    const client = new ApiClient(
      { apiUrl: "http://api.test", userId: "u", humanTouch: false },
      fetchFn,
    );

    // Manual IO: the test emits lines by hand so recovery happens while idle.
    let onLine: (line: string) => void = () => {};
    let onClose: () => void = () => {};
    const io: ReplIO = {
      onLine: (cb) => {
        onLine = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
      onSigint: () => {},
      setPrompt: () => {},
      showPrompt: () => {},
      currentLine: () => "",
      eraseInputLine: () => {},
      restoreInput: () => {},
      write: () => {},
      deferPoll: () => false,
      setStatus: () => {},
      close: () => {},
    };
    // Gated probe sleep: the test fires each probe interval by hand.
    let pendingProbe: (() => void) | null = null;
    const probeSleep = (): Promise<void> =>
      new Promise<void>((r) => {
        pendingProbe = r;
      });
    const flushUntil = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !cond(); i += 1) {
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    const done = runRepl(client, () => io, { poll: false, probeSleep });
    await flushUntil(() => logs.some((l) => l.includes("not reachable")));

    // Offline: a foreground chat is gated — nothing hit the internal drive.
    onLine("hello early");
    await flushUntil(() => logs.filter((l) => l.includes("not reachable")).length >= 2);
    expect(hits).not.toContain("/internal/mcp");

    // The engine comes up; the next probe tick recovers via the handshake.
    engine.up = true;
    await flushUntil(() => pendingProbe !== null);
    pendingProbe!();
    await flushUntil(() => logs.some((l) => l.includes("Engine connected.")));
    expect(hits).toContain("/api/health");
    expect(hits.filter((h) => h === "/api/session/start").length).toBeGreaterThanOrEqual(2);

    // A chat turn now goes through — same REPL, no restart.
    onLine("hello there");
    await flushUntil(() => logs.some((l) => l.includes("hi from the engine")));
    expect(logs.join("\n")).toContain("hi from the engine");

    onClose();
    const code = await done;
    expect(code).toBe(0);
  });

  it("the deferred first-run nudge fires once across repeated recoveries, never again (the wiring once-guard)", async () => {
    // The `nudged` guard lives in the chat.ts wiring, not EngineState, so it is
    // only exercised end-to-end: a REPL booted offline, recovered, knocked
    // offline again, then recovered a SECOND time must print the deferred tip
    // exactly once. Stubbed at the fetch level like the driving scenario, but
    // with NO connected services + a deny policy so the nudge condition holds.
    const engine = { up: false };
    const fetchFn: FetchFn = async (input) => {
      const path = new URL(input).pathname;
      if (!engine.up) throw new TypeError("fetch failed");
      const body = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status });
      if (path === "/api/health") return body({ status: "ok", engine: "habenula-engine" });
      if (path === "/api/session/start") return body({ status: "started", activeSession: VIEW });
      if (path === "/api/chat") {
        return body({
          response: "ok",
          toolCalls: [],
          iterations: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
      if (path === "/api/services") return body({ services: [] }); // none → nudge armed
      if (path === "/api/policy") return body({ effectiveDecision: "deny", entries: [] });
      return body({ error: "Not found" }, 404);
    };
    const client = new ApiClient(
      { apiUrl: "http://api.test", userId: "u", humanTouch: false },
      fetchFn,
    );

    let onLine: (line: string) => void = () => {};
    let onClose: () => void = () => {};
    const io: ReplIO = {
      onLine: (cb) => {
        onLine = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
      onSigint: () => {},
      setPrompt: () => {},
      showPrompt: () => {},
      currentLine: () => "",
      eraseInputLine: () => {},
      restoreInput: () => {},
      write: () => {},
      deferPoll: () => false,
      setStatus: () => {},
      close: () => {},
    };
    let pendingProbe: (() => void) | null = null;
    const probeSleep = (): Promise<void> =>
      new Promise<void>((r) => {
        pendingProbe = r;
      });
    const flushUntil = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !cond(); i += 1) {
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const tips = (): number => logs.filter((l) => l.includes("Tip: try")).length;
    const fireProbe = async (): Promise<void> => {
      await flushUntil(() => pendingProbe !== null);
      const resolve = pendingProbe!;
      pendingProbe = null;
      resolve();
    };

    const done = runRepl(client, () => io, { poll: false, probeSleep });
    // Boot offline: guidance printed, nudge deferred (not yet fired).
    await flushUntil(() => logs.some((l) => l.includes("not reachable")));
    expect(tips()).toBe(0);

    // First recovery: the deferred tip fires exactly once.
    engine.up = true;
    await fireProbe();
    await flushUntil(() => logs.filter((l) => l.includes("Engine connected.")).length >= 1);
    expect(tips()).toBe(1);

    // Knock it offline again via a foreground turn, then recover a second time.
    engine.up = false;
    onLine("do something");
    await flushUntil(() => logs.filter((l) => l.includes("not reachable")).length >= 2);
    engine.up = true;
    await fireProbe();
    await flushUntil(() => logs.filter((l) => l.includes("Engine connected.")).length >= 2);

    // The guard held: the second recovery did NOT re-nudge.
    expect(tips()).toBe(1);

    onClose();
    expect(await done).toBe(0);
  });

  it("SIGINT during an in-flight chat turn is a no-op — the turn finishes and the session survives", async () => {
    // A chat turn is not cancelable, and nothing else is pending, so Ctrl-C mid-
    // turn must NOT detach: it would drop the user out of the session (and could
    // swallow a confirmation the turn is about to raise). It prints a hint and
    // the turn runs to completion.
    let releaseFirstTurn: (v: unknown) => void = () => {};
    const chat = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirstTurn = resolve)),
      )
      .mockResolvedValue({
        response: "ok",
        toolCalls: [],
        iterations: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const client = stubClient({ chat });
    const script = scriptedIO(["hello", "hello again", ":exit"]);

    const runP = runRepl(client, () => script.io);
    // Let the handshake, nudge, and first dispatch drain so the chat turn is
    // genuinely in flight, then fire Ctrl-C.
    await new Promise((r) => setTimeout(r, 0));
    script.fireSigint();
    releaseFirstTurn({
      response: "ok",
      toolCalls: [],
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const code = await runP;

    expect(code).toBe(0);
    // The REPL did not detach: the next queued line still dispatched.
    expect(chat).toHaveBeenCalledWith("hello again");
    expect(client.quit).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("a turn is in progress");
  });

  it(":clear writes the clear-screen + scrollback sequence on a TTY", async () => {
    const client = stubClient();
    const writes: string[] = [];
    const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const { io } = scriptedIO([":clear", ":exit"]);
      await runRepl(client, () => io, { poll: false });
      // `\x1b[2J` clear screen, `\x1b[3J` clear scrollback, `\x1b[H` home cursor.
      expect(writes.some((w) => w.includes("\x1b[2J\x1b[3J\x1b[H"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  });

 it(":clear repopulates the banner header after clearing the screen", async () => {
    const client = stubClient();
    const writes: string[] = [];
    const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    // Narrow width → renderBanner degrades to the literal "HABENULA" wordmark,
    // so the assertion is independent of the block-glyph layout.
    Object.defineProperty(process.stdout, "columns", { value: 10, configurable: true });
    try {
      const { io } = scriptedIO([":clear", ":exit"]);
      await runRepl(client, () => io, { poll: false });
      // The clear-screen escape is written directly to stdout…
      expect(writes.some((w) => w.includes("\x1b[2J\x1b[3J\x1b[H"))).toBe(true);
      // …and the banner (via console.log) now appears TWICE — once at boot, once
      // repopulated by :clear. A single boot banner would give exactly one.
      const banners = logs.filter((l) => l.includes("HABENULA")).length;
      expect(banners).toBeGreaterThanOrEqual(2);
    } finally {
      writeSpy.mockRestore();
      if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
      if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    }
  });

  it(":clear writes no clear sequence when stdout is not a TTY", async () => {
    const client = stubClient();
    const writes: string[] = [];
    const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      const { io } = scriptedIO([":clear", ":exit"]);
      await runRepl(client, () => io, { poll: false });
      expect(writes.some((w) => w.includes("\x1b[2J"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
      if (origIsTTY) Object.defineProperty(process.stdout, "isTTY", origIsTTY);
    }
  });
});
