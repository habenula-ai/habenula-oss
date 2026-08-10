import { describe, it, expect } from "vitest";
import {
  GITHUB_LIST_MAX_SCAN,
  GITHUB_USER_AGENT,
  GithubApiError,
  listRepositories,
} from "../../../src/services/github/github-client";
import type { GithubRepo } from "../../../src/services/github/github-client";

/** A raw GitHub repo item as the list endpoints return it. */
function rawRepo(owner: string, name: string, isPrivate = false) {
  return {
    name,
    full_name: `${owner}/${name}`,
    private: isPrivate,
    description: `${name} description`,
    owner: { login: owner },
  };
}

interface RecordedRequest {
  url: URL;
  headers: Headers;
}

/**
 * Build a fake fetch routing by pathname. Each route maps to either an
 * ordered list of pages (advanced by the `page` query param — a client that
 * drops pagination never reaches page two) or a canned error status. Records
 * every request's URL and headers.
 */
function githubFetch(
  routes: Record<
    string,
    { pages: ReturnType<typeof rawRepo>[][] } | { status: number; body?: string }
  >,
) {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requests.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    if (!route) {
      return new Response("Not Found", { status: 404 });
    }
    if ("status" in route) {
      return new Response(route.body ?? "error", { status: route.status });
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const body = route.pages[page - 1] ?? [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetchFn, requests };
}

/** `count` distinct repos for one owner — enough to fill scan pages. */
function repoPage(owner: string, count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) =>
    rawRepo(owner, `repo-${String(offset + i).padStart(4, "0")}`),
  );
}

describe("listRepositories — source selection by owner", () => {
  it("no owner pages GET /user/repos", async () => {
    const { fetchFn, requests } = githubFetch({
      "/user/repos": { pages: [[rawRepo("jane", "dotfiles", true)]] },
    });

    const listing = await listRepositories("test-token", {}, fetchFn);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/user/repos");
    expect(listing.truncated).toBe(false);
    expect(listing.repos).toEqual([
      {
        owner: "jane",
        name: "dotfiles",
        fullName: "jane/dotfiles",
        private: true,
        description: "dotfiles description",
      } satisfies GithubRepo,
    ]);
  });

  it("an org owner pages GET /orgs/{owner}/repos", async () => {
    const { fetchFn, requests } = githubFetch({
      "/orgs/acme-inc/repos": { pages: [[rawRepo("acme-inc", "api")]] },
    });

    const listing = await listRepositories(
      "test-token",
      { owner: "acme-inc" },
      fetchFn,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/orgs/acme-inc/repos");
    expect(listing.repos.map((r) => r.fullName)).toEqual(["acme-inc/api"]);
  });

  it("a non-org owner (org probe 404) falls back to the filtered /user/repos scan", async () => {
    const { fetchFn, requests } = githubFetch({
      "/orgs/jane/repos": { status: 404, body: '{"message":"Not Found"}' },
      "/user/repos": {
        pages: [
          [
            rawRepo("acme-inc", "api"),
            rawRepo("Jane", "dotfiles"),
            rawRepo("other", "misc"),
          ],
        ],
      },
    });

    // Case-insensitive filter: the caller's `jane` matches GitHub's `Jane`.
    const listing = await listRepositories(
      "test-token",
      { owner: "jane" },
      fetchFn,
    );

    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/orgs/jane/repos",
      "/user/repos",
    ]);
    expect(listing.repos.map((r) => r.fullName)).toEqual(["Jane/dotfiles"]);
    expect(listing.truncated).toBe(false);
  });

  it("an unreachable owner lists as an empty result, not an error", async () => {
    // GitHub answers 404 (not 403) for an org the token cannot see, so an
    // unreachable org and an unknown owner are indistinguishable here: both
    // fall to the scan and surface as "nothing visible under that owner".
    const { fetchFn } = githubFetch({
      "/orgs/secret-org/repos": { status: 404 },
      "/user/repos": { pages: [[rawRepo("jane", "dotfiles")]] },
    });

    const listing = await listRepositories(
      "test-token",
      { owner: "secret-org" },
      fetchFn,
    );

    expect(listing.repos).toEqual([]);
    expect(listing.truncated).toBe(false);
  });
});

describe("listRepositories — headers and query", () => {
  it("sends User-Agent, Accept, and X-GitHub-Api-Version on every request", async () => {
    // GitHub rejects any request with no User-Agent header with a 403.
    const { fetchFn, requests } = githubFetch({
      "/orgs/acme-inc/repos": { status: 404 },
      "/user/repos": { pages: [[rawRepo("jane", "dotfiles")]] },
    });

    await listRepositories("test-token", { owner: "acme-inc" }, fetchFn);

    expect(requests.length).toBeGreaterThan(1);
    for (const { headers } of requests) {
      expect(headers.get("User-Agent")).toBe(GITHUB_USER_AGENT);
      expect(headers.get("User-Agent")).toBeTruthy();
      expect(headers.get("Accept")).toBe("application/vnd.github+json");
      expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    }
  });

  it("pins the deterministic sort and page-size params", async () => {
    const { fetchFn, requests } = githubFetch({
      "/user/repos": { pages: [[rawRepo("jane", "dotfiles")]] },
    });

    await listRepositories("test-token", {}, fetchFn);

    const query = requests[0]!.url.searchParams;
    expect(query.get("sort")).toBe("full_name");
    expect(query.get("direction")).toBe("asc");
    expect(Number(query.get("per_page"))).toBeLessThanOrEqual(100);
    expect(Number(query.get("per_page"))).toBeGreaterThan(0);
  });
});

describe("listRepositories — pagination and the truncation contract", () => {
  it("pages to a natural end and reports truncated: false", async () => {
    // Two full pages then a short one — the page param must thread through.
    const { fetchFn, requests } = githubFetch({
      "/user/repos": {
        pages: [
          repoPage("jane", 100, 0),
          repoPage("jane", 100, 100),
          repoPage("jane", 7, 200),
        ],
      },
    });

    const listing = await listRepositories("test-token", {}, fetchFn);

    expect(listing.repos).toHaveLength(207);
    expect(listing.truncated).toBe(false);
    expect(requests.map((r) => r.url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("stops at GITHUB_LIST_MAX_SCAN on full pages and reports truncated: true", async () => {
    // Every page full: an unbounded lister would page forever and blow the
    // Workers subrequest budget; the cap holds it to exactly ten requests.
    const fullPages = Array.from({ length: 20 }, (_, p) =>
      repoPage("mega-corp", 100, p * 100),
    );
    const { fetchFn, requests } = githubFetch({
      "/user/repos": { pages: fullPages },
    });

    const listing = await listRepositories("test-token", {}, fetchFn);

    expect(listing.repos).toHaveLength(GITHUB_LIST_MAX_SCAN);
    expect(listing.truncated).toBe(true);
    expect(requests).toHaveLength(GITHUB_LIST_MAX_SCAN / 100);
  });

  it("an empty filtered result within a truncated scan surfaces the flag", async () => {
    // The owner's full_name block may sort past the cap — the empty result
    // must carry truncated: true, never read as a confirmed "nothing there".
    const fullPages = Array.from({ length: 10 }, (_, p) =>
      repoPage("aardvark", 100, p * 100),
    );
    const { fetchFn } = githubFetch({
      "/orgs/zzz-last/repos": { status: 404 },
      "/user/repos": { pages: fullPages },
    });

    const listing = await listRepositories(
      "test-token",
      { owner: "zzz-last" },
      fetchFn,
    );

    expect(listing.repos).toEqual([]);
    expect(listing.truncated).toBe(true);
  });
});

describe("listRepositories — error surfacing", () => {
  it("a non-404 error on the org endpoint throws, never falls back", async () => {
    const { fetchFn, requests } = githubFetch({
      "/orgs/acme-inc/repos": { status: 500, body: "server error" },
      "/user/repos": { pages: [[rawRepo("jane", "dotfiles")]] },
    });

    await expect(
      listRepositories("test-token", { owner: "acme-inc" }, fetchFn),
    ).rejects.toThrow("GitHub /orgs/acme-inc/repos failed (500)");
    // The 500 did not silently degrade into the scan.
    expect(requests.map((r) => r.url.pathname)).toEqual([
      "/orgs/acme-inc/repos",
    ]);
  });

  it("an error on /user/repos throws with the status and body", async () => {
    const { fetchFn } = githubFetch({
      "/user/repos": { status: 401, body: "Bad credentials" },
    });

    await expect(
      listRepositories("test-token", {}, fetchFn),
    ).rejects.toThrow("GitHub /user/repos failed (401): Bad credentials");
  });

  it("the thrown error carries the status for callers to route on", async () => {
    const { fetchFn } = githubFetch({
      "/user/repos": { status: 403, body: "rate limited" },
    });

    const err = await listRepositories("test-token", {}, fetchFn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(403);
  });
});
