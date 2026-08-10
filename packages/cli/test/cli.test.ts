import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildRunners,
  createProgram,
  runConnectStandalone,
  runWalkStandalone,
  type CliRunners,
} from "../src/index";
import { ApiClient, type FetchFn } from "../src/api-client";
import { EXIT_CANCELLED, type RunConnectOptions } from "../src/commands/connect";
import { EXIT_BROKEN_CHAIN, EXIT_CONFLICTED_CLOSER } from "../src/audit/walk";
import { runKill, KILL_RETRY_WINDOW_MS } from "../src/commands/kill";

type RunConnectFn = (
  client: ApiClient,
  service: string | undefined,
  opts?: RunConnectOptions,
) => Promise<number>;

const FAKE_CLIENT = {} as ApiClient;

function makeRunners() {
  const calls: { command: string; args: unknown[] }[] = [];
  const runners: CliRunners = {
    chat: async () => { calls.push({ command: "chat", args: [] }); return 0; },
    up: async () => { calls.push({ command: "up", args: [] }); return 0; },
    down: async () => { calls.push({ command: "down", args: [] }); return 0; },
    connect: async (service) => { calls.push({ command: "connect", args: [service] }); return 0; },
    disconnect: async (service) => { calls.push({ command: "disconnect", args: [service] }); return 0; },
    status: async () => { calls.push({ command: "status", args: [] }); return 0; },
    kill: async () => { calls.push({ command: "kill", args: [] }); return 0; },
    quit: async () => { calls.push({ command: "quit", args: [] }); return 0; },
    policyList: async () => { calls.push({ command: "policyList", args: [] }); return 0; },
    cap: async (opts) => { calls.push({ command: "cap", args: [opts] }); return 0; },
    taskList: async () => { calls.push({ command: "taskList", args: [] }); return 0; },
    taskShow: async (id) => { calls.push({ command: "taskShow", args: [id] }); return 0; },
    taskCancel: async (id) => { calls.push({ command: "taskCancel", args: [id] }); return 0; },
    taskWatch: async () => { calls.push({ command: "taskWatch", args: [] }); return 0; },
    log: async (opts) => { calls.push({ command: "log", args: [opts] }); return 0; },
    logDump: async (path) => { calls.push({ command: "logDump", args: [path] }); return 0; },
    logVerify: async (opts) => { calls.push({ command: "logVerify", args: [opts] }); return 0; },
  };
  return { runners, calls };
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
});

describe("createProgram", () => {
  it("routes no args to chat", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync([], { from: "user" });
    expect(calls).toEqual([{ command: "chat", args: [] }]);
  });

  it("routes 'chat' to chat", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["chat"], { from: "user" });
    expect(calls).toEqual([{ command: "chat", args: [] }]);
  });

  it("routes 'up' as a plain top-level command with no options", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["up"], { from: "user" });
    expect(calls).toEqual([{ command: "up", args: [] }]);
  });

  it("propagates up's exit 2 (spawned, not answering yet) through wrap", async () => {
    const { runners } = makeRunners();
    runners.up = async () => 2;
    const program = createProgram(runners);
    await program.parseAsync(["up"], { from: "user" });
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("routes 'down' as a plain top-level command with no options", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["down"], { from: "user" });
    expect(calls).toEqual([{ command: "down", args: [] }]);
  });

  it("routes 'status'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["status"], { from: "user" });
    expect(calls).toEqual([{ command: "status", args: [] }]);
  });

  it("routes 'kill'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["kill"], { from: "user" });
    expect(calls).toEqual([{ command: "kill", args: [] }]);
  });

  it("routes 'quit' — top-level so a stuck slot is freeable without entering the REPL", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["quit"], { from: "user" });
    expect(calls).toEqual([{ command: "quit", args: [] }]);
  });

  it("routes 'policy list'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["policy", "list"], { from: "user" });
    expect(calls).toEqual([{ command: "policyList", args: [] }]);
  });

  it("routes 'cap' bare (read) and with dollar flags parsed to cents", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["cap"], { from: "user" });
    await program.parseAsync(["cap", "--monthly", "50", "--session", "12.50"], {
      from: "user",
    });
    expect(calls).toEqual([
      { command: "cap", args: [{}] },
      { command: "cap", args: [{ monthlyCents: 5000, sessionCents: 1250 }] },
    ]);
  });

  it("cap: rejects non-dollar values at parse, before the runner runs", async () => {
    const { runners, calls } = makeRunners();
    // Every rejection class the parser guards: non-numeric, negative,
    // 3-decimal (a lost fraction of a cent), scientific/hex (not plain
    // decimal), whitespace-padded, empty, over the $1M ceiling, bare ".5".
    for (const bad of ["abc", "-5", "12.345", "1e5", "0x10", " 50", "", "1000001", ".5"]) {
      const program = createProgram(runners).exitOverride();
      program.configureOutput({ writeErr: () => {} });
      await expect(
        program.parseAsync(["cap", "--monthly", bad], { from: "user" }),
      ).rejects.toThrow(/dollar amount/);
    }
    expect(calls).toEqual([]);
  });

  it("cap: accepts the boundary values — exactly $1M, single-decimal, and $0", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["cap", "--monthly", "1000000"], { from: "user" });
    await program.parseAsync(["cap", "--session", "12.5"], { from: "user" });
    await program.parseAsync(["cap", "--session", "0"], { from: "user" });
    expect(calls).toEqual([
      { command: "cap", args: [{ monthlyCents: 100_000_000 }] },
      { command: "cap", args: [{ sessionCents: 1250 }] },
      { command: "cap", args: [{ sessionCents: 0 }] },
    ]);
  });

  it("routes 'task list'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["task", "list"], { from: "user" });
    expect(calls).toEqual([{ command: "taskList", args: [] }]);
  });

  it("routes 'task show <id>' with the id argument", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["task", "show", "task-abc"], { from: "user" });
    expect(calls).toEqual([{ command: "taskShow", args: ["task-abc"] }]);
  });

  it("routes 'task cancel <id>' with the id argument", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["task", "cancel", "task-xyz"], { from: "user" });
    expect(calls).toEqual([{ command: "taskCancel", args: ["task-xyz"] }]);
  });

  it("routes 'task watch'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["task", "watch"], { from: "user" });
    expect(calls).toEqual([{ command: "taskWatch", args: [] }]);
  });

  it("routes 'connect mock_email' and 'connect gmail'", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["connect", "mock_email"], { from: "user" });
    expect(calls).toEqual([{ command: "connect", args: ["mock_email"] }]);
  });

  it("routes 'disconnect' with any service name", async () => {
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["disconnect", "email"], { from: "user" });
    expect(calls).toEqual([{ command: "disconnect", args: ["email"] }]);
  });

  it("routes 'connect' with any service name (catalog is validated server-side)", async () => {
    // The command no longer rejects names client-side; the connect entry
    // validates against the catalog and the runner surfaces any error.
    const { runners, calls } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["connect", "slack"], { from: "user" });
    expect(calls).toEqual([{ command: "connect", args: ["slack"] }]);
  });

  it("passes --timeout through to the connect runner in seconds", async () => {
    const { runners, calls } = makeRunners();
    runners.connect = async (service, timeoutSeconds) => {
      calls.push({ command: "connect", args: [service, timeoutSeconds] });
      return 0;
    };
    const program = createProgram(runners);
    await program.parseAsync(["connect", "gmail", "--timeout", "30"], { from: "user" });
    expect(calls).toEqual([{ command: "connect", args: ["gmail", 30] }]);
  });

  it("rejects a non-positive, non-integer, or absurdly large --timeout at parse, before the runner runs", async () => {
    const { runners, calls } = makeRunners();
    // The last value is past MAX_TIMEOUT_SECONDS and would lose precision as a
    // Number — rejected rather than silently becoming a nonsense timeout.
    for (const bad of ["0", "-5", "2.5", "abc", "1e5", "999999999999999999999"]) {
      const program = createProgram(runners).exitOverride();
      program.configureOutput({ writeErr: () => {} });
      await expect(
        program.parseAsync(["connect", "gmail", "--timeout", bad], { from: "user" }),
      ).rejects.toThrow(/positive integer/);
    }
    expect(calls).toEqual([]);
  });

  it("propagates a runner's non-zero return as the process exit code", async () => {
    // A runner that reports failure by returning a non-zero code (e.g.
    // runConnect on an unknown service or a poll timeout) must exit non-zero,
    // not fall through to exit 0. Guards against `wrap` dropping the code.
    const { runners } = makeRunners();
    runners.connect = async () => 1;
    const program = createProgram(runners);
    await program.parseAsync(["connect", "gmial"], { from: "user" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit when a runner returns 0", async () => {
    const { runners } = makeRunners();
    const program = createProgram(runners);
    await program.parseAsync(["connect", "mock_email"], { from: "user" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

});

describe("exit-code contract", () => {
  const rejectingFetch: FetchFn = async () => {
    throw new TypeError("fetch failed");
  };

  function rejectingClient(): ApiClient {
    return new ApiClient(
      { apiUrl: "http://api.test", userId: "u", humanTouch: false },
      rejectingFetch,
    );
  }

  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // One test per one-shot command class, asserting exit code 2 SPECIFICALLY
  // (not just the message): the guard against a runner catching the
  // availability error into a returned exit-1 code. These drive the
  // REAL runners via buildRunners against a rejecting fetch.
  const oneShots: [string, string[]][] = [
    ["status", ["status"]],
    ["quit", ["quit"]],
    ["disconnect", ["disconnect", "mock_email"]],
    ["policy list", ["policy", "list"]],
    ["cap", ["cap"]],
    ["connect (initial request)", ["connect", "mock_email"]],
    ["log", ["log"]],
    ["log verify", ["log", "verify"]],
  ];

  for (const [name, argv] of oneShots) {
    it(`${name} against a dead engine prints the guidance and exits 2`, async () => {
      const runners = buildRunners(rejectingClient(), async () => true);
      const program = createProgram(runners);

      await program.parseAsync(argv, { from: "user" });

      expect(exitSpy).toHaveBeenCalledWith(2);
      const written = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(written).toContain("not reachable");
      expect(written).toContain("http://api.test");
    });
  }

  it("kill exits 2 once its bounded retry window elapses against a dead engine", async () => {
    // The real runKill with an injected clock that burns the window without
    // real sleeps — kill is the one one-shot that retries before exit 2.
    const client = rejectingClient();
    let t = 0;
    const runners = buildRunners(client, async () => true);
    runners.kill = () =>
      runKill(client, {
        sleep: async () => {
          t += KILL_RETRY_WINDOW_MS / 4;
        },
        now: () => t,
      });
    const program = createProgram(runners);

    await program.parseAsync(["kill"], { from: "user" });

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("reserves exit 2: commander usage errors exit 1, --help/--version exit 0", async () => {
    // Exit 2 is a documented public contract; a commander bump that changed
    // its parse-error or help/version codes would silently break it, so this
    // pins them (pinned commander@14.0.3).
    // exitOverride/configureOutput are per-command in commander — apply them
    // down the subcommand tree so an option error inside `connect` or
    // `policy list` throws instead of exiting.
    type CommandLike = {
      exitOverride(): CommandLike;
      configureOutput(cfg: { writeOut(s: string): void; writeErr(s: string): void }): CommandLike;
      commands: readonly CommandLike[];
    };
    const silence = (cmd: CommandLike): void => {
      cmd.exitOverride();
      cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      for (const sub of cmd.commands) silence(sub);
    };
    const make = () => {
      const program = createProgram(makeRunners().runners);
      silence(program as unknown as CommandLike);
      return program;
    };

    await expect(make().parseAsync(["nosuchcommand"], { from: "user" })).rejects.toMatchObject({
      exitCode: 1,
    });
    await expect(
      make().parseAsync(["connect", "--bogus-option"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 1 });
    await expect(make().parseAsync(["--help"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });
    await expect(make().parseAsync(["--version"], { from: "user" })).rejects.toMatchObject({
      exitCode: 0,
    });
  });
});

describe("runConnectStandalone", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
  });

  /**
   * Spy on the SIGINT install/teardown, capturing the registered handler so a
   * test can drive Ctrl-C directly — without emitting a real process SIGINT
   * (which would also trip vitest's own signal handling). Both spies are
   * restored via `stop()` in a `finally` so they can't leak into other tests.
   */
  function trapSigint() {
    const handlers: (() => void)[] = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((event: string, cb: () => void) => {
        if (event === "SIGINT") handlers.push(cb);
        return process;
      }) as typeof process.on);
    const offSpy = vi
      .spyOn(process, "removeListener")
      .mockImplementation((() => process) as typeof process.removeListener);
    return {
      handlers,
      onSpy,
      offSpy,
      stop: () => {
        onSpy.mockRestore();
        offSpy.mockRestore();
      },
    };
  }

  it("installs one SIGINT handler for the wait, then removes that same handler", async () => {
    const trap = trapSigint();
    try {
      let duringCount = -1;
      const run: RunConnectFn = async () => {
        duringCount = trap.handlers.length; // handler present during the wait
        return 0;
      };

      const code = await runConnectStandalone(FAKE_CLIENT, "gmail", undefined, run);

      expect(code).toBe(0);
      expect(duringCount).toBe(1);
      expect(trap.offSpy).toHaveBeenCalledWith("SIGINT", trap.handlers[0]);
    } finally {
      trap.stop();
    }
  });

  it("removes the SIGINT handler even when the wait throws", async () => {
    const trap = trapSigint();
    try {
      const run: RunConnectFn = async () => {
        throw new Error("wait blew up");
      };

      await expect(
        runConnectStandalone(FAKE_CLIENT, "gmail", undefined, run),
      ).rejects.toThrow("wait blew up");
      expect(trap.offSpy).toHaveBeenCalledWith("SIGINT", trap.handlers[0]);
    } finally {
      trap.stop();
    }
  });

  it("converts --timeout seconds to milliseconds and injects a cancel signal", async () => {
    let seen: RunConnectOptions | undefined;
    const run: RunConnectFn = async (_client, _service, opts) => {
      seen = opts;
      return 0;
    };

    await runConnectStandalone(FAKE_CLIENT, "gmail", 30, run);
    expect(seen?.timeoutMs).toBe(30_000);
    expect(seen?.cancelSignal).toBeInstanceOf(AbortSignal);
  });

  it("omits timeoutMs when no --timeout was given", async () => {
    let seen: RunConnectOptions | undefined;
    const run: RunConnectFn = async (_client, _service, opts) => {
      seen = opts;
      return 0;
    };

    await runConnectStandalone(FAKE_CLIENT, "gmail", undefined, run);
    expect(seen?.timeoutMs).toBeUndefined();
    expect(seen?.cancelSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the injected signal on the first SIGINT and force-exits on the second", async () => {
    const trap = trapSigint();
    try {
      const run: RunConnectFn = async (_client, _service, opts) => {
        const signal = opts?.cancelSignal;
        expect(signal?.aborted).toBe(false);
        trap.handlers[0]?.(); // first Ctrl-C → aborts the injected signal
        expect(signal?.aborted).toBe(true);
        trap.handlers[0]?.(); // second Ctrl-C → force-exit
        return 0;
      };

      await runConnectStandalone(FAKE_CLIENT, "gmail", undefined, run);
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CANCELLED);
    } finally {
      trap.stop();
    }
  });
});

describe("runWalkStandalone (the log dump / log verify SIGINT wiring)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
  });

  function trapSigint() {
    const handlers: (() => void)[] = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((event: string, cb: () => void) => {
        if (event === "SIGINT") handlers.push(cb);
        return process;
      }) as typeof process.on);
    const offSpy = vi
      .spyOn(process, "removeListener")
      .mockImplementation((() => process) as typeof process.removeListener);
    return {
      handlers,
      onSpy,
      offSpy,
      stop: () => {
        onSpy.mockRestore();
        offSpy.mockRestore();
      },
    };
  }

  it("installs one SIGINT handler for the walk, then removes that same handler", async () => {
    const trap = trapSigint();
    try {
      let duringCount = -1;
      const code = await runWalkStandalone(async () => {
        duringCount = trap.handlers.length;
        return 0;
      });
      expect(code).toBe(0);
      expect(duringCount).toBe(1);
      expect(trap.offSpy).toHaveBeenCalledWith("SIGINT", trap.handlers[0]);
    } finally {
      trap.stop();
    }
  });

  it("removes the SIGINT handler even when the walk throws", async () => {
    const trap = trapSigint();
    try {
      await expect(
        runWalkStandalone(async () => {
          throw new Error("walk blew up");
        }),
      ).rejects.toThrow("walk blew up");
      expect(trap.offSpy).toHaveBeenCalledWith("SIGINT", trap.handlers[0]);
    } finally {
      trap.stop();
    }
  });

  it("first Ctrl-C aborts the injected signal; the runner returns its own code", async () => {
    const trap = trapSigint();
    try {
      const code = await runWalkStandalone(async ({ cancelSignal }) => {
        expect(cancelSignal.aborted).toBe(false);
        trap.handlers[0]?.();
        expect(cancelSignal.aborted).toBe(true);
        return EXIT_CANCELLED; // the runner RETURNS 130; no exit from the handler
      });
      expect(code).toBe(EXIT_CANCELLED);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      trap.stop();
    }
  });

  it("second Ctrl-C force-exits 130 when no break was found", async () => {
    const trap = trapSigint();
    try {
      await runWalkStandalone(async () => {
        trap.handlers[0]?.();
        trap.handlers[0]?.();
        return 0;
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CANCELLED);
    } finally {
      trap.stop();
    }
  });

  it("second Ctrl-C force-exits 3 once onBreakFound raised the flag — a located break outranks the escape hatch", async () => {
    // This path bypasses summarizeWalk entirely (it runs inside the signal
    // handler), so no other test reaches it.
    const trap = trapSigint();
    try {
      await runWalkStandalone(async ({ onBreakFound }) => {
        onBreakFound();
        trap.handlers[0]?.();
        trap.handlers[0]?.();
        return EXIT_BROKEN_CHAIN;
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_BROKEN_CHAIN);
      expect(exitSpy).not.toHaveBeenCalledWith(EXIT_CANCELLED);
    } finally {
      trap.stop();
    }
  });

  // The three cases below mirror summarizeWalk's ladder BY HAND, because the
  // handler cannot call the summarizer — they are the regression guard for
  // the second place the precedence is written.

  it("second Ctrl-C force-exits 5 once onConflictFound raised the flag — a located conflict outranks the escape hatch", async () => {
    const trap = trapSigint();
    try {
      await runWalkStandalone(async ({ onConflictFound }) => {
        onConflictFound();
        trap.handlers[0]?.();
        trap.handlers[0]?.();
        return EXIT_CONFLICTED_CLOSER;
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CONFLICTED_CLOSER);
      expect(exitSpy).not.toHaveBeenCalledWith(EXIT_CANCELLED);
    } finally {
      trap.stop();
    }
  });

  it("second Ctrl-C force-exits 3, never 5, when both flags are up — integrity outranks semantics", async () => {
    const trap = trapSigint();
    try {
      await runWalkStandalone(async ({ onBreakFound, onConflictFound }) => {
        onConflictFound();
        onBreakFound();
        trap.handlers[0]?.();
        trap.handlers[0]?.();
        return EXIT_BROKEN_CHAIN;
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_BROKEN_CHAIN);
      expect(exitSpy).not.toHaveBeenCalledWith(EXIT_CONFLICTED_CLOSER);
    } finally {
      trap.stop();
    }
  });

  it("second Ctrl-C still force-exits 130 with neither flag up", async () => {
    const trap = trapSigint();
    try {
      await runWalkStandalone(async () => {
        trap.handlers[0]?.();
        trap.handlers[0]?.();
        return 0;
      });
      expect(exitSpy).toHaveBeenCalledWith(EXIT_CANCELLED);
      expect(exitSpy).not.toHaveBeenCalledWith(EXIT_CONFLICTED_CLOSER);
      expect(exitSpy).not.toHaveBeenCalledWith(EXIT_BROKEN_CHAIN);
    } finally {
      trap.stop();
    }
  });
});
