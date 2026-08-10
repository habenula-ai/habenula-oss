import { describe, it, expect, vi, afterEach } from "vitest";
import {
  confirmPresence,
  makePresenceGate,
  makeRunHelper,
  PRESENCE_TIMEOUT_MS,
  type HelperChild,
  type HelperResult,
} from "../../src/gate/confirm-presence";
import { loadConfig, type Config } from "../../src/config";

/**
 * The Human Touch presence gate. Two layers: the
 * HelperResult → decision mapping (+ warn/latch) through an injected runHelper,
 * and the default runner's own (code, signal)/ENOENT/timeout classification
 * against a fake child — the mapping a scripted-result fake would skip. CI
 * never spawns the real helper or touches biometrics.
 */

function config(humanTouch: boolean): Config {
  return { apiUrl: "http://localhost:8787", userId: "cli-user", humanTouch };
}

const darwin = () => "darwin";
const linux = () => "linux";

function scripted(result: HelperResult) {
  return vi.fn(async () => result);
}

describe("confirmPresence — decision", () => {
  it("toggle off → true without consulting the helper", async () => {
    const runHelper = scripted("denied");
    await expect(
      confirmPresence(config(false), { platform: darwin, runHelper }),
    ).resolves.toBe(true);
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("non-macOS → true without consulting the helper", async () => {
    const runHelper = scripted("denied");
    await expect(
      confirmPresence(config(true), { platform: linux, runHelper }),
    ).resolves.toBe(true);
    expect(runHelper).not.toHaveBeenCalled();
  });

  it.each<[HelperResult, boolean]>([
    ["ok", true],
    ["unavailable", true],
    ["missing", true],
    ["denied", false],
    ["error", false],
  ])("helper %s → gate %s", async (result, decision) => {
    await expect(
      // warn is a noop here so the missing/error rows don't write real stderr;
      // warn behavior has its own suite below.
      confirmPresence(config(true), {
        platform: darwin,
        runHelper: scripted(result),
        warn: () => {},
      }),
    ).resolves.toBe(decision);
  });
});

describe("confirmPresence — warn", () => {
  it.each<[HelperResult, boolean]>([
    ["ok", false],
    ["unavailable", true], // fail-open, but noted so silent ungating is detectable
    ["denied", false],
    ["missing", true],
    ["error", true],
  ])("helper %s → warn fires: %s", async (result, fires) => {
    const warn = vi.fn();
    await confirmPresence(config(true), { platform: darwin, runHelper: scripted(result), warn });
    expect(warn).toHaveBeenCalledTimes(fires ? 1 : 0);
  });

  it("missing warns the helper isn't built and that approvals proceed ungated", async () => {
    const warn = vi.fn();
    await confirmPresence(config(true), { platform: darwin, runHelper: scripted("missing"), warn });
    expect(warn.mock.calls[0]?.[0]).toMatch(/isn't built.*ungated.*build-presence-helper/);
  });

  it("unavailable warns that biometrics are unavailable and approvals proceed ungated", async () => {
    const warn = vi.fn();
    await confirmPresence(config(true), { platform: darwin, runHelper: scripted("unavailable"), warn });
    expect(warn.mock.calls[0]?.[0]).toMatch(/biometrics are unavailable.*ungated/);
  });
});

describe("makePresenceGate — warn latching (error/unavailable once, missing every time)", () => {
  it("binds config and returns a nullary gate", async () => {
    const gate = makePresenceGate(config(true), { platform: darwin, runHelper: scripted("ok") });
    await expect(gate()).resolves.toBe(true);
  });

  it("warns on every ungated missing approval (fail-open must not go silent)", async () => {
    const warn = vi.fn();
    const gate = makePresenceGate(config(true), {
      platform: darwin,
      runHelper: scripted("missing"),
      warn,
    });
    await expect(gate()).resolves.toBe(true);
    await expect(gate()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("warns at most once across repeated error results (still failing closed each time)", async () => {
    const warn = vi.fn();
    const gate = makePresenceGate(config(true), {
      platform: darwin,
      runHelper: scripted("error"),
      warn,
    });
    await expect(gate()).resolves.toBe(false);
    await expect(gate()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns at most once across repeated unavailable results (still failing open each time)", async () => {
    const warn = vi.fn();
    const gate = makePresenceGate(config(true), {
      platform: darwin,
      runHelper: scripted("unavailable"),
      warn,
    });
    await expect(gate()).resolves.toBe(true);
    await expect(gate()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * A fake child for the default runner's classification. `kill()` records the
 * call and emits a signalled close — exactly what a real kill does — so the
 * timeout test exercises the double-settle guard, not a convenient silence.
 */
type SpawnError = Error & { code?: string };

class FakeChild implements HelperChild {
  killed = false;
  private errorCb: ((err: SpawnError) => void) | undefined;
  private closeCb: ((code: number | null, signal: string | null) => void) | undefined;

  on(event: "error", cb: (err: SpawnError) => void): void;
  on(event: "close", cb: (code: number | null, signal: string | null) => void): void;
  on(event: "error" | "close", cb: unknown): void {
    if (event === "error") this.errorCb = cb as (err: SpawnError) => void;
    else this.closeCb = cb as (code: number | null, signal: string | null) => void;
  }

  kill(): void {
    this.killed = true;
    this.closeCb?.(null, "SIGTERM");
  }

  emitClose(code: number | null, signal: string | null = null): void {
    this.closeCb?.(code, signal);
  }

  emitError(code?: string): void {
    const err: SpawnError = new Error(code ?? "spawn failed");
    if (code !== undefined) err.code = code;
    this.errorCb?.(err);
  }
}

describe("makeRunHelper — (code, signal) classification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[number, HelperResult]>([
    [0, "ok"],
    [1, "denied"],
    [2, "unavailable"],
    [3, "error"], // any unrecognized exit code fails closed
  ])("exit %i → %s", async (code, expected) => {
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    child.emitClose(code);
    await expect(result).resolves.toBe(expected);
  });

  it("spawn ENOENT (binary not built) → missing", async () => {
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    child.emitError("ENOENT");
    await expect(result).resolves.toBe("missing");
  });

  it("any other spawn error → error", async () => {
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    child.emitError("EACCES");
    await expect(result).resolves.toBe("error");
  });

  it("signal-killed child (code null) → error, never a fail-open", async () => {
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    child.emitClose(null, "SIGKILL");
    await expect(result).resolves.toBe("error");
  });

  it("timeout → denied first, child killed, and the kill's signalled close never double-settles into error", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS);
    // kill() already fired a signalled close inside the timer callback; the
    // settled latch must have kept the result at `denied`.
    expect(child.killed).toBe(true);
    await expect(result).resolves.toBe("denied");
  });

  it("a normal exit before the timeout wins the race", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const result = makeRunHelper(() => child)();
    child.emitClose(0);
    vi.advanceTimersByTime(PRESENCE_TIMEOUT_MS);
    expect(child.killed).toBe(false);
    await expect(result).resolves.toBe("ok");
  });
});

describe("loadConfig — HABENULA_HUMAN_TOUCH", () => {
  // Every call passes `null` file-vars so no test reads a developer's real
  // ~/.habenula/config (config.test.ts covers the file layer itself).
  it.each(["1", "true", "TRUE", "yes", "on", "On", " 1 "])(
    "%j reads as on",
    (value) => {
      expect(loadConfig({ HABENULA_HUMAN_TOUCH: value }, null).humanTouch).toBe(true);
    },
  );

  it.each([undefined, "", " ", "0", "false", "no", "off", "enable", "banana"])(
    "%j reads as off (unrecognized values fail safe)",
    (value) => {
      expect(loadConfig({ HABENULA_HUMAN_TOUCH: value }, null).humanTouch).toBe(false);
    },
  );

  it("defaults off when the variable is absent", () => {
    expect(loadConfig({}, null).humanTouch).toBe(false);
  });
});
