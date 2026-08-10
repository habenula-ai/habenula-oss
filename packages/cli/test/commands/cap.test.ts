import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import { runCap } from "../../src/commands/cap";

const SETTINGS = {
  monthLimitCents: 5000,
  sessionLimitCents: 2000,
  monthIsDefault: true,
  sessionIsDefault: false,
  monthSpentCents: 1234,
  sessionSpentCents: 0,
};

function makeClient(body: unknown): {
  client: ApiClient;
  calls: { url: string; method: string; body?: unknown }[];
} {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    client: new ApiClient(
      { apiUrl: "http://api.test", userId: "u", humanTouch: false },
      fetchFn,
    ),
    calls,
  };
}

describe("runCap", () => {
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

  it("bare cap GETs /api/settings and renders both windows with default marks", async () => {
    const { client, calls } = makeClient(SETTINGS);

    const exitCode = await runCap(client);

    expect(exitCode).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/api/settings?userId=u");
    expect(calls[0]!.method).toBe("GET");
    const out = logs.join("\n");
    expect(out).toContain("monthly  $50.00 (default) — spent $12.34 this month");
    expect(out).toContain("session  $20.00 — spent $0.00 this session");
    // A limit with a stored key is not marked default.
    expect(out).not.toContain("$20.00 (default)");
  });

  it("with limits POSTs integer cents and renders the echoed state", async () => {
    const { client, calls } = makeClient({
      ...SETTINGS,
      monthLimitCents: 7500,
      monthIsDefault: false,
    });

    const exitCode = await runCap(client, { monthlyCents: 7500 });

    expect(exitCode).toBe(0);
    expect(calls[0]!.url).toBe("http://api.test/api/settings");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ userId: "u", monthLimitCents: 7500 });
    const out = logs.join("\n");
    expect(out).toContain("Spending caps updated.");
    expect(out).toContain("monthly  $75.00 — spent $12.34 this month");
  });

  it("sends only the flags given — an omitted window is never touched", async () => {
    const { client, calls } = makeClient(SETTINGS);

    await runCap(client, { sessionCents: 500 });

    expect(calls[0]!.body).toEqual({ userId: "u", sessionLimitCents: 500 });
  });
});
