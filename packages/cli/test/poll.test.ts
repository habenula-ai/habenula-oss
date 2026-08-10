import { describe, it, expect, vi } from "vitest";
import type { HeldCallRecord, StatusResponse } from "@habenula-ai/contracts";
import {
  pollTick,
  startPoll,
  PromptLatch,
  POLL_INTERVAL_MS,
  type PollableIO,
  type PollDeps,
} from "../src/poll";

/**
 * The proactive poll. These pin the
 * interleaving mechanism (candidate 1: compose over the input line) and the
 * resolve-clearing latch. The turn-gated parts (origin/goal render, typed
 * `busy`) are not exercised here — they are not written until the turn gate lands.
 */

const HELD: HeldCallRecord = {
  heldCallId: "held-1",
  service: "mock_email",
  verb: "send",
  noun: "user@example.com",
  params: { subject: "hi" },
};

function status(held: HeldCallRecord | null): StatusResponse {
  return { session: null, grants: [], held: held ? [held] : [], auditTail: null };
}

/** A PollableIO that records the call order so interleaving is assertable. */
function recordingIO(buffer = ""): {
  io: PollableIO;
  events: string[];
} {
  const events: string[] = [];
  const io: PollableIO = {
    deferPoll() {
      // "read" = the poll consulted the input surface before deciding to draw.
      // Defer (skip the tick) only when the buffer is non-empty, matching the old
      // currentInput() !== "" gate.
      events.push("read");
      return buffer !== "";
    },
    eraseInputLine() {
      events.push("erase");
    },
    restoreInputLine() {
      events.push("restore");
    },
    setStatus() {}, // status refresh fires every tick; silent for ordering assertions
  };
  return { io, events };
}

function deps(overrides: Partial<PollDeps> = {}): PollDeps {
  const { io } = recordingIO();
  return {
    getStatus: vi.fn(async () => status(HELD)),
    renderHeld: vi.fn(async () => {}),
    io,
    latch: new PromptLatch(),
    isActive: () => true,
    ...overrides,
  };
}

describe("pollTick — interleaving", () => {
  it("on an empty input line, erases before rendering and restores after", async () => {
    const { io, events } = recordingIO(""); // idle, empty line
    const renderHeld = vi.fn(async () => {
      events.push("render");
    });
    const rendered = await pollTick(deps({ io, renderHeld }));

    expect(rendered).toEqual(HELD);
    expect(renderHeld).toHaveBeenCalledWith(HELD);
    // read the (empty) buffer, erase, render above, restore — in that order.
    expect(events).toEqual(["read", "erase", "render", "restore"]);
  });

  it("defers (no render) while the user is mid-typing a non-empty line", async () => {
    const { io, events } = recordingIO("draft email to bob"); // half-typed
    const latch = new PromptLatch();
    const renderHeld = vi.fn(async () => {});
    const rendered = await pollTick(deps({ io, latch, renderHeld }));

    // node:readline can't lift a live buffer, so a half-typed line is never
    // drawn over — the tick defers and the hold resurfaces once the line clears.
    expect(rendered).toBeNull();
    expect(renderHeld).not.toHaveBeenCalled();
    expect(events).toEqual(["read"]); // read the buffer, saw non-empty, bailed — no erase
    expect(latch.busy).toBe(false); // latch freed for the next tick
  });

  it("feeds the status snapshot to the input surface every tick, even with no held call", async () => {
    const seen: StatusResponse[] = [];
    const io: PollableIO = {
      deferPoll: () => false,
      eraseInputLine: () => {},
      restoreInputLine: () => {},
      setStatus: (s) => seen.push(s),
    };
    const snap = status(null); // no inbound commission to surface
    const rendered = await pollTick(deps({ io, getStatus: vi.fn(async () => snap) }));
    expect(rendered).toBeNull(); // nothing surfaced
    expect(seen).toEqual([snap]); // but the live status line still got refreshed
  });

  it("claims the latch for the render and releases it on completion", async () => {
    const latch = new PromptLatch();
    const renderHeld = vi.fn(async () => {
      // the latch is held for the duration of the (unresolved) prompt.
      expect(latch.busy).toBe(true);
    });
    await pollTick(deps({ latch, renderHeld }));
    // cleared on resolve completion, freeing the next tick.
    expect(latch.busy).toBe(false);
  });

  it("skips when a prompt is already open (reactive path holds the latch)", async () => {
    const latch = new PromptLatch();
    latch.tryAcquire("reactive-hold");
    const getStatus = vi.fn(async () => status(HELD));
    const renderHeld = vi.fn(async () => {});

    const rendered = await pollTick(deps({ latch, getStatus, renderHeld }));

    expect(rendered).toBeNull();
    // never even reads status — the open prompt short-circuits the tick.
    expect(getStatus).not.toHaveBeenCalled();
    expect(renderHeld).not.toHaveBeenCalled();
  });

  it("skips when there is no held call", async () => {
    const getStatus = vi.fn(async () => status(null));
    const renderHeld = vi.fn(async () => {});
    const rendered = await pollTick(deps({ getStatus, renderHeld }));

    expect(rendered).toBeNull();
    expect(renderHeld).not.toHaveBeenCalled();
  });

  it("restores the prompt and releases the latch even when render throws", async () => {
    const latch = new PromptLatch();
    const { io, events } = recordingIO(""); // empty → renders, then throws
    const renderHeld = vi.fn(async () => {
      throw new Error("resolve blew up");
    });

    await expect(pollTick(deps({ io, latch, renderHeld }))).rejects.toThrow(
      "resolve blew up",
    );
    // finally still restored the prompt and freed the latch.
    expect(events).toEqual(["read", "erase", "restore"]);
    expect(latch.busy).toBe(false);
  });

  it("frees the latch when eraseInputLine itself throws (no permanent leak)", async () => {
    const latch = new PromptLatch();
    const renderHeld = vi.fn(async () => {});
    const io: PollableIO = {
      deferPoll: () => false, // don't defer → proceeds to erase (which throws)
      eraseInputLine() {
        throw new Error("EPIPE: terminal closed");
      },
      restoreInputLine() {},
      setStatus() {},
    };
    await expect(pollTick(deps({ io, latch, renderHeld }))).rejects.toThrow("EPIPE");
    // The erase threw with the latch held — it must still be freed, or every
    // future tick short-circuits at `latch.busy` and the poll is dead.
    expect(latch.busy).toBe(false);
    expect(renderHeld).not.toHaveBeenCalled();
  });

  it("skips a held call that is in render-failure cooldown", async () => {
    const cooldown = new Map<string, number>();
    const failing = vi.fn(async () => {
      throw new Error("500 from /api/resolve");
    });
    // First tick fails → the hold is parked in cooldown.
    await expect(pollTick(deps({ renderHeld: failing }), cooldown)).rejects.toThrow("500");
    expect(cooldown.has(HELD.heldCallId)).toBe(true);

    // Second tick over the same still-parked hold must NOT re-render (no
    // input-eating re-prompt loop) while the cooldown holds.
    const renderHeld = vi.fn(async () => {});
    const rendered = await pollTick(deps({ renderHeld }), cooldown);
    expect(rendered).toBeNull();
    expect(renderHeld).not.toHaveBeenCalled();
  });

  it("a cooled-down front hold does not hide the one behind it", async () => {
    // Several calls can be parked at once (one per task). If the front of the
    // list is in render-failure cooldown, the tick renders the next awaiting
    // call instead of going quiet — one broken render must not hide the rest.
    const second: HeldCallRecord = {
      heldCallId: "held-2",
      service: "mock_email",
      verb: "list",
      noun: "ARCHIVE",
      params: { label: "ARCHIVE" },
    };
    const cooldown = new Map<string, number>([[HELD.heldCallId, 3]]);
    const renderHeld = vi.fn(async () => {});
    const getStatus = vi.fn(
      async (): Promise<StatusResponse> => ({
        session: null,
        grants: [],
        held: [HELD, second],
        auditTail: null,
      }),
    );
    const rendered = await pollTick(deps({ getStatus, renderHeld }), cooldown);
    expect(rendered).toEqual(second);
    expect(renderHeld).toHaveBeenCalledWith(second);
  });

  it("does not double-render when the reactive path claims the same hold mid-tick", async () => {
    // Regression: the poll passes the `busy` check while the latch is free, then
    // the reactive path claims THIS hold during getStatus. tryAcquire(sameId) must
    // fail (not idempotently succeed), so the tick skips instead of drawing a
    // second prompt for the same call — the orphaned-choice-reader wedge.
    const latch = new PromptLatch();
    const renderHeld = vi.fn(async () => {});
    const getStatus = vi.fn(async () => {
      latch.tryAcquire(HELD.heldCallId); // reactive path wins the race
      return status(HELD);
    });
    const rendered = await pollTick(deps({ latch, getStatus, renderHeld }));
    expect(rendered).toBeNull();
    expect(renderHeld).not.toHaveBeenCalled();
    // the reactive claim survives — the poll's finally must not free a latch it
    // never acquired.
    expect(latch.busy).toBe(true);
  });
});

describe("PromptLatch — ownership", () => {
  it("tryAcquire is exclusive once held — a second acquire fails even for the same id", () => {
    const latch = new PromptLatch();
    expect(latch.tryAcquire("A")).toBe(true);
    // Same id must NOT re-acquire. No single path re-acquires an id it holds, so a
    // same-id acquire is the reactive/poll cross-path race the latch must reject —
    // an idempotent `true` here double-renders the same hold and wedges the REPL.
    expect(latch.tryAcquire("A")).toBe(false);
    expect(latch.tryAcquire("B")).toBe(false); // a different id is locked out too
    expect(latch.busy).toBe(true);
    latch.release("A");
    expect(latch.tryAcquire("A")).toBe(true); // freed → acquirable again
  });

  it("release only frees the holder's own claim (a non-owner release is a no-op)", () => {
    const latch = new PromptLatch();
    latch.tryAcquire("poll-hold");
    // The reactive path's `finally { release(id) }` on a branch it never
    // acquired must not free the poll's claim mid-prompt.
    latch.release("reactive-hold");
    expect(latch.busy).toBe(true);
    latch.release("poll-hold");
    expect(latch.busy).toBe(false);
  });
});

describe("startPoll — loop", () => {
  it("ticks on the interval and stops when isActive goes false", async () => {
    let active = true;
    let ticks = 0;
    const getStatus = vi.fn(async () => {
      ticks += 1;
      if (ticks >= 3) active = false; // stop after the third read
      return status(null);
    });
    const sleepMs: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleepMs.push(ms);
    });

    await startPoll(
      deps({ getStatus, isActive: () => active, sleep, intervalMs: 500 }),
    );

    expect(ticks).toBe(3);
    expect(sleepMs.every((ms) => ms === 500)).toBe(true);
  });

  it("swallows a thrown tick, routes it to onError, and keeps polling", async () => {
    let active = true;
    let calls = 0;
    const getStatus = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("worker unreachable");
      if (calls >= 2) active = false;
      return status(null);
    });
    const onError = vi.fn();

    await startPoll(
      deps({
        getStatus,
        isActive: () => active,
        sleep: async () => {},
        onError,
      }),
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2); // the throw did not tear the loop down
  });

  it("does not tick when isActive is already false before the first sleep", async () => {
    const getStatus = vi.fn(async () => status(HELD));
    await startPoll(deps({ getStatus, isActive: () => false, sleep: async () => {} }));
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("defaults to the source-constant interval", () => {
    expect(POLL_INTERVAL_MS).toBe(3_000);
  });

  it("a paused tick issues no read (the health probe is the only offline traffic)", async () => {
    let ticks = 0;
    let active = true;
    const paused = [false, true, true, false]; // tick index → paused?
    const getStatus = vi.fn(async () => status(null));
    const sleep = vi.fn(async () => {
      ticks += 1;
      if (ticks > paused.length) active = false;
    });

    await startPoll(
      deps({
        getStatus,
        isActive: () => active,
        isPaused: () => paused[ticks - 1] ?? false,
        sleep,
      }),
    );

    // Reads only on the two unpaused ticks (1 and 4).
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("render-failure cooldowns do not age across a paused stretch (resume with state intact)", async () => {
    // Failure at tick 1 parks the hold for RENDER_FAILURE_COOLDOWN_TICKS (3).
    // Ticks 2–4 are paused: if the cooldown aged during the pause, the hold
    // would re-render on the first unpaused tick; instead it must take three
    // UNPAUSED ticks (5: 3→2, 6: 2→1, 7: expire → render).
    let ticks = 0;
    let active = true;
    let readsAtSecondRender = -1;
    const getStatus = vi.fn(async () => status(HELD));
    const renderHeld = vi
      .fn()
      .mockRejectedValueOnce(new Error("render blew up"))
      .mockImplementation(async () => {
        readsAtSecondRender = getStatus.mock.calls.length;
        active = false;
      });
    const sleep = vi.fn(async () => {
      ticks += 1;
      if (ticks > 12) active = false; // safety stop
    });

    await startPoll(
      deps({
        getStatus,
        renderHeld,
        isActive: () => active,
        isPaused: () => ticks >= 2 && ticks <= 4,
        sleep,
        onError: () => {},
      }),
    );

    expect(renderHeld).toHaveBeenCalledTimes(2);
    // Reads happened on unpaused ticks 1, 5, 6, 7 — the re-render landed on
    // the FOURTH read, i.e. after three unpaused aging ticks, proving the
    // paused stretch neither read nor aged the cooldown.
    expect(readsAtSecondRender).toBe(4);
  });
});
