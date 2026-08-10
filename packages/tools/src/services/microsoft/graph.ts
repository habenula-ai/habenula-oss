// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Microsoft Graph request substrate — the provider-level plumbing every
 * Microsoft service reuses: the /v1.0 base and Bearer
 * assembly, bounded `@odata.nextLink` pagination, and bounded `429` +
 * `Retry-After` throttling. Deliberately a sibling of provider.ts, not part
 * of any one service's client: outlook-mail-client.ts holds only what is
 * mail-specific.
 */

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * The only origin an absolute URL — a `nextLink` — may target. The Bearer
 * token rides every request, so a foreign host appearing in a response body
 * must fail before the token is attached, never after.
 */
const GRAPH_ORIGIN = new URL(GRAPH_BASE).origin;

/**
 * Ceiling on an honored `Retry-After`, in seconds. Microsoft's guidance is to
 * honor the header; the cap is what makes honoring it safe on this runtime —
 * no per-tool-call timeout exists currently, so this ceiling is the operative
 * bound on how long a throttled Graph call can stall the session's
 * synchronous dispatch. A larger value fails the call immediately rather than
 * parking the user's turn on a server-dictated interval.
 */
export const GRAPH_RETRY_AFTER_CEILING_SECONDS = 5;

/** Retries after the initial attempt — worst case ~10s of injected wait. */
export const GRAPH_MAX_RETRIES = 2;

/**
 * Ceiling on `nextLink` pages one call walks. `$top` is set to the governed
 * maxResults so one page normally satisfies the request; the page cap is the
 * separate bound that keeps a Graph walk from spending the Worker subrequest
 * budget — "follow nextLink until exhausted" would walk the whole mailbox.
 */
export const GRAPH_PAGE_CAP = 5;

export class GraphApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

type FetchFn = typeof globalThis.fetch;
type SleepFn = (ms: number) => Promise<void>;

/** Injectable I/O for testing: tests never contact Graph or wall-wait. */
export interface GraphDeps {
  fetchFn?: FetchFn;
  sleepFn?: SleepFn;
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying a 429, in milliseconds. A plain-seconds
 * `Retry-After` within the ceiling is honored; over the ceiling fails the
 * call immediately (never an unbounded server-dictated sleep). An absent or
 * unparseable header (e.g. an HTTP-date form) falls back to bounded
 * exponential backoff — 1s then 2s — under the same ceiling.
 */
function throttleWaitMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      if (seconds > GRAPH_RETRY_AFTER_CEILING_SECONDS) {
        throw new GraphApiError(
          429,
          `Graph throttled (429): Retry-After ${String(seconds)}s exceeds the ${String(GRAPH_RETRY_AFTER_CEILING_SECONDS)}s ceiling`,
        );
      }
      return seconds * 1000;
    }
  }
  return Math.min(2 ** attempt, GRAPH_RETRY_AFTER_CEILING_SECONDS) * 1000;
}

/**
 * One authenticated Graph request with the bounded 429 loop. A relative path
 * (leading `/`) resolves against GRAPH_BASE; an absolute URL — a `nextLink` —
 * must be on Graph's own origin and is then followed verbatim, never
 * reconstructed (parsing the origin is verification, not rewriting: the
 * request goes out character-for-character as issued). Throws GraphApiError
 * on any remaining non-OK status; returns the raw Response so callers handle
 * a 202-no-body without a forced JSON parse. The access token is used for
 * the request(s) and never stored.
 */
export async function graphFetch(
  token: string,
  urlOrPath: string,
  init?: RequestInit,
  deps?: GraphDeps,
): Promise<Response> {
  const fetchFn = deps?.fetchFn ?? globalThis.fetch;
  const sleepFn = deps?.sleepFn ?? defaultSleep;
  let url: string;
  if (/^https:\/\//.test(urlOrPath)) {
    // A nextLink is trusted enough to follow, not enough to hand the user's
    // token to an arbitrary host named in a response body.
    const origin = new URL(urlOrPath).origin;
    if (origin !== GRAPH_ORIGIN) {
      throw new Error(
        `Refusing non-Graph URL (${origin}): the bearer token is only ever sent to ${GRAPH_ORIGIN}`,
      );
    }
    url = urlOrPath;
  } else {
    url = `${GRAPH_BASE}${urlOrPath}`;
  }

  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const res = await fetchFn(url, { ...init, headers });

    if (res.status !== 429) {
      if (!res.ok) {
        throw new GraphApiError(
          res.status,
          `Graph request failed (${String(res.status)})`,
        );
      }
      return res;
    }

    if (attempt >= GRAPH_MAX_RETRIES) {
      throw new GraphApiError(
        429,
        `Graph throttled (429): still throttled after ${String(GRAPH_MAX_RETRIES)} retries`,
      );
    }
    await sleepFn(throttleWaitMs(res.headers.get("Retry-After"), attempt));
  }
}

/** One page of a Graph collection response. */
interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * GET a Graph collection, following `@odata.nextLink` verbatim (origin-pinned
 * — see graphFetch) and stopping at `maxResults` rows or GRAPH_PAGE_CAP
 * pages, whichever comes first — never
 * draining the folder. Returns at most `maxResults` rows. Callers set
 * `$top = maxResults` on `firstUrl` so one page normally satisfies the
 * request; the walk exists for the responses that page anyway (`$search`
 * caps its result sets regardless of `$top`).
 */
export async function graphPagedList<T>(
  token: string,
  firstUrl: string,
  maxResults: number,
  deps?: GraphDeps,
): Promise<T[]> {
  const rows: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; page < GRAPH_PAGE_CAP && url !== undefined; page++) {
    const res = await graphFetch(token, url, undefined, deps);
    const data = (await res.json()) as GraphPage<T>;
    rows.push(...(data.value ?? []));
    if (rows.length >= maxResults) {
      break;
    }
    url = data["@odata.nextLink"];
  }
  return rows.slice(0, maxResults);
}
