import { describe, it, expect } from "vitest";
import {
  graphFetch,
  graphPagedList,
  GraphApiError,
  GRAPH_BASE,
  GRAPH_MAX_RETRIES,
  GRAPH_PAGE_CAP,
  GRAPH_RETRY_AFTER_CEILING_SECONDS,
} from "../../../src/services/microsoft/graph";

/** One canned JSON response. */
function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * A scripted fetch: pops one response per call, recording each requested URL
 * and init. Throws if called more times than it has responses — an
 * over-fetching bug fails loud instead of hanging.
 */
function scriptedFetch(responses: Response[]) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    urls.push(typeof input === "string" ? input : input.toString());
    inits.push(init);
    const next = responses.shift();
    if (!next) {
      throw new Error(`scripted fetch exhausted (call ${String(urls.length)})`);
    }
    return next;
  };
  return { fetchFn, urls, inits };
}

/** A recording sleep that never wall-waits. */
function recordingSleep() {
  const waits: number[] = [];
  const sleepFn = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  return { sleepFn, waits };
}

describe("graphFetch", () => {
  it("resolves a relative path against GRAPH_BASE with the bearer token", async () => {
    const { fetchFn, urls, inits } = scriptedFetch([jsonResponse({ ok: 1 })]);

    const res = await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
    });

    expect(res.status).toBe(200);
    expect(urls).toEqual([`${GRAPH_BASE}/me/messages`]);
    expect(new Headers(inits[0]?.headers).get("Authorization")).toBe(
      "Bearer ms-token",
    );
  });

  it("passes an absolute URL through verbatim", async () => {
    // A nextLink is a complete opaque URL — followed exactly, never
    // reconstructed against the base.
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/messages?%24skiptoken=opaque-abc%3D%3D&weird=1";
    const { fetchFn, urls } = scriptedFetch([jsonResponse({ ok: 1 })]);

    await graphFetch("ms-token", nextLink, undefined, { fetchFn });

    expect(urls).toEqual([nextLink]);
  });

  it("refuses an absolute URL off Graph's origin before any request is made", async () => {
    // A nextLink is trusted enough to follow, not enough to hand the bearer
    // token to an arbitrary host named in a response body: a foreign origin
    // must fail before the token is attached to anything.
    const { fetchFn, urls } = scriptedFetch([]);

    const err = await graphFetch(
      "ms-token",
      "https://evil.example/v1.0/me/messages",
      undefined,
      { fetchFn },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("https://evil.example");
    expect((err as Error).message).toContain("graph.microsoft.com");
    // No request went out at all.
    expect(urls).toEqual([]);
  });

  it("preserves caller headers alongside the injected Authorization", async () => {
    const { fetchFn, inits } = scriptedFetch([jsonResponse({ ok: 1 })]);

    await graphFetch(
      "ms-token",
      "/me/messages/m1",
      { headers: { Prefer: 'outlook.body-content-type="text"' } },
      { fetchFn },
    );

    const headers = new Headers(inits[0]?.headers);
    expect(headers.get("Prefer")).toBe('outlook.body-content-type="text"');
    expect(headers.get("Authorization")).toBe("Bearer ms-token");
  });

  it("returns a 202 response raw (no forced JSON parse)", async () => {
    // sendMail answers 202 Accepted with no body; graphFetch must hand the
    // Response back rather than choking on the empty body.
    const { fetchFn } = scriptedFetch([new Response(null, { status: 202 })]);

    const res = await graphFetch(
      "ms-token",
      "/me/sendMail",
      { method: "POST" },
      { fetchFn },
    );

    expect(res.status).toBe(202);
  });

  it("throws GraphApiError carrying the status on a non-429 failure", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({ error: {} }, 404)]);

    const err = await graphFetch("ms-token", "/me/messages/nope", undefined, {
      fetchFn,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(404);
    expect((err as GraphApiError).message).toContain("404");
  });

  it("waits a small Retry-After via the injected sleep and retries", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({}, 429, { "Retry-After": "3" }),
      jsonResponse({ ok: 1 }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    const res = await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    });

    expect(res.status).toBe(200);
    expect(waits).toEqual([3000]);
    expect(urls).toHaveLength(2);
  });

  it("fails fast on a Retry-After beyond the ceiling without sleeping", async () => {
    // A multi-minute throttle must not park the session's synchronous
    // dispatch — fail the call immediately.
    const { fetchFn } = scriptedFetch([
      jsonResponse({}, 429, { "Retry-After": "300" }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    const err = await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(429);
    expect((err as GraphApiError).message).toContain("exceeds");
    expect(waits).toEqual([]);
  });

  it("falls back to bounded exponential backoff when the header is absent", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse({ ok: 1 }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    const res = await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    });

    expect(res.status).toBe(200);
    expect(waits).toEqual([1000, 2000]);
  });

  it("treats an unparseable Retry-After (HTTP-date) as absent", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse({}, 429, { "Retry-After": "Wed, 15 Jul 2026 09:00:00 GMT" }),
      jsonResponse({ ok: 1 }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    });

    expect(waits).toEqual([1000]);
  });

  it("gives up after GRAPH_MAX_RETRIES consecutive 429s", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({}, 429, { "Retry-After": "1" }),
      jsonResponse({}, 429, { "Retry-After": "1" }),
      jsonResponse({}, 429, { "Retry-After": "1" }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    const err = await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(429);
    // Initial attempt + the two retries, each retry preceded by one wait.
    expect(urls).toHaveLength(1 + GRAPH_MAX_RETRIES);
    expect(waits).toEqual([1000, 1000]);
  });

  it("honors a Retry-After exactly at the ceiling", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse({}, 429, {
        "Retry-After": String(GRAPH_RETRY_AFTER_CEILING_SECONDS),
      }),
      jsonResponse({ ok: 1 }),
    ]);
    const { sleepFn, waits } = recordingSleep();

    await graphFetch("ms-token", "/me/messages", undefined, {
      fetchFn,
      sleepFn,
    });

    expect(waits).toEqual([GRAPH_RETRY_AFTER_CEILING_SECONDS * 1000]);
  });
});

describe("graphPagedList", () => {
  interface Row {
    id: string;
  }

  const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

  it("returns a single page's rows without following anything", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({ value: rows("a", "b") }),
    ]);

    const result = await graphPagedList<Row>(
      "ms-token",
      "/me/messages?$top=5",
      5,
      { fetchFn },
    );

    expect(result).toEqual(rows("a", "b"));
    expect(urls).toHaveLength(1);
  });

  it("follows @odata.nextLink verbatim to accumulate rows", async () => {
    const nextLink = `${GRAPH_BASE}/me/messages?%24skiptoken=page2-opaque`;
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({ value: rows("a", "b"), "@odata.nextLink": nextLink }),
      jsonResponse({ value: rows("c") }),
    ]);

    const result = await graphPagedList<Row>(
      "ms-token",
      "/me/messages?$top=5",
      5,
      { fetchFn },
    );

    expect(result).toEqual(rows("a", "b", "c"));
    // The second request is the nextLink exactly as issued.
    expect(urls[1]).toBe(nextLink);
  });

  it("stops at maxResults mid-page and never over-returns", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: rows("a", "b", "c", "d"),
        "@odata.nextLink": `${GRAPH_BASE}/never-followed`,
      }),
    ]);

    const result = await graphPagedList<Row>(
      "ms-token",
      "/me/messages?$top=3",
      3,
      { fetchFn },
    );

    expect(result).toEqual(rows("a", "b", "c"));
    // maxResults satisfied mid-page: the nextLink is not followed.
    expect(urls).toHaveLength(1);
  });

  it("stops at the page cap even while nextLink continues", async () => {
    const pages = Array.from({ length: GRAPH_PAGE_CAP }, (_, i) =>
      jsonResponse({
        value: rows(`p${String(i)}`),
        "@odata.nextLink": `${GRAPH_BASE}/page-${String(i + 1)}`,
      }),
    );
    const { fetchFn, urls } = scriptedFetch(pages);

    const result = await graphPagedList<Row>("ms-token", "/page-0", 20, {
      fetchFn,
    });

    // One row per page, the walk cut at the cap — never draining the folder.
    expect(result).toHaveLength(GRAPH_PAGE_CAP);
    expect(urls).toHaveLength(GRAPH_PAGE_CAP);
  });

  it("stops when a page carries no nextLink before the bounds bind", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: rows("a"),
        "@odata.nextLink": `${GRAPH_BASE}/page-2`,
      }),
      jsonResponse({ value: rows("b") }),
    ]);

    const result = await graphPagedList<Row>("ms-token", "/page-1", 10, {
      fetchFn,
    });

    expect(result).toEqual(rows("a", "b"));
    expect(urls).toHaveLength(2);
  });

  it("fails the walk on a nextLink pointing off Graph's origin", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: rows("a"),
        "@odata.nextLink": "https://attacker.example/drain",
      }),
    ]);

    await expect(
      graphPagedList<Row>("ms-token", "/me/messages", 5, { fetchFn }),
    ).rejects.toThrow("Refusing non-Graph URL");
    // Only the first (legitimate) page was ever fetched.
    expect(urls).toHaveLength(1);
  });

  it("returns [] for an empty collection", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({ value: [] })]);

    const result = await graphPagedList<Row>("ms-token", "/me/messages", 5, {
      fetchFn,
    });

    expect(result).toEqual([]);
  });

  it("propagates a GraphApiError from a failing page", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({}, 403)]);

    await expect(
      graphPagedList<Row>("ms-token", "/me/messages", 5, { fetchFn }),
    ).rejects.toThrow(GraphApiError);
  });
});
