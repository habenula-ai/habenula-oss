import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import { runDisconnect } from "../../src/commands/disconnect";

/** An ApiClient whose disconnect returns the given `removed` flag. */
function clientReturning(removed: boolean): ApiClient {
  const fetchFn: FetchFn = async () =>
    new Response(JSON.stringify({ disconnected: "mock", removed }), {
      status: 200,
    });
  return new ApiClient({ apiUrl: "http://api.test", userId: "u", humanTouch: false }, fetchFn);
}

describe("runDisconnect", () => {
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

  it("reports success and exits 0 when a connection was removed", async () => {
    const exitCode = await runDisconnect(clientReturning(true), "mock_email");

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Disconnected: mock_email");
    expect(errs).toEqual([]);
  });

 it("reports the no-op and exits non-zero when nothing was connected", async () => {
    // A typo or never-connected name must not report a false success.
    const exitCode = await runDisconnect(clientReturning(false), "mock");

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("not connected: mock");
    expect(logs.join("\n")).not.toContain("Disconnected");
  });
});
