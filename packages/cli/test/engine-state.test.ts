import { describe, it, expect, vi } from "vitest";
import { ApiError, EngineUnavailableError } from "../src/api-client";
import {
  EngineState,
  HEALTH_PROBE_BASE_MS,
  HEALTH_PROBE_MAX_MS,
  type EngineStateDeps,
} from "../src/engine-state";

/**
 * The REPL engine-state tracker: transition
 * announcements, the flap asymmetry, the probe → handshake → online recovery
 * sequence, and the kind-aware recovery line. All against injected deps — no
 * sockets, no readline.
 */

const API_URL = "http://api.test";

function reject(): EngineUnavailableError {
  return new EngineUnavailableError(API_URL, "reject");
}

function deadline(): EngineUnavailableError {
  return new EngineUnavailableError(API_URL, "deadline");
}

/**
 * Deps harness. `probeResults` is consumed one per probe; when it runs dry
 * the next probe-loop sleep parks forever, so a loop that should keep
 * probing cannot spin the test. `flushUntil` bounds the microtask drain.
 */
function makeDeps(overrides: Partial<EngineStateDeps> = {}) {
  const writes: string[] = [];
  const sleeps: number[] = [];
  const probeResults: boolean[] = [];
  const deps: EngineStateDeps = {
    apiUrl: API_URL,
    probeHealth: vi.fn(async () => probeResults.shift() ?? false),
    runLaunchHandshake: vi.fn(async () => {}),
    onFirstRunNudge: vi.fn(async () => {}),
    write: (line) => writes.push(line),
    sleep: async (ms) => {
      if (probeResults.length === 0 && sleeps.length > 0) {
        // Script exhausted — park so an (expectedly) still-probing loop idles.
        sleeps.push(ms);
        return new Promise<never>(() => {});
      }
      sleeps.push(ms);
    },
    isActive: () => true,
    ...overrides,
  };
  return { deps, writes, sleeps, probeResults };
}

async function flushUntil(cond: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("EngineState — transitions and announcements", () => {
  it("starts online", () => {
    const { deps } = makeDeps();
    const state = new EngineState(deps);
    expect(state.isOnline()).toBe(true);
    expect(state.isOffline()).toBe(false);
  });

  it("a background transport reject transitions offline and writes the guidance once", () => {
    const { deps, writes } = makeDeps();
    const state = new EngineState(deps);

    state.noteFailure(reject(), "background");

    expect(state.isOffline()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("not reachable");
    expect(writes[0]).toContain(API_URL);
  });

  it("a background DEADLINE does not flap the state (retry next tick)", () => {
    const { deps, writes } = makeDeps();
    const state = new EngineState(deps);

    state.noteFailure(deadline(), "background");

    expect(state.isOnline()).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("a foreground deadline DOES transition offline, with the timeout variant", () => {
    const { deps, writes } = makeDeps();
    const state = new EngineState(deps);

    state.noteFailure(deadline(), "foreground");

    expect(state.isOffline()).toBe(true);
    expect(writes[0]).toContain("not responding");
    expect(writes[0]).not.toContain("not reachable");
  });

  it("repeated failures while already offline are suppressed (announce on transition, not per tick)", () => {
    const { deps, writes } = makeDeps();
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    state.noteFailure(reject(), "background");
    state.noteFailure(deadline(), "foreground");

    expect(writes).toHaveLength(1);
  });

  it("offlineNotice restates the guidance for the kind that drove the offline", () => {
    const { deps } = makeDeps();
    const state = new EngineState(deps);

    state.noteFailure(deadline(), "foreground");

    expect(state.offlineNotice()).toContain("not responding");
    expect(state.offlineNotice()).toContain(API_URL);
  });
});

describe("EngineState — probe loop and recovery", () => {
  it("keeps probing while the probe reads unreachable, without running the handshake", async () => {
    const { deps, probeResults } = makeDeps();
    probeResults.push(false, false);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "background");
    await flushUntil(() => (deps.probeHealth as ReturnType<typeof vi.fn>).mock.calls.length >= 2);

    expect(deps.probeHealth).toHaveBeenCalledTimes(2);
    expect(deps.runLaunchHandshake).not.toHaveBeenCalled();
    expect(state.isOffline()).toBe(true);
  });

  it("a foreground failure landing while the probe loop is already running does not re-announce or start a second loop", async () => {
    // A background reject transitions offline and starts the probe loop; after
    // one unreachable probe the harness parks the next backoff (script dry), so
    // the loop is idle mid-flight. A foreground reject arriving now must be a
    // no-op: `noteFailure`'s already-offline early-return means no second
    // guidance line, and the `probing` guard means no duplicate probe loop.
    const probeFn = vi.fn(async () => false);
    const { deps, writes } = makeDeps({ probeHealth: probeFn });
    const state = new EngineState(deps);

    state.noteFailure(reject(), "background");
    await flushUntil(() => probeFn.mock.calls.length >= 1);
    const probesBefore = probeFn.mock.calls.length;

    state.noteFailure(reject(), "foreground"); // lands while offline, loop parked
    await flushUntil(() => false, 5); // drain: a spurious second loop would probe here

    expect(writes).toHaveLength(1); // announced once, on the transition only
    expect(probeFn.mock.calls.length).toBe(probesBefore); // no second probe loop
    expect(state.isOffline()).toBe(true);
  });

  it("a reachable probe cues the handshake; a completing handshake flips online with the recovery line and the deferred nudge", async () => {
    const { deps, writes, probeResults } = makeDeps();
    probeResults.push(false, true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => state.isOnline());

    expect(state.isOnline()).toBe(true);
    expect(deps.runLaunchHandshake).toHaveBeenCalledTimes(1);
    expect(deps.onFirstRunNudge).toHaveBeenCalledTimes(1);
    // guidance first, recovery line on the flip — nothing per probe tick.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("not reachable");
    expect(writes[1]).toBe("Engine connected.");
  });

  it("recovery after a deadline-driven offline announces the timeout variant, never a reconnect", async () => {
    const { deps, writes, probeResults } = makeDeps();
    probeResults.push(true);
    const state = new EngineState(deps);

    state.noteFailure(deadline(), "foreground");
    await flushUntil(() => state.isOnline());

    expect(writes[1]).toBe("Engine responding again.");
  });

  it("a handshake that still throws availability keeps the state offline and keeps probing", async () => {
    const { deps, probeResults } = makeDeps({
      runLaunchHandshake: vi
        .fn()
        .mockRejectedValueOnce(reject())
        .mockResolvedValue(undefined),
    });
    probeResults.push(true, true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => state.isOnline());

    // First handshake failed availability → stayed offline, probed again,
    // second handshake completed → online.
    expect(deps.runLaunchHandshake).toHaveBeenCalledTimes(2);
    expect(state.isOnline()).toBe(true);
  });

  it("a handshake that throws a NON-availability error still flips online (the engine was reached) and diagnoses the swallowed error", async () => {
    const diagnosed: string[] = [];
    const { deps, probeResults } = makeDeps({
      runLaunchHandshake: vi.fn(async () => {
        throw new ApiError(500, "boom");
      }),
      diagnose: (m) => diagnosed.push(m),
    });
    probeResults.push(true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => state.isOnline());

    expect(state.isOnline()).toBe(true);
    // The reached-but-errored handshake is not silently discarded — a genuine
    // handshake bug must be visible, not masked by "Engine connected.".
    expect(diagnosed).toHaveLength(1);
    expect(diagnosed[0]).toContain("handshake errored");
  });

  it("a teardown during the recovery handshake suppresses the online announcement", async () => {
    // isActive flips false while the handshake await is in flight — the loop
    // must not write the recovery line into a torn-down REPL.
    let active = true;
    const { deps, writes, probeResults } = makeDeps({
      isActive: () => active,
      runLaunchHandshake: vi.fn(async () => {
        active = false; // REPL closed mid-handshake
      }),
    });
    probeResults.push(true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => (deps.runLaunchHandshake as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    await flushUntil(() => false, 5);

    expect(state.isOffline()).toBe(true); // never flipped online
    expect(writes.filter((w) => w === "Engine connected.")).toHaveLength(0);
    expect(deps.onFirstRunNudge).not.toHaveBeenCalled();
  });

  it("backs off the probe interval, doubling from the base to the cap", async () => {
    const { deps, sleeps, probeResults } = makeDeps();
    probeResults.push(false, false, false, false, true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => state.isOnline());

    expect(sleeps).toEqual([
      HEALTH_PROBE_BASE_MS,
      HEALTH_PROBE_BASE_MS * 2,
      HEALTH_PROBE_BASE_MS * 4,
      HEALTH_PROBE_MAX_MS,
      HEALTH_PROBE_MAX_MS,
    ]);
  });

  it("the probe loop stops when the REPL goes inactive", async () => {
    let active = true;
    const { deps, probeResults } = makeDeps({ isActive: () => active });
    probeResults.push(false, false, false);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => (deps.probeHealth as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
    active = false;
    const callsAtStop = (deps.probeHealth as ReturnType<typeof vi.fn>).mock.calls.length;
    await flushUntil(() => false, 5);

    expect((deps.probeHealth as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(
      callsAtStop + 1,
    );
    expect(state.isOffline()).toBe(true); // no recovery was announced
  });

  it("re-nudge on repeated recoveries is the wiring's guard, but each recovery announces", async () => {
    const { deps, writes, probeResults } = makeDeps();
    probeResults.push(true);
    const state = new EngineState(deps);

    state.noteFailure(reject(), "foreground");
    await flushUntil(() => state.isOnline());
    // Second offline/online cycle.
    probeResults.push(true);
    state.noteFailure(deadline(), "foreground");
    await flushUntil(() => state.isOnline());

    expect(writes.filter((w) => w === "Engine connected.")).toHaveLength(1);
    expect(writes.filter((w) => w === "Engine responding again.")).toHaveLength(1);
    // The nudge callback fires per recovery; the once-per-session guard
    // lives in the REPL wiring (chat.ts), not here.
    expect(deps.onFirstRunNudge).toHaveBeenCalledTimes(2);
  });
});
