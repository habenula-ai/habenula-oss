// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
import { listRepositories } from "./github-client.js";

/**
 * The default-owner noun: with no owner named, github_list lists everything
 * the account can access, governed under this sentinel. `@` cannot appear in
 * a GitHub login (logins are alphanumeric plus hyphen), so the sentinel can
 * never collide with a real owner — the same collision-proofing as Slack's
 * `@handle` and gmail's sentinel nouns.
 */
export const GITHUB_OWNER_SENTINEL = "@me";

/** Default repo count returned to the LLM when `limit` is omitted. */
export const GITHUB_LIST_DEFAULT_LIMIT = 100;

/**
 * Upper bound on github_list's `limit` — the count of repos returned to the
 * LLM, distinct from GITHUB_LIST_MAX_SCAN (the client's paging safety cap).
 */
export const GITHUB_LIST_MAX_LIMIT = 1000;

const NO_CREDENTIAL: ToolExecutionResult = {
  success: false,
  error: "No credential found for service: github",
};

/**
 * The owner noun: the lowercased owner login, or the `@me` sentinel for
 * every ownerless shape. The emptiness check precedes the coercion on
 * purpose — a naive `String(params.owner).toLowerCase()` yields the literal
 * noun "undefined" for a missing owner and "" for an empty one, so a default
 * listing would govern under "undefined" instead of `@me`. Lowercased
 * because GitHub logins are case-insensitive: `Torvalds` and `torvalds` must
 * govern as one noun.
 */
function ownerNoun(params: Record<string, unknown>): string {
  const owner = params.owner;
  if (typeof owner !== "string" || owner === "") {
    return GITHUB_OWNER_SENTINEL;
  }
  return owner.toLowerCase();
}

/**
 * List the repositories the connected GitHub account can access, governed on
 * the repository owner. Deliberately declares NO `requiredScopes`: a GitHub
 * App user token's `scope` is always the empty string (its access lives in
 * the App's fine-grained permissions, not classic scopes), so a scope gate
 * would check an always-empty list and deny every call `needs_authorization`
 * before dispatch. GitHub relies on governance (noun binding + hold) and the
 * App's read-only permission grant for its blast-radius bound. Scaffolding
 * is inline, as for Slack's tools — GitHub reuses neither the email
 * capability builder nor Slack's channel helpers.
 */
export const GITHUB_LIST: Tool = {
  service: "github",
  verb: "list",
  description:
    "List GitHub repositories the connected account can access. Optionally " +
    "takes an owner (a GitHub user or organization login) to list only that " +
    "owner's repositories; without one, lists repositories across all " +
    "owners. Returns each repository's owner, name, visibility, and " +
    "description.",
  inputSchema: {
    type: "object",
    properties: {
      owner: {
        type: "string",
        description:
          "Repository owner to filter by — a GitHub user or organization " +
          "login, e.g. torvalds. Omit to list across all owners.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: GITHUB_LIST_MAX_LIMIT,
        description:
          `Maximum number of repositories to return. Defaults to ` +
          `${GITHUB_LIST_DEFAULT_LIMIT}, at most ${GITHUB_LIST_MAX_LIMIT}.`,
      },
    },
  },
  nounExtractor: ownerNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    // Re-validate the optional params — the input schema is advisory to the
    // LLM, not enforced upstream.
    if (params.owner !== undefined && typeof params.owner !== "string") {
      return {
        success: false,
        error: "Invalid parameter: owner must be a GitHub owner login",
      };
    }
    const limit = params.limit ?? GITHUB_LIST_DEFAULT_LIMIT;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > GITHUB_LIST_MAX_LIMIT
    ) {
      return {
        success: false,
        error:
          `Invalid parameter: limit must be an integer between 1 and ` +
          `${GITHUB_LIST_MAX_LIMIT}`,
      };
    }
    // An empty owner is the ownerless shape (governed as @me above), so it
    // routes to the default listing like a missing one.
    const owner = params.owner === "" ? undefined : (params.owner as string | undefined);
    try {
      const listing = await listRepositories(token, { owner });
      const repos = listing.repos.slice(0, limit);
      // "What you see is not the complete set" from either cause: the
      // client's scan cap (GITHUB_LIST_MAX_SCAN) or `limit` trimming here —
      // never presented as exhaustive.
      const truncated = listing.truncated || repos.length < listing.repos.length;
      return {
        success: true,
        data: {
          repos,
          truncated,
          ...(truncated
            ? {
                // A zero-length trimmed set with truncated=true is only
                // reachable via the scan cap (limit trimming never empties a
                // non-empty set), i.e. the filtered owner's block may sort
                // past GITHUB_LIST_MAX_SCAN — word it as unreached, not as
                // "beyond the 0 returned".
                note:
                  repos.length === 0
                    ? `Listing is incomplete: the repository set was too ` +
                      `large to scan fully, so matches may exist beyond ` +
                      `what was searched.`
                    : `Listing is incomplete: more repositories may exist ` +
                      `beyond the ${repos.length} returned.`,
              }
            : {}),
        },
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Tool execution failed";
      return { success: false, error: message };
    }
  },
};

/**
 * The github service: declarative data only. Its OAuth machinery lives on
 * the `github` provider strategy. `connect.scopes` is empty — a GitHub App's
 * user flow requests no scope parameter (repository access is chosen at App
 * install), and the stored credential reports none.
 */
export const github: ServiceDefinition = {
  service: "github",
  connect: {
    type: "oauth",
    provider: "github",
    scopes: [],
  },
  tools: [GITHUB_LIST],
};
