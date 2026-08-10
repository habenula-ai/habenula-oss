import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  github,
  GITHUB_LIST,
  GITHUB_LIST_DEFAULT_LIMIT,
  GITHUB_LIST_MAX_LIMIT,
  GITHUB_OWNER_SENTINEL,
} from "../../../src/services/github/github";
import { toolName } from "../../../src/tools";

/** A raw GitHub repo item as the list endpoints return it. */
function rawRepo(owner: string, name: string) {
  return {
    name,
    full_name: `${owner}/${name}`,
    private: false,
    description: `${name} description`,
    owner: { login: owner },
  };
}

const ctxWithCredential = {
  userId: "github-tool-user",
  credential: {
    access_token: "ghu_placeholder-user-access-token",
    refresh_token: "ghr_placeholder-refresh-token",
    expiry_unix: 4102444800,
    scopes: [],
  },
};

describe("github service definition", () => {
  it("declares the github service on the github provider with empty scopes", () => {
    expect(github.service).toBe("github");
    expect(github.connect).toEqual({
      type: "oauth",
      provider: "github",
      // Empty on purpose: a GitHub App's user flow requests no scope
      // parameter — repository access is chosen at App install.
      scopes: [],
    });
    expect(github.tools).toEqual([GITHUB_LIST]);
  });

  it("derives the github_list tool name", () => {
    expect(toolName(GITHUB_LIST)).toBe("github_list");
  });

  it("github_list declares NO requiredScopes", () => {
    // The trap guard: a GitHub App user token's scope
    // list is always empty, so declaring requiredScopes would send every
    // call through the pre-policy scope gate against an always-empty list
    // and deny it needs_authorization before dispatch. The field must stay
    // absent — this assertion keeps a later edit from silently adding the
    // always-deny gate.
    expect(GITHUB_LIST.requiredScopes).toBeUndefined();
    expect("requiredScopes" in GITHUB_LIST).toBe(false);
  });

  it("exposes an object input schema with optional owner and limit", () => {
    expect(GITHUB_LIST.inputSchema.type).toBe("object");
    expect(GITHUB_LIST.inputSchema.properties.owner).toBeDefined();
    expect(GITHUB_LIST.inputSchema.properties.limit).toBeDefined();
    // Both optional — no required list (the default listing takes no params).
    expect(GITHUB_LIST.inputSchema.required ?? []).toEqual([]);
  });
});

describe("github_list nounExtractor (owner noun + @me sentinel)", () => {
  it("lowercases a named owner (GitHub logins are case-insensitive)", () => {
    expect(GITHUB_LIST.nounExtractor({ owner: "Torvalds" })).toBe("torvalds");
    expect(GITHUB_LIST.nounExtractor({ owner: "torvalds" })).toBe("torvalds");
    expect(GITHUB_LIST.nounExtractor({ owner: "Acme-Inc" })).toBe("acme-inc");
  });

  it("returns the @me sentinel for every ownerless shape", () => {
    // Emptiness before coercion: a naive String(owner).toLowerCase() would
    // govern a default listing under the literal noun "undefined" or "".
    expect(GITHUB_LIST.nounExtractor({})).toBe(GITHUB_OWNER_SENTINEL);
    expect(GITHUB_LIST.nounExtractor({ owner: "" })).toBe(
      GITHUB_OWNER_SENTINEL,
    );
    expect(GITHUB_LIST.nounExtractor({ owner: undefined })).toBe(
      GITHUB_OWNER_SENTINEL,
    );
    expect(GITHUB_LIST.nounExtractor({})).not.toBe("undefined");
  });

  it("the sentinel cannot collide with a real owner login", () => {
    // `@` cannot appear in a GitHub login (alphanumeric plus hyphen), so a
    // grant on @me can never match a named-owner noun or vice versa.
    expect(GITHUB_OWNER_SENTINEL.startsWith("@")).toBe(true);
  });
});

describe("github_list execute", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchedUrls: URL[];

  /** Canned GitHub REST fetch: /user/repos and one org, page-aware. */
  function installGithubFetch(
    userRepos: ReturnType<typeof rawRepo>[],
    orgRepos?: ReturnType<typeof rawRepo>[],
  ) {
    globalThis.fetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input.toString(),
      );
      fetchedUrls.push(url);
      const page = Number(url.searchParams.get("page") ?? "1");
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/user/repos") {
        return json(page === 1 ? userRepos : []);
      }
      if (url.pathname.startsWith("/orgs/")) {
        if (!orgRepos) {
          return json({ message: "Not Found" }, 404);
        }
        return json(page === 1 ? orgRepos : []);
      }
      return json({ message: "unknown endpoint" }, 500);
    }) as typeof globalThis.fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchedUrls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fails with the standard no-credential error when no credential is injected", async () => {
    const result = await GITHUB_LIST.execute({}, { userId: "no-cred-user" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("No credential found for service: github");
    // Fails before any fetch.
    expect(fetchedUrls).toHaveLength(0);
  });

  it("lists the default (ownerless) listing from /user/repos", async () => {
    installGithubFetch([
      rawRepo("jane", "dotfiles"),
      rawRepo("acme-inc", "api"),
    ]);

    const result = await GITHUB_LIST.execute({}, ctxWithCredential);

    expect(result.success).toBe(true);
    const data = result.data as {
      repos: { fullName: string }[];
      truncated: boolean;
    };
    expect(data.repos.map((r) => r.fullName)).toEqual([
      "jane/dotfiles",
      "acme-inc/api",
    ]);
    expect(data.truncated).toBe(false);
    expect(fetchedUrls[0]!.pathname).toBe("/user/repos");
  });

  it("routes a named owner through the org endpoint", async () => {
    installGithubFetch([], [rawRepo("acme-inc", "api")]);

    const result = await GITHUB_LIST.execute(
      { owner: "acme-inc" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(fetchedUrls[0]!.pathname).toBe("/orgs/acme-inc/repos");
  });

  it("treats an empty owner as the default listing (coherent with the @me noun)", async () => {
    installGithubFetch([rawRepo("jane", "dotfiles")]);

    const result = await GITHUB_LIST.execute({ owner: "" }, ctxWithCredential);

    expect(result.success).toBe(true);
    // Governed as @me, listed as @me — never an org probe for "".
    expect(fetchedUrls[0]!.pathname).toBe("/user/repos");
  });

  it("applies limit after the client returns and surfaces the trim as truncated", async () => {
    installGithubFetch([
      rawRepo("jane", "alpha"),
      rawRepo("jane", "beta"),
      rawRepo("jane", "gamma"),
    ]);

    const result = await GITHUB_LIST.execute({ limit: 2 }, ctxWithCredential);

    expect(result.success).toBe(true);
    const data = result.data as {
      repos: unknown[];
      truncated: boolean;
      note?: string;
    };
    // Trimming is surfaced to the LLM, not silent: a limit below the
    // available count forces truncated: true plus the incompleteness note.
    expect(data.repos).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.note).toBeTruthy();
  });

  it("reports truncated: false with no note when the listing is complete", async () => {
    installGithubFetch([rawRepo("jane", "alpha")]);

    const result = await GITHUB_LIST.execute(
      { limit: GITHUB_LIST_DEFAULT_LIMIT },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    const data = result.data as { truncated: boolean; note?: string };
    expect(data.truncated).toBe(false);
    expect(data.note).toBeUndefined();
  });

  it("rejects an invalid limit before any fetch", async () => {
    for (const limit of [0, -1, 1.5, GITHUB_LIST_MAX_LIMIT + 1, "10"]) {
      const result = await GITHUB_LIST.execute({ limit }, ctxWithCredential);
      expect(result.success).toBe(false);
      expect(result.error).toContain("limit must be an integer between");
    }
    expect(fetchedUrls).toHaveLength(0);
  });

  it("rejects a non-string owner before any fetch", async () => {
    const result = await GITHUB_LIST.execute(
      { owner: 42 },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("owner must be a GitHub owner login");
    expect(fetchedUrls).toHaveLength(0);
  });

  it("wraps a client error as an execution failure, not a throw", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response("Bad credentials", { status: 401 })) as typeof globalThis.fetch;

    const result = await GITHUB_LIST.execute({}, ctxWithCredential);

    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub /user/repos failed (401)");
  });
});
