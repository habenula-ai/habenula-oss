import { describe, it, expect, vi, afterEach } from "vitest";
import { withSpinner } from "../../src/render/spinner";

/**
 * Spinner teardown guarantees. Fake timers make the
 * show-after-delay and interval deterministic; a fake stream captures writes.
 */

function fakeStream() {
  const writes: string[] = [];
  return { writes, stream: { write: (s: string) => void writes.push(s) } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withSpinner", () => {
  it("runs fn with zero writes when not a TTY", async () => {
    const { writes, stream } = fakeStream();
    const r = await withSpinner("working…", async () => 42, { isTTY: false, stream });
    expect(r).toBe(42);
    expect(writes).toEqual([]);
  });

  it("does not flash for a fast call that resolves before the show delay", async () => {
    vi.useFakeTimers();
    const { writes, stream } = fakeStream();
    const p = withSpinner("working…", async () => "quick", {
      isTTY: true,
      stream,
      showAfterMs: 120,
    });
    await vi.advanceTimersByTimeAsync(0); // fn resolves immediately
    await p;
    expect(writes).toEqual([]); // never drew a frame
  });

  it("clears the spinner and leaves no live interval after a thrown round-trip", async () => {
    vi.useFakeTimers();
    const { writes, stream } = fakeStream();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const p = withSpinner(
      "working…",
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("round-trip failed")), 500);
        }),
      { isTTY: true, stream, showAfterMs: 120, intervalMs: 90 },
    );
    const settled = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(500);
    expect(await settled).toBe("round-trip failed");

    expect(clearSpy).toHaveBeenCalled();
    // The last write is the clear sequence (blanks + carriage return), and
    // advancing further produces no more frames — no residual timer.
    const writesAfter = writes.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.length).toBe(writesAfter);
    expect(writes.at(-1)).toMatch(/^\r\s+\r$/);
  });

  it("clears before the result line is written (last write is the clear sequence)", async () => {
    vi.useFakeTimers();
    const { writes, stream } = fakeStream();
    const p = withSpinner(
      "working…",
      () => new Promise((resolve) => setTimeout(() => resolve("ok"), 500)),
      { isTTY: true, stream, showAfterMs: 120, intervalMs: 90 },
    );
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(writes.length).toBeGreaterThan(0); // it did show
    expect(writes.at(-1)).toMatch(/^\r\s+\r$/); // …and the final write clears it
  });
});
