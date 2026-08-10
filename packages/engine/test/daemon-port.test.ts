import { describe, it, expect } from "vitest";
import {
  DEFAULT_DAEMON_PORT,
  resolveDaemonPort,
} from "../src/daemon-port";

/**
 * The habenula-engine daemon's HABENULA_PORT input. A pure parse, so the whole
 * surface is table-drivable — which is the reason it lives outside
 * `src/daemon/` (every module there reaches Miniflare, which cannot load in
 * workerd, and this suite runs in the Workers runtime).
 *
 * What is NOT tested here, deliberately: that Miniflare binds the resolved port
 * and that a busy port exits 1. Both need a real bind, which belongs to
 * scripts/validate-selfhost.mjs — it already boots the container on
 * HABENULA_PORT=8799 and would fail if the resolved port stopped reaching
 * workerd.
 */
describe("resolveDaemonPort", () => {
  it("defaults to 8787 when unset", () => {
    expect(resolveDaemonPort(undefined)).toEqual({
      port: DEFAULT_DAEMON_PORT,
    });
  });

  // Compose writes `HABENULA_PORT=` into a container's environment as an empty
  // string when the .env line has no value, so blank must mean unset rather
  // than refused — otherwise a stray line in .env stops the daemon.
  it.each(["", "   "])("treats %j as unset", (raw) => {
    expect(resolveDaemonPort(raw)).toEqual({ port: DEFAULT_DAEMON_PORT });
  });

  it("accepts a plain port and tolerates surrounding whitespace", () => {
    expect(resolveDaemonPort("9000")).toEqual({ port: 9000 });
    expect(resolveDaemonPort(" 9000\n")).toEqual({ port: 9000 });
  });

  it.each([1, 1024, 8787, 65535])("accepts the boundary port %i", (port) => {
    expect(resolveDaemonPort(String(port))).toEqual({ port });
  });

  // Every one of these is something Number() would have accepted, resolving to
  // a port the user did not type. The daemon must refuse rather than serve
  // somewhere its own docs do not describe.
  it.each(["0x22", "8.787e3", "+8787", "8787.0", "-1", "87 87", "eight"])(
    "refuses %j as not a whole number",
    (raw) => {
      const result = resolveDaemonPort(raw);
      expect(result).toMatchObject({
        refusal: expect.stringContaining("must be a whole number"),
      });
      // The refusal quotes the offending value and names the way out.
      expect((result as { refusal: string }).refusal).toContain(raw);
      expect((result as { refusal: string }).refusal).toContain(
        "HABENULA_PORT",
      );
    },
  );

  // 0 is a plausible "pick any free port" intent, and Miniflare would honour
  // it — which is exactly why it gets its own refusal rather than falling into
  // the range message.
  it("refuses 0 with the random-port reason", () => {
    const result = resolveDaemonPort("0");
    expect(result).toMatchObject({
      refusal: expect.stringContaining("cannot be 0"),
    });
    expect((result as { refusal: string }).refusal).toContain(
      "random free port",
    );
  });

  it.each(["65536", "99999"])("refuses %j as out of range", (raw) => {
    expect(resolveDaemonPort(raw)).toMatchObject({
      refusal: expect.stringContaining("between 1 and 65535"),
    });
  });

  // The daemon branches on the shape, so a refusal must never also carry a
  // port and vice versa.
  it("returns exactly one of port or refusal", () => {
    expect(resolveDaemonPort("9000")).not.toHaveProperty("refusal");
    expect(resolveDaemonPort("0")).not.toHaveProperty("port");
  });
});
