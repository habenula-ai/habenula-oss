import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiError, EngineUnavailableError, type FetchFn } from "../../src/api-client";
import { runKill, KILL_RETRY_INTERVAL_MS, KILL_RETRY_WINDOW_MS } from "../../src/commands/kill";

const CONFIG = { apiUrl: "http://api.test", userId: "u", humanTouch: false };

/** An injected clock: each sleep advances it by the slept interval, so the
 * retry window burns deterministically with no real waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("runKill", () => {
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    vi.spyOn(console, "error").mockImplementation((m) => {
      errs.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the kill switch and reports success without reading a disconnected list", async () => {
    const calls: string[] = [];
    // The server response carries only { killed: true } now. runKill must not
    // read result.disconnected — doing so would throw on undefined.length.
    const fetchFn: FetchFn = async (input) => {
      calls.push(input);
      return new Response(JSON.stringify({ killed: true }), { status: 200 });
    };
    const client = new ApiClient(CONFIG, fetchFn);

    const exitCode = await runKill(client);

    expect(exitCode).toBe(0);
    expect(calls[0]).toBe("http://api.test/api/kill");
    // Reassures the user connections survive a kill.
    expect(logs.join("\n")).toContain("preserved");
  });

 it("retries across an unavailable stretch and lands the moment the engine is back", async () => {
    // Reject-then-serve: the engine is mid-restart for the first two
    // attempts, then comes back — the kill lands within the window.
    let attempts = 0;
    const fetchFn: FetchFn = async () => {
      attempts += 1;
      if (attempts <= 2) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ killed: true }), { status: 200 });
    };
    const client = new ApiClient(CONFIG, fetchFn);
    const clock = fakeClock();

    const exitCode = await runKill(client, clock);

    expect(exitCode).toBe(0);
    expect(attempts).toBe(3);
    // The transient retry status goes to stderr, without an `error:` prefix —
    // a kill that lands after a restart must not have emitted a terminal error.
    const err = errs.join("\n");
    expect(err).toContain("Retrying kill");
    expect(err).not.toContain("error:");
    // The landing report is stdout; the transient status never lands there.
    expect(logs.join("\n")).toContain("Kill switch activated");
    expect(logs.join("\n")).not.toContain("Retrying kill");
  });

  it("emits the retry notice once per failure-kind run, re-emitting only when the kind flips", async () => {
    // Stubbed `kill()` rather than a fetchFn: the notice's dedup keys on the
    // availability KIND, and forcing a `deadline` through the real request
    // core would couple this to its timer. The sequence is reject×2 →
    // deadline×2 → success, so the notice must render exactly twice — once
    // for the reject run, once when it flips to deadline.
    const kinds = ["reject", "reject", "deadline", "deadline"] as const;
    let i = 0;
    const client = {
      kill: async () => {
        const kind = kinds[i++];
        if (kind) throw new EngineUnavailableError(CONFIG.apiUrl, kind);
        return { killed: true };
      },
    } as unknown as ApiClient;

    const exitCode = await runKill(client, fakeClock());

    expect(exitCode).toBe(0);
    const notices = errs.filter((e) => e.includes("Retrying kill"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("not reachable");
    expect(notices[1]).toContain("not responding");
  });

  it("rethrows the availability error once the retry window elapses (wrap exits 2)", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new ApiClient(CONFIG, fetchFn);
    const clock = fakeClock();

    await expect(runKill(client, clock)).rejects.toBeInstanceOf(EngineUnavailableError);
    // The window was actually honored: the clock ran to (at least) the bound.
    expect(clock.now()).toBeGreaterThanOrEqual(KILL_RETRY_WINDOW_MS);
    expect(logs.join("\n")).not.toContain("Kill switch activated");
  });

  it("does not retry a reachable-engine ApiError — it surfaces immediately", async () => {
    let attempts = 0;
    const fetchFn: FetchFn = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    };
    const client = new ApiClient(CONFIG, fetchFn);

    await expect(runKill(client, fakeClock())).rejects.toBeInstanceOf(ApiError);
    expect(attempts).toBe(1);
  });

 it("gives up when the cancel signal aborts mid-retry — no further attempt, rethrows the last availability error", async () => {
    // Abort fires during the first retry sleep: the kill must stop retrying
    // (not run to the 30s window) and rethrow the availability error so the
    // REPL's dispatch catch can route it to the engine tracker.
    let attempts = 0;
    const fetchFn: FetchFn = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };
    const client = new ApiClient(CONFIG, fetchFn);
    const controller = new AbortController();
    const t = 0;

    await expect(
      runKill(client, {
        now: () => t,
        // The retry sleep never resolves on its own; only the abort ends it —
        // proving the give-up races the signal rather than waiting the window.
        sleep: () =>
          new Promise<void>(() => {
            controller.abort();
          }),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(EngineUnavailableError);

    // Exactly one attempt: the abort stopped the loop before it retried, and
    // the clock never advanced anywhere near the window.
    expect(attempts).toBe(1);
    expect(t).toBe(0);
    expect(logs.join("\n")).not.toContain("Kill switch activated");
  });

  it("retries on the source-constant interval", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const fetchFn: FetchFn = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ killed: true }), { status: 200 });
    };
    const client = new ApiClient(CONFIG, fetchFn);
    let t = 0;
    await runKill(client, {
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    expect(slept).toEqual([KILL_RETRY_INTERVAL_MS]);
  });
});
