// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export const GITHUB_API_BASE = "https://api.github.com";

/**
 * GitHub rejects any request with no User-Agent header with a 403, so every
 * call sends this fixed Habenula identifier.
 */
export const GITHUB_USER_AGENT = "Habenula";

/**
 * GitHub's REST API version, sent as `X-GitHub-Api-Version` on every request.
 * Pinned per GitHub's API-versioning guidance — a request without it defaults
 * to the latest version, which could shift response shapes under us. Bump this
 * date only after verifying the new version against live GitHub docs.
 */
export const GITHUB_API_VERSION = "2022-11-28";

/**
 * Uniform cap on how many repositories any single listing accumulates —
 * 10 pages × per_page 100 — so one call can never page unboundedly and
 * exhaust the Workers subrequest budget. A listing cut off here reports
 * `truncated: true`; one that reaches its natural end reports `false`.
 */
export const GITHUB_LIST_MAX_SCAN = 1000;

/** Repos per page — GitHub's per_page maximum for the repo list endpoints. */
const REPOS_PAGE_SIZE = 100;

type FetchFn = typeof globalThis.fetch;

export class GithubApiError extends Error {
  constructor(
    /** The HTTP status GitHub answered with (e.g. 404 for a non-org owner). */
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

export interface GithubRepo {
  /** The owner's login, as GitHub reports it (original casing). */
  owner: string;
  name: string;
  /** `owner/name` — the sort key the listing is ordered by. */
  fullName: string;
  private: boolean;
  description: string;
}

export interface GithubRepoListing {
  repos: GithubRepo[];
  /** True when the listing was cut off at GITHUB_LIST_MAX_SCAN. */
  truncated: boolean;
}

/** The repo fields read off GitHub's response items. */
interface RawRepo {
  name?: string;
  full_name?: string;
  private?: boolean;
  description?: string | null;
  owner?: { login?: string };
}

/**
 * One GitHub REST call. Sends the three headers GitHub requires or
 * recommends on every request — `User-Agent` (a 403 without it),
 * `Accept: application/vnd.github+json`, and a pinned
 * `X-GitHub-Api-Version` — and surfaces a non-2xx as a GithubApiError
 * carrying the status, so callers can distinguish the org-probe 404 from a
 * real failure. The access token is used for a single request, never stored.
 */
async function githubApiCall<T>(
  accessToken: string,
  path: string,
  query: Record<string, string>,
  fetchFn: FetchFn,
): Promise<T> {
  const url = new URL(`${GITHUB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const res = await fetchFn(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": GITHUB_USER_AGENT,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GithubApiError(
      res.status,
      `GitHub ${path} failed (${res.status}): ${text}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Page one repo-list source to its natural end or GITHUB_LIST_MAX_SCAN,
 * whichever comes first. `sort=full_name` / `direction=asc` pin a
 * deterministic order — and because `full_name` is `owner/repo`, every
 * owner's repos form one contiguous alphabetical block, the property the
 * filtered-scan fallback in listRepositories leans on. A page shorter than
 * per_page is the natural end (`truncated: false`); reaching the cap on full
 * pages reports `truncated: true`.
 *
 * Paging is intentionally independent of github_list's display `limit`:
 * GITHUB_LIST_MAX_SCAN is the only bound here, and the tool trims to `limit`
 * after the scan returns. That separation is what lets the filtered-scan
 * fallback reach an owner's block wherever it sorts; a `limit`-aware early
 * stop would break it.
 */
async function pageRepos(
  accessToken: string,
  path: string,
  fetchFn: FetchFn,
): Promise<GithubRepoListing> {
  const repos: GithubRepo[] = [];
  let page = 1;
  for (;;) {
    const batch = await githubApiCall<RawRepo[]>(
      accessToken,
      path,
      {
        per_page: String(REPOS_PAGE_SIZE),
        sort: "full_name",
        direction: "asc",
        page: String(page),
      },
      fetchFn,
    );

    for (const r of batch) {
      repos.push({
        owner: r.owner?.login ?? "",
        name: r.name ?? "",
        fullName: r.full_name ?? "",
        private: r.private ?? false,
        description: r.description ?? "",
      });
    }

    if (batch.length < REPOS_PAGE_SIZE) {
      return { repos, truncated: false };
    }
    if (repos.length >= GITHUB_LIST_MAX_SCAN) {
      return { repos, truncated: true };
    }
    page += 1;
  }
}

/**
 * List repositories the token can access, selecting the source by owner:
 *
 * - **No owner** → `GET /user/repos`: everything the token can access,
 *   across all owners.
 * - **Owner that is an organization** → `GET /orgs/{owner}/repos`: that
 *   org's repos the token can access, private ones included — complete in
 *   far fewer pages than a full scan.
 * - **Owner that is not an org** → the org call answers 404, and that 404 is
 *   the fallback signal: the `/user/repos` scan filtered client-side to that
 *   owner. GitHub also answers 404 (not 403) for an org the token cannot
 *   see, so an unreachable org and a real user owner both fall here and list
 *   as an empty result, not an error. The fallback is deliberate:
 *   `GET /users/{owner}/repos` is public-only and would drop the private
 *   repos and collaborations the token can access.
 *
 * Every source is bounded by the same App-permissions ∩ installed-repos ∩
 * user-authorization — routing changes completeness and page count, never
 * what the credential can reach. Owner comparison is case-insensitive
 * (GitHub logins are case-insensitive).
 */
export async function listRepositories(
  accessToken: string,
  params: { owner?: string },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GithubRepoListing> {
  const owner = params.owner;
  if (!owner) {
    return pageRepos(accessToken, "/user/repos", fetchFn);
  }

  try {
    return await pageRepos(
      accessToken,
      `/orgs/${encodeURIComponent(owner)}/repos`,
      fetchFn,
    );
  } catch (err) {
    if (!(err instanceof GithubApiError) || err.status !== 404) {
      throw err;
    }
  }

  // Non-org (or unreachable-org) owner: best-effort filtered scan. The scan
  // is bounded by GITHUB_LIST_MAX_SCAN, so `truncated` reflects the scan —
  // an empty result within a truncated scan means the owner's block may sort
  // past the cap, not that nothing exists under that owner.
  const scan = await pageRepos(accessToken, "/user/repos", fetchFn);
  const target = owner.toLowerCase();
  return {
    repos: scan.repos.filter((r) => r.owner.toLowerCase() === target),
    truncated: scan.truncated,
  };
}
