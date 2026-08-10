import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import { runConnect, EXIT_CANCELLED } from "../../src/commands/connect";

interface FakeState {
  services: { service: string; connected_at: string }[];
  /** The connectable set `/api/services/catalog` serves. */
  catalog?: string[];
  /** Scripted `/api/connect/status` responder (per-call). */
  flowStatus?: () => { status: number; body: unknown };
  /** Response for `/api/connect/cancel` (default 200 `{ cancelled: true }`). */
  cancelResponse?: { status: number; body: unknown };
  /** Every cancel POST body, recorded. */
  cancels: unknown[];
  /** Whether each cancel POST carried an abort signal (the cleanup bound). */
  cancelSignals: boolean[];
  /** Every status-read URL, recorded for param assertions. */
  statusReads: URL[];
  /** Whether each status read carried a signal (the per-read bound + cancel arm). */
  statusSignals: boolean[];
  /** Whether the opening `POST /connect/{service}` carried a cancel signal. */
  connectSignals: boolean[];
}

function emptyState(overrides?: Partial<FakeState>): FakeState {
  return {
    services: [],
    cancels: [],
    cancelSignals: [],
    statusReads: [],
    statusSignals: [],
    connectSignals: [],
    ...overrides,
  };
}

/**
 * Fake Worker: `connectHandler` decides the `POST /connect/{service}` response
 * (authorize URL + flow, direct connect, or an error); `/api/connect/status`
 * serves the scripted flow status the wait loop polls; `/api/connect/cancel`
 * records the abandon; `/api/services/catalog` enumerates `state.catalog`.
 */
function makeClient(
  state: FakeState,
  connectHandler: (service: string) => { status: number; body: unknown },
): ApiClient {
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.startsWith("/connect/")) {
      const service = decodeURIComponent(url.pathname.slice("/connect/".length));
      state.connectSignals.push(init?.signal !== undefined);
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { status, body } = connectHandler(service);
      return new Response(JSON.stringify(body), { status });
    }
    if (url.pathname === "/api/connect/status") {
      state.statusReads.push(url);
      state.statusSignals.push(init?.signal !== undefined);
      const { status, body } = state.flowStatus
        ? state.flowStatus()
        : { status: 200, body: { status: "pending" } };
      return new Response(JSON.stringify(body), { status });
    }
    if (url.pathname === "/api/connect/cancel") {
      state.cancels.push(JSON.parse(init?.body ?? "{}"));
      state.cancelSignals.push(init?.signal !== undefined);
      const { status, body } = state.cancelResponse ?? {
        status: 200,
        body: { cancelled: true },
      };
      return new Response(JSON.stringify(body), { status });
    }
    if (url.pathname === "/api/services/catalog") {
      const services = (state.catalog ?? []).map((service) => ({ service }));
      return new Response(JSON.stringify({ services }), { status: 200 });
    }
    if (url.pathname === "/api/services") {
      return new Response(JSON.stringify({ services: state.services }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), {
      status: 400,
    });
  };
  return new ApiClient({ apiUrl: "http://api.test", userId: "u", humanTouch: false }, fetchFn);
}

/** Script a sequence of flow statuses, repeating the last one. */
function statusScript(state: FakeState, sequence: string[]): void {
  let i = 0;
  state.flowStatus = () => {
    const status = sequence[Math.min(i, sequence.length - 1)]!;
    i++;
    return { status: 200, body: { status } };
  };
}

describe("runConnect", () => {
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

  it("opens the authorize URL, polls the flow status, and returns 0 on connected", async () => {
    const state = emptyState();
    statusScript(state, ["pending", "pending", "connected"]);
    const authorizeUrl = "http://api.test/oauth/mock_email/authorize?state=u:abc";
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl, flow: "flow-1" },
    }));

    const opened: string[] = [];
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: (url) => opened.push(url),
      sleep: async () => {},
      now: () => 0, // Frozen time so we never time out.
    });

    // The browser opens the provider authorize URL the entry returned.
    expect(opened).toEqual([authorizeUrl]);
    expect(exitCode).toBe(0);
    // The wait polled the per-flow status with the service + flow handle.
    expect(state.statusReads.length).toBe(3);
    expect(state.statusReads[0]!.searchParams.get("service")).toBe("mock_email");
    expect(state.statusReads[0]!.searchParams.get("flow")).toBe("flow-1");
    // A successful connect abandons nothing.
    expect(state.cancels).toEqual([]);
    expect(logs.join("|")).toContain(`Connected: mock_email`);
  });

  it("prints the persistent Ctrl-C recovery cue when the wait begins", async () => {
    const state = emptyState();
    statusScript(state, ["connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-1" },
    }));

    await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(logs.join("|")).toContain(
      "press Ctrl-C to cancel and return to the prompt",
    );
  });

  it("polls the same internal service name it was given (gmail)", async () => {
    const state = emptyState();
    statusScript(state, ["pending", "connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://accounts.google.com/auth", flow: "flow-g" },
    }));

    const exitCode = await runConnect(client, "gmail", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(0);
    expect(state.statusReads[0]!.searchParams.get("service")).toBe("gmail");
  });

  it("an aborted signal exits 130 promptly, without waiting out the sleep, and cancels the flow", async () => {
    const state = emptyState();
    statusScript(state, ["pending"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-c" },
    }));

    const controller = new AbortController();
    // The sleep never resolves: only the signal race can end the wait, so a
    // prompt return proves cancel does not wait out the poll interval.
    setTimeout(() => controller.abort(), 0);
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: () => new Promise(() => {}),
      now: () => 0,
      cancelSignal: controller.signal,
    });

    expect(exitCode).toBe(EXIT_CANCELLED);
    expect(state.cancels).toEqual([{ userId: "u", flow: "flow-c" }]);
    expect(logs.join("|")).toContain("Cancelled connecting mock_email");
  });

  it("a cancel that races a completed authorization reports connected, not cancelled", async () => {
    // The abort fires, but the confirm-poll on the cancel path finds the flow
    // already landed — the connection is real, so report success and abandon
    // nothing rather than printing a misleading "cancelled".
    const state = emptyState();
    statusScript(state, ["connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-race" },
    }));

    const controller = new AbortController();
    // The sleep never resolves, so the only status read is the confirm-poll the
    // abort path performs — proving the "connected" branch is that poll.
    setTimeout(() => controller.abort(), 0);
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: () => new Promise(() => {}),
      now: () => 0,
      cancelSignal: controller.signal,
    });

    expect(exitCode).toBe(0);
    expect(state.cancels).toEqual([]); // a landed flow is a real connection
    expect(logs.join("|")).toContain("Connected: mock_email");
  });

  it("does not throw when the poll sleep rejects while a cancel signal is wired", async () => {
    // With a cancel signal present the sleep is raced, not awaited directly; a
    // sleep that REJECTS must still settle the race as "done waiting" rather
    // than propagating out of the wait loop and crashing the command.
    const state = emptyState();
    statusScript(state, ["connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-rej" },
    }));

    const controller = new AbortController(); // present, but never aborted
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {
        throw new Error("sleep failed");
      },
      now: () => 0,
      cancelSignal: controller.signal,
    });

    expect(exitCode).toBe(0);
    expect(logs.join("|")).toContain("Connected: mock_email");
  });

  it("a denied flow exits 1 on the next poll and cancels the pending state", async () => {
    const state = emptyState();
    statusScript(state, ["denied"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-d" },
    }));

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    expect(state.cancels).toEqual([{ userId: "u", flow: "flow-d" }]);
    // The cleanup POST is time-bounded so a cancel can't hang on an
    // unresponsive Worker — it carries an abort signal.
    expect(state.cancelSignals).toEqual([true]);
    expect(errors.join("|")).toContain("denied");
  });

  it("an expired flow exits 1 early and cancels the pending state", async () => {
    const state = emptyState();
    statusScript(state, ["expired"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-e" },
    }));

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    expect(state.cancels).toEqual([{ userId: "u", flow: "flow-e" }]);
    expect(errors.join("|")).toContain("expired");
  });

  it("a cancel-endpoint failure never masks the outcome", async () => {
    const state = emptyState({
      cancelResponse: { status: 500, body: { error: "boom" } },
    });
    statusScript(state, ["denied"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-f" },
    }));

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    // The abandon is best-effort: the denied outcome still reports cleanly.
    expect(exitCode).toBe(1);
    expect(state.cancels.length).toBe(1);
    expect(errors.join("|")).toContain("denied");
  });

  it("keeps polling through transient status-endpoint failures", async () => {
    const state = emptyState();
    let call = 0;
    state.flowStatus = () => {
      call++;
      if (call === 1) return { status: 500, body: { error: "blip" } };
      return { status: 200, body: { status: "connected" } };
    };
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-t" },
    }));

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(0);
    expect(call).toBe(2);
  });

  it("reports a connect that lands during the final sleep as connected, not a timeout", async () => {
    // The wait polls before checking the deadline, so a flow that completes in
    // the last poll interval is caught — even though `now()` has already
    // crossed `timeoutMs` by the time this tick runs.
    const state = emptyState();
    statusScript(state, ["pending", "connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-late" },
    }));

    let nowValue = 0;
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {
        nowValue += 6_000; // 2nd tick lands at 12s, past the 10s ceiling.
      },
      now: () => nowValue,
      timeoutMs: 10_000,
    });

    expect(exitCode).toBe(0);
    expect(state.cancels).toEqual([]); // a success abandons nothing
    expect(logs.join("|")).toContain("Connected: mock_email");
    expect(errors.join("|")).not.toContain("Timed out");
  });

  it("a credential-less service connects directly, without opening a browser or polling", async () => {
    const state = emptyState();
    const client = makeClient(state, (service) => ({
      status: 200,
      body: { connected: service },
    }));

    const opened: string[] = [];
    let pollCount = 0;

    const exitCode = await runConnect(client, "file_system", {
      openBrowser: (url) => opened.push(url),
      sleep: async () => {
        pollCount++;
      },
      now: () => 0,
    });

    expect(opened).toEqual([]);
    expect(pollCount).toBe(0);
    expect(exitCode).toBe(0);
  });

  it("returns 1 and surfaces the error for an unknown service", async () => {
    const state = emptyState();
    const client = makeClient(state, (service) => ({
      status: 400,
      body: { error: `Unknown service '${service}'`, error_code: "UNKNOWN_SERVICE" },
    }));

    const exitCode = await runConnect(client, "nope", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("|")).toContain("Unknown service 'nope'");
  });

  it("appends the connectable set to an unknown-service rejection", async () => {
    const state = emptyState({ catalog: ["gmail", "mock_email"] });
    const client = makeClient(state, (service) => ({
      status: 400,
      body: { error: `Unknown service '${service}'`, error_code: "UNKNOWN_SERVICE" },
    }));

    const exitCode = await runConnect(client, "nope", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    const joined = errors.join("|");
    expect(joined).toContain("Unknown service 'nope'");
    expect(joined).toContain("Connectable services: gmail, mock_email");
  });

  it("keys the discovery hint on error_code, not the message prose", async () => {
    // The engine is free to reword the human-readable message; as long as the
    // machine-readable error_code stays UNKNOWN_SERVICE, the hint still fires.
    const state = emptyState({ catalog: ["gmail", "mock_email"] });
    const client = makeClient(state, () => ({
      status: 400,
      body: { error: "totally different wording", error_code: "UNKNOWN_SERVICE" },
    }));

    const exitCode = await runConnect(client, "nope", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("|")).toContain("Connectable services: gmail, mock_email");
  });

  it("does not show the discovery hint for a 400 without the UNKNOWN_SERVICE code", async () => {
    // A different connect 400 (e.g. a malformed name) carries no
    // UNKNOWN_SERVICE code, so the connectable-set hint stays quiet.
    const state = emptyState({ catalog: ["gmail", "mock_email"] });
    const client = makeClient(state, () => ({
      status: 400,
      body: { error: "Malformed service name in path" },
    }));

    const exitCode = await runConnect(client, "bad%", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(exitCode).toBe(1);
    expect(errors.join("|")).not.toContain("Connectable services:");
  });

  it("with no service argument, enumerates the connectable catalog and returns 0", async () => {
    const state = emptyState({ catalog: ["gmail", "mock_email"] });
    // The connect route must never be hit on the enumeration path.
    const client = makeClient(state, () => {
      throw new Error("connect route must not be called");
    });

    const opened: string[] = [];
    let pollCount = 0;
    const exitCode = await runConnect(client, undefined, {
      openBrowser: (url) => opened.push(url),
      sleep: async () => {
        pollCount++;
      },
      now: () => 0,
    });

    expect(exitCode).toBe(0);
    // No browser, no polling — enumeration is a pure listing.
    expect(opened).toEqual([]);
    expect(pollCount).toBe(0);
    const joined = logs.join("|");
    expect(joined).toContain("gmail");
    expect(joined).toContain("mock_email");
  });

  it("returns 1 and cancels the flow if it never completes before the timeout", async () => {
    const state = emptyState();
    statusScript(state, ["pending"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://accounts.google.com/auth", flow: "flow-o" },
    }));

    let nowValue = 0;
    const exitCode = await runConnect(client, "gmail", {
      openBrowser: () => {},
      sleep: async () => {
        // Advance fake time past the 5-minute default on each tick.
        nowValue += 60_000;
      },
      now: () => nowValue,
    });

    expect(exitCode).toBe(1);
    // The timeout path abandons the pending flow too — no orphan row.
    expect(state.cancels).toEqual([{ userId: "u", flow: "flow-o" }]);
    expect(errors.join("|")).toContain("Timed out");
  });

  it("honors an injected timeoutMs (the --timeout flag's value)", async () => {
    const state = emptyState();
    statusScript(state, ["pending"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-s" },
    }));

    let nowValue = 0;
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {
        nowValue += 6_000;
      },
      now: () => nowValue,
      timeoutMs: 10_000,
    });

    expect(exitCode).toBe(1);
    expect(state.cancels.length).toBe(1);
    expect(errors.join("|")).toContain("after 10s");
  });

  it("bounds and cancel-arms every wait-loop status read with a per-read signal", async () => {
    // A hung Worker must not wedge the loop inside a poll await, and a cancel
    // mid-read must abort it. Both come from handing each regular status read a
    // signal (a timeout, composed with the cancel signal when present). Before
    // this the regular poll ran unsignalled; assert every read now carries one.
    const state = emptyState();
    statusScript(state, ["pending", "connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-b" },
    }));

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
      cancelSignal: new AbortController().signal, // present, never aborted
    });

    expect(exitCode).toBe(0);
    expect(state.statusReads.length).toBe(2);
    expect(state.statusSignals).toEqual([true, true]);
  });

  it("still bounds the status read when no cancel signal is injected", async () => {
    // With no cancel channel the read is still bounded by its own timeout, so a
    // scripted (piped) run can't wedge on a half-open Worker either.
    const state = emptyState();
    statusScript(state, ["connected"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-nb" },
    }));

    await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    });

    expect(state.statusSignals).toEqual([true]);
  });

  it("clamps the poll sleep to the time left when --timeout is below the poll interval", async () => {
    // A `--timeout` shorter than the 2s poll interval must not be rounded up:
    // the first sleep is clamped to the remaining budget (1s here), so the wait
    // honors the ceiling to the second instead of overshooting a full interval.
    const state = emptyState();
    statusScript(state, ["pending"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-clamp" },
    }));

    const sleeps: number[] = [];
    let nowValue = 0;
    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        nowValue += ms;
      },
      now: () => nowValue,
      timeoutMs: 1_000, // below POLL_INTERVAL_MS (2s)
    });

    expect(exitCode).toBe(1);
    expect(sleeps[0]).toBe(1_000); // clamped to the remaining budget, not 2_000
    expect(errors.join("|")).toContain("after 1s");
  });

  it("a cancel during the opening connect POST returns 130 cleanly, before any poll", async () => {
    // The cancel signal now bounds the opening POST too, not just the wait: an
    // abort there returns the cancel code without surfacing an AbortError and
    // without ever reaching the status poll.
    const state = emptyState();
    statusScript(state, ["pending"]);
    const client = makeClient(state, () => ({
      status: 200,
      body: { authorizeUrl: "http://x/auth", flow: "flow-early" },
    }));

    const controller = new AbortController();
    controller.abort(); // already cancelled before the POST is issued

    const exitCode = await runConnect(client, "mock_email", {
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
      cancelSignal: controller.signal,
    });

    expect(exitCode).toBe(EXIT_CANCELLED);
    expect(state.connectSignals).toEqual([true]); // the POST carried the signal
    expect(state.statusReads).toEqual([]); // never reached the wait loop
    expect(state.cancels).toEqual([]); // no flow handle yet, nothing to abandon
    expect(logs.join("|")).toContain("Cancelled connecting mock_email");
  });
});
