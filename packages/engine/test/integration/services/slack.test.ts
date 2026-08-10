import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  slack,
  SLACK_READ,
  SLACK_SEND,
  SLACK_REPLY,
  SLACK_REACT,
  SLACK_EDIT,
  SLACK_UPLOAD,
  SLACK_LIST_CHANNELS,
  SLACK_SEARCH,
  SLACK_LIST_USERS,
  SLACK_DM_READ,
  SLACK_DM_SEND,
  SLACK_CAPABILITY_SCOPES,
  SLACK_CHANNELS_NOUN,
  SLACK_WORKSPACE_NOUN,
  SLACK_DIRECTORY_NOUN,
  SLACK_READ_DEFAULT_LIMIT,
  SLACK_READ_MAX_LIMIT,
  SLACK_SEARCH_MAX_LIMIT,
  SLACK_LIST_MAX_LIMIT,
  SLACK_USER_SCOPES,
} from "@habenula-ai/tools/services/slack/slack";
import type { Tool } from "@habenula-ai/tools";
import { toolName } from "@habenula-ai/tools";
import { seedCiphertext } from "../../helpers/seed-credential";

/**
 * Canned Slack Web API fetch covering every endpoint the tools speak: two
 * channels, a short history, post/update/react acks, one search match, a
 * two-member directory (one deactivated), a DM channel, and the three-step
 * upload flow. Records URLs and parsed JSON bodies in call order.
 */
function slackApiFetch() {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
    const json = (body: Record<string, unknown>) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/api/conversations.list")) {
      return json({
        ok: true,
        channels: [
          { id: "C100", name: "general" },
          { id: "C200", name: "eng-alerts" },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url.includes("/api/conversations.history")) {
      return json({
        ok: true,
        messages: [
          { user: "U111", text: "deploy is green", ts: "1700000002.000200" },
          { user: "U222", text: "starting deploy", ts: "1700000001.000100" },
        ],
      });
    }
    if (url.includes("/api/conversations.open")) {
      return json({ ok: true, channel: { id: "D900" } });
    }
    if (url.includes("/api/chat.postMessage")) {
      return json({ ok: true, channel: "C200", ts: "1700000003.000300" });
    }
    if (url.includes("/api/chat.update")) {
      return json({
        ok: true,
        channel: "C200",
        ts: "1700000001.000100",
        text: "edited text",
      });
    }
    if (url.includes("/api/reactions.add")) {
      return json({ ok: true });
    }
    if (url.includes("/api/search.messages")) {
      return json({
        ok: true,
        messages: {
          total: 1,
          matches: [
            {
              channel: { id: "C200", name: "eng-alerts" },
              user: "U111",
              username: "jane",
              text: "deploy failed",
              ts: "1700000004.000400",
              permalink:
                "https://ws.slack.com/archives/C200/p1700000004000400",
            },
          ],
        },
      });
    }
    if (url.includes("/api/users.list")) {
      return json({
        ok: true,
        members: [
          {
            id: "U111",
            name: "jane",
            deleted: false,
            is_bot: false,
            profile: { display_name: "Jane Doe" },
          },
          { id: "U222", name: "gone", deleted: true, profile: {} },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url.includes("/api/files.getUploadURLExternal")) {
      return json({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/ABC123",
        file_id: "F123",
      });
    }
    if (url.includes("files.slack.com/upload/")) {
      // Echo the received byte count, as Slack's sink does, so the client's
      // truncation guard sees a matching acknowledgement.
      const received =
        init?.body instanceof Uint8Array ? init.body.byteLength : 0;
      return new Response(`OK - ${received}`, { status: 200 });
    }
    if (url.includes("/api/files.completeUploadExternal")) {
      return json({ ok: true, files: [{ id: "F123", title: "note.md" }] });
    }
    return new Response("unknown endpoint", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetchFn, urls, bodies };
}

const ctxWithCredential = {
  userId: "slack-tool-user",
  credential: {
    access_token: "scrubbed-user-access-token",
    refresh_token: "scrubbed-user-refresh-token",
    expiry_unix: 4102444800,
    scopes: SLACK_USER_SCOPES,
  },
};

/** The channel-governed tools with minimal valid params for each. */
const CHANNEL_TOOL_PARAMS: [Tool, Record<string, unknown>][] = [
  [SLACK_READ, { channel: "general" }],
  [SLACK_SEND, { channel: "general", text: "hi" }],
  [
    SLACK_REPLY,
    { channel: "general", thread_ts: "1700000001.000100", text: "hi" },
  ],
  [
    SLACK_REACT,
    { channel: "general", timestamp: "1700000001.000100", emoji: "thumbsup" },
  ],
  [SLACK_EDIT, { channel: "general", ts: "1700000001.000100", text: "hi" }],
  [SLACK_UPLOAD, { channel: "general", filename: "note.md", content: "x" }],
];

describe("slack service definition", () => {
  it("declares the slack provider with the full launch user-scope set", () => {
    expect(slack.service).toBe("slack");
    expect(slack.connect).toEqual({
      type: "oauth",
      provider: "slack",
      scopes: SLACK_USER_SCOPES,
    });
    expect(slack.tools).toEqual([
      SLACK_READ,
      SLACK_SEND,
      SLACK_REPLY,
      SLACK_REACT,
      SLACK_EDIT,
      SLACK_UPLOAD,
      SLACK_LIST_CHANNELS,
      SLACK_SEARCH,
      SLACK_LIST_USERS,
      SLACK_DM_READ,
      SLACK_DM_SEND,
    ]);
    // The iterated catalog invariants exercise tools[0] with channel-shaped
    // params — SLACK_READ must stay first.
    expect(slack.tools[0]).toBe(SLACK_READ);
  });

  it("the user-scope set covers the expanded surface", () => {
    for (const scope of [
      "search:read",
      "reactions:write",
      "users:read",
      "im:write",
      "im:history",
      "files:write",
    ]) {
      expect(SLACK_USER_SCOPES).toContain(scope);
    }
  });

  it("requests no scope the shipped tools do not exercise (least privilege)", () => {
    // The DM tools open and read a 1:1 `im` only, so im:read and every mpim:*
    // scope are omitted — multi-party DM access stays deferred rather than
    // requesting standing consent nothing uses.
    for (const scope of [
      "im:read",
      "mpim:read",
      "mpim:write",
      "mpim:history",
    ]) {
      expect(SLACK_USER_SCOPES).not.toContain(scope);
    }
  });

  it("derives the governed slack_<verb> tool names", () => {
    expect(slack.tools.map(toolName)).toEqual([
      "slack_read",
      "slack_send",
      "slack_reply",
      "slack_react",
      "slack_edit",
      "slack_upload",
      "slack_list_channels",
      "slack_search",
      "slack_list_users",
      "slack_dm_read",
      "slack_dm_send",
    ]);
  });

 it("wires each tool's requiredScopes from the capability map", () => {
    // The scope precondition is live, so every tool sets requiredScopes from
    // the map: the entry is non-empty, its scopes are all ones Habenula
    // actually requests, and the tool's requiredScopes field is exactly that
    // entry (feeding the pre-policy gate in executeTool).
    for (const tool of slack.tools) {
      const scopes =
        SLACK_CAPABILITY_SCOPES[tool.verb as keyof typeof SLACK_CAPABILITY_SCOPES];
      expect(scopes.length).toBeGreaterThan(0);
      for (const scope of scopes) {
        expect(SLACK_USER_SCOPES).toContain(scope);
      }
      expect(tool.requiredScopes).toEqual(scopes);
    }
  });

  it("channel tools require the governed channel slot in their schemas", () => {
    for (const [tool] of CHANNEL_TOOL_PARAMS) {
      expect(tool.inputSchema.required).toContain("channel");
      expect(tool.inputSchema.properties.channel).toBeDefined();
    }
    expect(SLACK_SEND.inputSchema.required).toContain("text");
    expect(SLACK_DM_READ.inputSchema.required).toContain("handle");
    expect(SLACK_DM_SEND.inputSchema.required).toEqual(["handle", "text"]);
    expect(SLACK_SEARCH.inputSchema.required).toEqual(["query"]);
  });

  it("channel-tool nounExtractors return the channel name verbatim (pattern policies match)", () => {
    // Verbatim — never normalized, prefixed, or resolved to an id — so a
    // channel-pattern policy like eng-* matches what the caller sent.
    for (const [tool] of CHANNEL_TOOL_PARAMS) {
      expect(tool.nounExtractor({ channel: "eng-alerts" })).toBe("eng-alerts");
      expect(tool.nounExtractor({ channel: "general", text: "x" })).toBe(
        "general",
      );
    }
  });

  it("account-level nouns are uppercase sentinels, independent of params", () => {
    // Uppercase ON PURPOSE: Slack forces channel names lowercase, so an
    // uppercase sentinel can never collide with a real channel name.
    const sentinels: [Tool, string][] = [
      [SLACK_LIST_CHANNELS, SLACK_CHANNELS_NOUN],
      [SLACK_SEARCH, SLACK_WORKSPACE_NOUN],
      [SLACK_LIST_USERS, SLACK_DIRECTORY_NOUN],
    ];
    for (const [tool, sentinel] of sentinels) {
      expect(sentinel).toBe(sentinel.toUpperCase());
      expect(tool.nounExtractor({})).toBe(sentinel);
      // Params never leak into the noun — the query is audited as parameter
      // metadata, not governed on.
      expect(
        tool.nounExtractor({ channel: "eng-alerts", query: "secret plans" }),
      ).toBe(sentinel);
    }
  });

  it("DM nouns are @-prefixed handles, disjoint from channel nouns by construction", () => {
    for (const tool of [SLACK_DM_READ, SLACK_DM_SEND]) {
      expect(tool.nounExtractor({ handle: "jane" })).toBe("@jane");
      // Any leading @s are canonicalized identically for the noun and for
      // resolution, so the governed noun is always `@` + the exact string the
      // executor resolves — they cannot diverge on a doubled or malformed @.
      expect(tool.nounExtractor({ handle: "@jane" })).toBe("@jane");
      expect(tool.nounExtractor({ handle: "@@jane" })).toBe("@jane");
      // A malformed handle canonicalizes to the bare @ sentinel; the executor
      // rejects it before any fetch.
      expect(tool.nounExtractor({ handle: "@" })).toBe("@");
      expect(tool.nounExtractor({ handle: 42 })).toBe("@");
    }
  });
});

describe("slack tool executors", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("slack_read resolves the channel name then returns history", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_READ.execute(
      { channel: "eng-alerts", limit: 2 },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      messages: [
        { user: "U111", text: "deploy is green", ts: "1700000002.000200" },
        { user: "U222", text: "starting deploy", ts: "1700000001.000100" },
      ],
    });
    // Name resolution first, then history against the RESOLVED id.
    expect(urls[0]).toContain("conversations.list");
    expect(urls[1]).toContain("conversations.history");
    expect(new URL(urls[1]!).searchParams.get("channel")).toBe("C200");
  });

  it("slack_read defaults limit and passes it through", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_READ.execute(
      { channel: "general" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(new URL(urls[1]!).searchParams.get("limit")).toBe(
      String(SLACK_READ_DEFAULT_LIMIT),
    );
  });

  it("slack_send resolves the channel then posts as the user", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_SEND.execute(
      { channel: "eng-alerts", text: "deploy done" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      ts: "1700000003.000300",
    });
    expect(urls[0]).toContain("conversations.list");
    expect(urls[1]).toContain("chat.postMessage");
  });

  it("slack_reply resolves the channel then posts into the thread", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_REPLY.execute(
      { channel: "eng-alerts", thread_ts: "1700000001.000100", text: "on it" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      thread_ts: "1700000001.000100",
      ts: "1700000003.000300",
    });
    expect(urls[1]).toContain("chat.postMessage");
    // thread_ts rides the post against the RESOLVED channel id.
    expect(bodies[1]).toEqual({
      channel: "C200",
      thread_ts: "1700000001.000100",
      text: "on it",
    });
  });

  it("slack_react resolves the channel then adds the reaction", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_REACT.execute(
      {
        channel: "eng-alerts",
        timestamp: "1700000002.000200",
        emoji: "rocket",
      },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      timestamp: "1700000002.000200",
      emoji: "rocket",
    });
    expect(urls[1]).toContain("reactions.add");
    expect(bodies[1]).toEqual({
      channel: "C200",
      timestamp: "1700000002.000200",
      name: "rocket",
    });
  });

  it("slack_edit resolves the channel then updates the message", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_EDIT.execute(
      { channel: "eng-alerts", ts: "1700000001.000100", text: "edited text" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      ts: "1700000001.000100",
    });
    expect(urls[1]).toContain("chat.update");
    expect(bodies[1]).toEqual({
      channel: "C200",
      ts: "1700000001.000100",
      text: "edited text",
    });
  });

  it("slack_upload runs the three-step flow against the resolved channel", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_UPLOAD.execute(
      {
        channel: "eng-alerts",
        filename: "note.md",
        content: "hello",
        comment: "the notes",
      },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channel: "eng-alerts",
      fileId: "F123",
      title: "note.md",
    });
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/api/conversations.list",
      "/api/files.getUploadURLExternal",
      "/upload/v1/ABC123",
      "/api/files.completeUploadExternal",
    ]);
    expect(bodies[3]).toEqual({
      files: [{ id: "F123", title: "note.md" }],
      channel_id: "C200",
      initial_comment: "the notes",
    });
  });

  it("slack_list_channels returns the channel directory without resolving a name", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_LIST_CHANNELS.execute({}, ctxWithCredential);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      channels: [
        { id: "C100", name: "general" },
        { id: "C200", name: "eng-alerts" },
      ],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("conversations.list");
  });

  it("slack_search passes the query through and returns matches", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_SEARCH.execute(
      { query: "deploy failed", limit: 5 },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      total: 1,
      matches: [
        {
          channel: "eng-alerts",
          user: "U111",
          username: "jane",
          text: "deploy failed",
          ts: "1700000004.000400",
          permalink: "https://ws.slack.com/archives/C200/p1700000004000400",
        },
      ],
    });
    expect(urls).toHaveLength(1);
    const requested = new URL(urls[0]!);
    expect(requested.pathname).toBe("/api/search.messages");
    expect(requested.searchParams.get("query")).toBe("deploy failed");
    expect(requested.searchParams.get("count")).toBe("5");
  });

  it("slack_list_users returns active members only", async () => {
    const { fetchFn, urls } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_LIST_USERS.execute({}, ctxWithCredential);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      users: [
        { id: "U111", name: "jane", displayName: "Jane Doe", isBot: false },
      ],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("users.list");
  });

  it("slack_dm_read resolves the handle, opens the DM, then reads history", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_DM_READ.execute(
      { handle: "jane", limit: 2 },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      handle: "@jane",
      messages: [
        { user: "U111", text: "deploy is green", ts: "1700000002.000200" },
        { user: "U222", text: "starting deploy", ts: "1700000001.000100" },
      ],
    });
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/api/users.list",
      "/api/conversations.open",
      "/api/conversations.history",
    ]);
    expect(bodies[1]).toEqual({ users: "U111" });
    // History reads the OPENED DM channel, not any public channel.
    expect(new URL(urls[2]!).searchParams.get("channel")).toBe("D900");
  });

  it("slack_dm_read accepts the display name and an @-prefixed handle", async () => {
    for (const handle of ["Jane Doe", "@jane"]) {
      const { fetchFn } = slackApiFetch();
      globalThis.fetch = fetchFn;
      const result = await SLACK_DM_READ.execute(
        { handle },
        ctxWithCredential,
      );
      expect(result.success).toBe(true);
    }
  });

  it("slack_dm_send resolves the handle then posts into the DM", async () => {
    const { fetchFn, urls, bodies } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_DM_SEND.execute(
      { handle: "jane", text: "hi jane" },
      ctxWithCredential,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      handle: "@jane",
      ts: "1700000003.000300",
    });
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      "/api/users.list",
      "/api/conversations.open",
      "/api/chat.postMessage",
    ]);
    expect(bodies[2]).toEqual({ channel: "D900", text: "hi jane" });
  });

  it("returns the standard no-credential failure when none is injected", async () => {
    for (const tool of slack.tools) {
      const result = await tool.execute(
        { channel: "general", text: "hi" },
        { userId: "no-cred-user" },
      );
      expect(result).toEqual({
        success: false,
        error: "No credential found for service: slack",
      });
    }
  });

  it("rejects a missing or non-string channel as an input error before any fetch", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for invalid params");
    }) as typeof globalThis.fetch;

    for (const [tool, baseParams] of CHANNEL_TOOL_PARAMS) {
      for (const channel of [undefined, 42, ""]) {
        const result = await tool.execute(
          { ...baseParams, channel },
          ctxWithCredential,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("channel must be a non-empty");
      }
    }
  });

  it("rejects a missing or invalid handle on the DM tools before any fetch", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for invalid params");
    }) as typeof globalThis.fetch;

    for (const tool of [SLACK_DM_READ, SLACK_DM_SEND]) {
      for (const params of [{}, { handle: 42 }, { handle: "" }, { handle: "@" }]) {
        const result = await tool.execute(
          { text: "hi", ...params },
          ctxWithCredential,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "handle must be a non-empty Slack username",
        );
      }
    }
  });

  it("re-validates every required string param before any fetch", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for invalid params");
    }) as typeof globalThis.fetch;

    const cases: [Tool, Record<string, unknown>, string][] = [
      [
        SLACK_REPLY,
        { channel: "general", text: "hi" },
        "thread_ts must be a non-empty message timestamp",
      ],
      [
        SLACK_REPLY,
        { channel: "general", thread_ts: "1" },
        "text must be a non-empty string",
      ],
      [
        SLACK_REACT,
        { channel: "general", emoji: "rocket" },
        "timestamp must be a non-empty message timestamp",
      ],
      [
        SLACK_REACT,
        { channel: "general", timestamp: "1" },
        "emoji must be a non-empty emoji name",
      ],
      [
        SLACK_EDIT,
        { channel: "general", text: "x" },
        "ts must be a non-empty message timestamp",
      ],
      [
        SLACK_EDIT,
        { channel: "general", ts: "1" },
        "text must be a non-empty string",
      ],
      [
        SLACK_UPLOAD,
        { channel: "general", content: "x" },
        "filename must be a non-empty string",
      ],
      [
        SLACK_UPLOAD,
        { channel: "general", filename: "f.md" },
        "content must be a non-empty string",
      ],
      [
        SLACK_UPLOAD,
        { channel: "general", filename: "f.md", content: "x", comment: 42 },
        "comment must be a non-empty string when provided",
      ],
      [SLACK_SEARCH, {}, "query must be a non-empty string"],
      [
        SLACK_DM_SEND,
        { handle: "jane" },
        "text must be a non-empty string",
      ],
      [SLACK_SEND, { channel: "general" }, "text must be a non-empty string"],
      [
        SLACK_SEND,
        { channel: "general", text: "" },
        "text must be a non-empty string",
      ],
    ];

    for (const [tool, params, fragment] of cases) {
      const result = await tool.execute(params, ctxWithCredential);
      expect(result.success).toBe(false);
      expect(result.error).toContain(fragment);
    }
  });

  it("rejects an out-of-range or non-integer limit on every limited tool", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not be called for invalid params");
    }) as typeof globalThis.fetch;

    const cases: [Tool, Record<string, unknown>, number][] = [
      [SLACK_READ, { channel: "general" }, SLACK_READ_MAX_LIMIT],
      [SLACK_DM_READ, { handle: "jane" }, SLACK_READ_MAX_LIMIT],
      [SLACK_SEARCH, { query: "x" }, SLACK_SEARCH_MAX_LIMIT],
      [SLACK_LIST_CHANNELS, {}, SLACK_LIST_MAX_LIMIT],
      [SLACK_LIST_USERS, {}, SLACK_LIST_MAX_LIMIT],
    ];

    for (const [tool, baseParams, max] of cases) {
      for (const limit of [0, -1, 1.5, max + 1, "5"]) {
        const result = await tool.execute(
          { ...baseParams, limit },
          ctxWithCredential,
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          `limit must be an integer between 1 and ${max}`,
        );
      }
    }
  });

  it("an unknown channel surfaces as a self-correcting execution error", async () => {
    const { fetchFn } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_READ.execute(
      { channel: "no-such-channel" },
      ctxWithCredential,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Unknown or inaccessible Slack channel: no-such-channel",
    );
  });

  it("an unknown handle surfaces as a self-correcting execution error", async () => {
    const { fetchFn } = slackApiFetch();
    globalThis.fetch = fetchFn;

    const result = await SLACK_DM_SEND.execute(
      { handle: "nobody", text: "hi" },
      ctxWithCredential,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Unknown or inaccessible Slack user: @nobody",
    );
  });

  it("Slack ok:false becomes an execution error, not a false success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;

    const result = await SLACK_READ.execute(
      { channel: "general" },
      ctxWithCredential,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid_auth");
  });
});

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const baseParams = {
  agentId: "agent-1",
  epochId: "2026-07-09",
  timestamp: "2026-07-09T12:00:00Z",
};

/**
 * Dispatch through the DO's full governance + execution pipeline. The
 * iterated catalog invariants cover slack's first tool generically; this
 * bundle pins the slack-specific end-to-end behavior across the three noun
 * classes — verbatim channel (read/send), uppercase sentinel (search), and
 * @handle (dm_send) — plus the scope gate on a pre-expansion credential.
 */
describe("Slack tool dispatch (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("slack_read → governed (slack, read, general) → returns channel messages", async () => {
    const userId = "slack-dispatch-read";
    // Seed the full launch user-scope set so the pre-policy scope
    // precondition (SLACK_READ.requiredScopes) passes and dispatch reaches
    // governance + execution.
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: SLACK_USER_SCOPES,
    });
    globalThis.fetch = slackApiFetch().fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("slack", "read", "general", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_read",
        toolParams: { channel: "general", limit: 2 },
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.service).toBe("slack");
    expect(result.governance.verb).toBe("read");
    expect(result.governance.noun).toBe("general");
    expect(result.execution!.success).toBe(true);
    const data = result.execution!.data as {
      channel: string;
      messages: { text: string }[];
    };
    expect(data.channel).toBe("general");
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]!.text).toBe("deploy is green");
  });

  it("slack_send → governed (slack, send, eng-alerts) → posts and returns ts", async () => {
    const userId = "slack-dispatch-send";
    // Full user-scope set so SLACK_SEND.requiredScopes (chat:write) is
    // covered and the call reaches governance + execution.
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: SLACK_USER_SCOPES,
    });
    globalThis.fetch = slackApiFetch().fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("slack", "send", "eng-alerts", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_send",
        toolParams: { channel: "eng-alerts", text: "deploy done" },
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.service).toBe("slack");
    expect(result.governance.verb).toBe("send");
    expect(result.governance.noun).toBe("eng-alerts");
    expect(result.execution!.success).toBe(true);
    expect(result.execution!.data).toEqual({
      channel: "eng-alerts",
      ts: "1700000003.000300",
    });
  });

  it("slack_search → governed (slack, search, WORKSPACE) → returns matches", async () => {
    const userId = "slack-dispatch-search";
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: SLACK_USER_SCOPES,
    });
    globalThis.fetch = slackApiFetch().fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      // The grant binds the account-level sentinel, not a channel name.
      instance.createSessionGrant(
        "slack",
        "search",
        SLACK_WORKSPACE_NOUN,
        sessionId,
      );
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_search",
        toolParams: { query: "deploy failed", limit: 5 },
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.verb).toBe("search");
    expect(result.governance.noun).toBe(SLACK_WORKSPACE_NOUN);
    expect(result.execution!.success).toBe(true);
    const data = result.execution!.data as { total: number; matches: unknown[] };
    expect(data.total).toBe(1);
    expect(data.matches).toHaveLength(1);
  });

  it("slack_dm_send → governed (slack, dm_send, @jane) → resolves and posts", async () => {
    const userId = "slack-dispatch-dm-send";
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: SLACK_USER_SCOPES,
    });
    const canned = slackApiFetch();
    globalThis.fetch = canned.fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      // The DM grant binds the @handle noun — disjoint from channel grants.
      instance.createSessionGrant("slack", "dm_send", "@jane", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_dm_send",
        toolParams: { handle: "jane", text: "hi jane" },
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.verb).toBe("dm_send");
    expect(result.governance.noun).toBe("@jane");
    expect(result.execution!.success).toBe(true);
    expect(result.execution!.data).toEqual({
      handle: "@jane",
      ts: "1700000003.000300",
    });
    expect(canned.urls.map((u) => new URL(u).pathname)).toEqual([
      "/api/users.list",
      "/api/conversations.open",
      "/api/chat.postMessage",
    ]);
  });

  it("connected but under-scoped credential → needs_authorization, no dispatch", async () => {
    // A slack credential granted only the name-resolution scopes (a partial
    // consent) covers neither read (channels:history/groups:history) nor send
    // (chat:write). The pre-policy scope precondition
    // must deny before dispatch — even with a live grant that policy would
    // otherwise allow — the same gate gmail's tools use.
    const userId = "slack-dispatch-underscoped";
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: ["channels:read", "groups:read"],
    });
    const canned = slackApiFetch();
    globalThis.fetch = canned.fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("slack", "read", "general", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_read",
        toolParams: { channel: "general", limit: 2 },
      }),
    );

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.execution).toBeUndefined();
    // Never dispatched: no Slack Web API call was made.
    expect(canned.urls).toHaveLength(0);
  });

  it("a credential consented under the original five-scope set → needs_authorization on the DM tier", async () => {
    // The pre-expansion consent (SLACK_USER_SCOPES) covers the
    // channel tools but none of the scopes the newer tiers gate on — the
    // exact cross-tier reconnect path the capability map exists to provide.
    const userId = "slack-dispatch-legacy-consent";
    const ciphertext = await seedCiphertext({
      access_token: "scrubbed-dispatch-user-token",
      scopes: [
        "channels:read",
        "groups:read",
        "channels:history",
        "groups:history",
        "chat:write",
      ],
    });
    const canned = slackApiFetch();
    globalThis.fetch = canned.fetchFn;

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("slack", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("slack", "dm_send", "@jane", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        userId,
        toolName: "slack_dm_send",
        toolParams: { handle: "jane", text: "hi" },
      }),
    );

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.execution).toBeUndefined();
    expect(canned.urls).toHaveLength(0);
  });
});
