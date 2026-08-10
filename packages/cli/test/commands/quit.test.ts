import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import { runQuit } from "../../src/commands/quit";

function makeClient(body: unknown): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (input) => {
    calls.push(input);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    client: new ApiClient({ apiUrl: "http://api.test", userId: "u", humanTouch: false }, fetchFn),
    calls,
  };
}

describe("runQuit", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the quit route and reports the freed slot", async () => {
    const { client, calls } = makeClient({ ended: true });

    const exitCode = await runQuit(client);

    expect(exitCode).toBe(0);
    expect(calls[0]).toBe("http://api.test/api/session/quit");
    expect(logs.join("\n")).toContain("Session ended");
  });

  it("is idempotent-friendly: reports nothing-to-end rather than erroring", async () => {
    const { client } = makeClient({ ended: false });

    const exitCode = await runQuit(client);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("No active session");
  });
});
