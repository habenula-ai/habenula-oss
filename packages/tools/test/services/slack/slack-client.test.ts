import { describe, it, expect } from "vitest";
import {
  addReaction,
  fetchChannelHistory,
  listChannels,
  listUsers,
  openDirectMessage,
  postChannelMessage,
  postDirectMessage,
  postThreadReply,
  resolveChannelId,
  resolveUserId,
  searchMessages,
  SlackApiError,
  updateMessage,
  uploadFile,
} from "../../../src/services/slack/slack-client";

/**
 * Build a fake fetch serving a paginated conversations.list. Each call
 * records the request URL; pages advance by the cursor the client sends
 * back, so a client that drops pagination never reaches page two.
 */
function pagedListFetch(
  pages: { channels: { id: string; name: string }[]; nextCursor: string }[],
) {
  const urls: URL[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    urls.push(url);
    const cursor = url.searchParams.get("cursor") ?? "";
    const index = cursor === "" ? 0 : Number(cursor.replace("page-", ""));
    const page = pages[index]!;
    return new Response(
      JSON.stringify({
        ok: true,
        channels: page.channels,
        response_metadata: { next_cursor: page.nextCursor },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchFn, urls };
}

describe("resolveChannelId", () => {
  it("resolves a channel on the first page", async () => {
    const { fetchFn, urls } = pagedListFetch([
      {
        channels: [
          { id: "C001", name: "general" },
          { id: "C002", name: "eng-alerts" },
        ],
        nextCursor: "",
      },
    ]);

    const id = await resolveChannelId("test-token", "eng-alerts", fetchFn);

    expect(id).toBe("C002");
    expect(urls).toHaveLength(1);
    expect(urls[0]!.pathname).toBe("/api/conversations.list");
  });

  it("requests BOTH public and private channel types", async () => {
    // conversations.list defaults to public channels only; dropping
    // private_channel falsely reports an accessible private channel as
    // unknown.
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "" },
    ]);

    await resolveChannelId("test-token", "general", fetchFn);

    const types = urls[0]!.searchParams.get("types")!.split(",");
    expect(types).toContain("public_channel");
    expect(types).toContain("private_channel");
  });

  it("paginates next_cursor to exhaustion and finds a late-page channel", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "page-1" },
      { channels: [{ id: "C002", name: "random" }], nextCursor: "page-2" },
      { channels: [{ id: "C003", name: "eng-private" }], nextCursor: "" },
    ]);

    const id = await resolveChannelId("test-token", "eng-private", fetchFn);

    expect(id).toBe("C003");
    expect(urls).toHaveLength(3);
    // The cursor threads through: page N+1 is requested with page N's cursor.
    expect(urls[0]!.searchParams.get("cursor")).toBeNull();
    expect(urls[1]!.searchParams.get("cursor")).toBe("page-1");
    expect(urls[2]!.searchParams.get("cursor")).toBe("page-2");
  });

  it("stops at a matched name without fetching further pages", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "page-1" },
      { channels: [{ id: "C002", name: "never-reached" }], nextCursor: "" },
    ]);

    await resolveChannelId("test-token", "general", fetchFn);

    expect(urls).toHaveLength(1);
  });

  it("throws a self-correcting unknown-channel error after exhausting the listing", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "page-1" },
      { channels: [{ id: "C002", name: "random" }], nextCursor: "" },
    ]);

    await expect(
      resolveChannelId("test-token", "no-such-channel", fetchFn),
    ).rejects.toThrow("Unknown or inaccessible Slack channel: no-such-channel");
    // It looked at every page before giving up.
    expect(urls).toHaveLength(2);
  });

  it("surfaces Slack's ok:false (HTTP 200) as an error, not a false success", async () => {
    const errorFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    await expect(
      resolveChannelId("expired-token", "general", errorFetch),
    ).rejects.toThrow("Slack conversations.list failed: invalid_auth");
  });

  it("surfaces a non-200 (e.g. 429 rate limit) as an error", async () => {
    const rateLimited = async (): Promise<Response> =>
      new Response("Too Many Requests", { status: 429 });

    await expect(
      resolveChannelId("test-token", "general", rateLimited),
    ).rejects.toThrow("Slack conversations.list failed (429)");
  });

  it("sends the Bearer token on the request", async () => {
    let captured: HeadersInit | undefined;
    const fetchFn = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = init?.headers;
      return new Response(
        JSON.stringify({
          ok: true,
          channels: [{ id: "C001", name: "general" }],
          response_metadata: { next_cursor: "" },
        }),
        { status: 200 },
      );
    };

    await resolveChannelId("secret-user-token", "general", fetchFn);

    expect(captured).toMatchObject({
      Authorization: "Bearer secret-user-token",
    });
  });
});

describe("fetchChannelHistory", () => {
  it("requests the channel id and limit, returns message fields", async () => {
    let captured: URL | null = null;
    const fetchFn = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      captured = new URL(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { user: "U111", text: "deploy done", ts: "1700000002.000200" },
            { user: "U222", text: "shipping", ts: "1700000001.000100" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await fetchChannelHistory("test-token", "C002", 2, fetchFn);

    expect(captured!.pathname).toBe("/api/conversations.history");
    expect(captured!.searchParams.get("channel")).toBe("C002");
    expect(captured!.searchParams.get("limit")).toBe("2");
    expect(result.messages).toEqual([
      { user: "U111", text: "deploy done", ts: "1700000002.000200" },
      { user: "U222", text: "shipping", ts: "1700000001.000100" },
    ]);
  });

  it("surfaces ok:false errors (e.g. not_in_channel)", async () => {
    const errorFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
      });

    await expect(
      fetchChannelHistory("test-token", "C009", 5, errorFetch),
    ).rejects.toThrow("Slack conversations.history failed: not_in_channel");
  });
});

describe("postChannelMessage", () => {
  it("POSTs JSON with channel id and text, Bearer-authenticated", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({ ok: true, channel: "C002", ts: "1700000003.000300" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await postChannelMessage(
      "test-token",
      "C002",
      "hello from habenula",
      fetchFn,
    );

    expect(capturedUrl).toBe("https://slack.com/api/chat.postMessage");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      channel: "C002",
      text: "hello from habenula",
    });
    expect(result).toEqual({ channelId: "C002", ts: "1700000003.000300" });
  });

  it("surfaces ok:false errors with the Slack error code", async () => {
    const errorFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ ok: false, error: "restricted_action" }), {
        status: 200,
      });

    let thrown: unknown;
    try {
      await postChannelMessage("test-token", "C002", "hi", errorFetch);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SlackApiError);
    expect((thrown as SlackApiError).code).toBe("restricted_action");
  });
});

const jsonResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Multi-endpoint fake fetch for the composed flows (DM open→post, the
 * three-step upload): routes by substring match and records each request's
 * URL, init, and parsed JSON body in call order, so a test can assert both
 * the sequencing and the payload of every leg.
 */
function routedFetch(routes: { match: string; respond: () => Response }[]) {
  const calls: { url: string; init?: RequestInit; json: unknown }[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let json: unknown = null;
    if (typeof init?.body === "string") {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = null;
      }
    }
    calls.push({ url, init, json });
    const route = routes.find((r) => url.includes(r.match));
    return route
      ? route.respond()
      : new Response("unknown endpoint", { status: 404 });
  };
  return { fetchFn, calls };
}

/** Fake fetch serving a paginated users.list, mirroring pagedListFetch. */
function pagedUsersFetch(
  pages: { members: Record<string, unknown>[]; nextCursor: string }[],
) {
  const urls: URL[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    urls.push(url);
    const cursor = url.searchParams.get("cursor") ?? "";
    const index = cursor === "" ? 0 : Number(cursor.replace("page-", ""));
    const page = pages[index]!;
    return jsonResponse({
      ok: true,
      members: page.members,
      response_metadata: { next_cursor: page.nextCursor },
    });
  };
  return { fetchFn, urls };
}

describe("listChannels", () => {
  it("accumulates across pages and truncates to the limit", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "page-1" },
      {
        channels: [
          { id: "C002", name: "eng-alerts" },
          { id: "C003", name: "random" },
        ],
        nextCursor: "page-2",
      },
      { channels: [{ id: "C004", name: "ops" }], nextCursor: "" },
    ]);

    const channels = await listChannels("test-token", 3, fetchFn);

    expect(channels).toEqual([
      { id: "C001", name: "general" },
      { id: "C002", name: "eng-alerts" },
      { id: "C003", name: "random" },
    ]);
    // The limit was hit mid-listing: page three is never requested.
    expect(urls).toHaveLength(2);
  });

  it("returns the full listing when it is shorter than the limit", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "page-1" },
      { channels: [{ id: "C002", name: "eng-alerts" }], nextCursor: "" },
    ]);

    const channels = await listChannels("test-token", 50, fetchFn);

    expect(channels.map((c) => c.name)).toEqual(["general", "eng-alerts"]);
    expect(urls).toHaveLength(2);
  });

  it("requests BOTH public and private channel types", async () => {
    const { fetchFn, urls } = pagedListFetch([
      { channels: [{ id: "C001", name: "general" }], nextCursor: "" },
    ]);

    await listChannels("test-token", 10, fetchFn);

    const types = urls[0]!.searchParams.get("types")!.split(",");
    expect(types).toContain("public_channel");
    expect(types).toContain("private_channel");
  });

  it("surfaces ok:false as an error", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "invalid_auth" });

    await expect(listChannels("expired", 10, errorFetch)).rejects.toThrow(
      "Slack conversations.list failed: invalid_auth",
    );
  });
});

describe("searchMessages", () => {
  it("GETs search.messages with query and count, maps matches and total", async () => {
    let captured: URL | null = null;
    const fetchFn = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      captured = new URL(typeof input === "string" ? input : input.toString());
      return jsonResponse({
        ok: true,
        messages: {
          total: 42,
          matches: [
            {
              channel: { id: "C200", name: "eng-alerts" },
              user: "U111",
              username: "jane",
              text: "deploy failed",
              ts: "1700000004.000400",
              permalink: "https://ws.slack.com/archives/C200/p1700000004000400",
            },
            // Sparse match: every missing field defaults to "".
            { text: "orphan" },
          ],
        },
      });
    };

    const result = await searchMessages(
      "test-token",
      "deploy failed",
      5,
      fetchFn,
    );

    expect(captured!.pathname).toBe("/api/search.messages");
    expect(captured!.searchParams.get("query")).toBe("deploy failed");
    expect(captured!.searchParams.get("count")).toBe("5");
    expect(result.total).toBe(42);
    expect(result.matches).toEqual([
      {
        channel: "eng-alerts",
        user: "U111",
        username: "jane",
        text: "deploy failed",
        ts: "1700000004.000400",
        permalink: "https://ws.slack.com/archives/C200/p1700000004000400",
      },
      {
        channel: "",
        user: "",
        username: "",
        text: "orphan",
        ts: "",
        permalink: "",
      },
    ]);
  });

  it("surfaces the bot-token rejection (search.messages is user-token-only)", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "not_allowed_token_type" });

    await expect(
      searchMessages("bot-token", "q", 20, errorFetch),
    ).rejects.toThrow("Slack search.messages failed: not_allowed_token_type");
  });
});

describe("postThreadReply", () => {
  it("POSTs JSON with channel id, thread_ts, and text", async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/chat.postMessage",
        respond: () =>
          jsonResponse({ ok: true, channel: "C200", ts: "1700000005.000500" }),
      },
    ]);

    const result = await postThreadReply(
      "test-token",
      "C200",
      "1700000001.000100",
      "on it",
      fetchFn,
    );

    expect(calls[0]!.json).toEqual({
      channel: "C200",
      thread_ts: "1700000001.000100",
      text: "on it",
    });
    expect(result).toEqual({ channelId: "C200", ts: "1700000005.000500" });
  });
});

describe("addReaction", () => {
  it("POSTs the (channel, timestamp, name) triple Slack expects", async () => {
    const { fetchFn, calls } = routedFetch([
      { match: "/api/reactions.add", respond: () => jsonResponse({ ok: true }) },
    ]);

    await addReaction(
      "test-token",
      "C200",
      "1700000001.000100",
      "thumbsup",
      fetchFn,
    );

    expect(calls[0]!.url).toBe("https://slack.com/api/reactions.add");
    expect(calls[0]!.json).toEqual({
      channel: "C200",
      timestamp: "1700000001.000100",
      name: "thumbsup",
    });
  });

  it("surfaces ok:false with the Slack error code", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "already_reacted" });

    let thrown: unknown;
    try {
      await addReaction("test-token", "C200", "1", "thumbsup", errorFetch);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SlackApiError);
    expect((thrown as SlackApiError).code).toBe("already_reacted");
  });
});

describe("updateMessage", () => {
  it("POSTs JSON with channel id, ts, and text and returns the update", async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/chat.update",
        respond: () =>
          jsonResponse({
            ok: true,
            channel: "C200",
            ts: "1700000001.000100",
            text: "fixed text",
          }),
      },
    ]);

    const result = await updateMessage(
      "test-token",
      "C200",
      "1700000001.000100",
      "fixed text",
      fetchFn,
    );

    expect(calls[0]!.json).toEqual({
      channel: "C200",
      ts: "1700000001.000100",
      text: "fixed text",
    });
    expect(result).toEqual({ ts: "1700000001.000100", text: "fixed text" });
  });

  it("surfaces cant_update_message (only the user's own messages)", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "cant_update_message" });

    await expect(
      updateMessage("test-token", "C200", "1", "x", errorFetch),
    ).rejects.toThrow("Slack chat.update failed: cant_update_message");
  });
});

describe("resolveUserId", () => {
  it("paginates users.list and matches a late-page username", async () => {
    const { fetchFn, urls } = pagedUsersFetch([
      {
        members: [{ id: "U001", name: "alex", profile: {} }],
        nextCursor: "page-1",
      },
      {
        members: [
          { id: "U002", name: "jane", profile: { display_name: "Jane Doe" } },
        ],
        nextCursor: "",
      },
    ]);

    const id = await resolveUserId("test-token", "jane", fetchFn);

    expect(id).toBe("U002");
    expect(urls).toHaveLength(2);
    expect(urls[0]!.pathname).toBe("/api/users.list");
    expect(urls[1]!.searchParams.get("cursor")).toBe("page-1");
  });

  it("matches the profile display name when exactly one active member carries it", async () => {
    const { fetchFn } = pagedUsersFetch([
      {
        members: [
          { id: "U002", name: "jane", profile: { display_name: "Jane Doe" } },
        ],
        nextCursor: "",
      },
    ]);

    expect(await resolveUserId("test-token", "Jane Doe", fetchFn)).toBe("U002");
  });

  it("prefers the unique username over another member's matching display name", async () => {
    // The username is unique and authoritative; a display name is not. An
    // impostor cannot intercept @jane by setting their display name to "jane".
    const { fetchFn } = pagedUsersFetch([
      {
        members: [
          { id: "U001", name: "impostor", profile: { display_name: "jane" } },
          { id: "U002", name: "jane", profile: { display_name: "Jane Doe" } },
        ],
        nextCursor: "",
      },
    ]);

    expect(await resolveUserId("test-token", "jane", fetchFn)).toBe("U002");
  });

  it("throws an ambiguous-handle error when active members share a display name", async () => {
    // Two live users answer to display name "jane" and neither has it as a
    // username: resolving either silently would misdirect the DM, so the
    // scan refuses and steers the caller to an exact username.
    const { fetchFn } = pagedUsersFetch([
      {
        members: [
          { id: "U001", name: "jane_a", profile: { display_name: "jane" } },
          { id: "U002", name: "jane_b", profile: { display_name: "jane" } },
        ],
        nextCursor: "",
      },
    ]);

    await expect(
      resolveUserId("test-token", "jane", fetchFn),
    ).rejects.toThrow("Ambiguous Slack handle @jane: 2 active members");
  });

  it("skips deactivated accounts even when the handle matches", async () => {
    // A freed username must not resolve to the dead account that used to
    // hold it when a live user matches later in the listing.
    const { fetchFn } = pagedUsersFetch([
      {
        members: [
          { id: "U001", name: "jane", deleted: true, profile: {} },
          { id: "U002", name: "jane", deleted: false, profile: {} },
        ],
        nextCursor: "",
      },
    ]);

    expect(await resolveUserId("test-token", "jane", fetchFn)).toBe("U002");
  });

  it("throws a self-correcting unknown-user error after exhausting the listing", async () => {
    const { fetchFn, urls } = pagedUsersFetch([
      {
        members: [{ id: "U001", name: "alex", profile: {} }],
        nextCursor: "page-1",
      },
      { members: [{ id: "U002", name: "sam", profile: {} }], nextCursor: "" },
    ]);

    await expect(
      resolveUserId("test-token", "nobody", fetchFn),
    ).rejects.toThrow("Unknown or inaccessible Slack user: @nobody");
    expect(urls).toHaveLength(2);
  });

  it("surfaces ok:false as an error", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "invalid_auth" });

    await expect(
      resolveUserId("expired", "jane", errorFetch),
    ).rejects.toThrow("Slack users.list failed: invalid_auth");
  });
});

describe("listUsers", () => {
  it("paginates, skips deactivated accounts, maps fields, and truncates to the limit", async () => {
    const { fetchFn } = pagedUsersFetch([
      {
        members: [
          {
            id: "U001",
            name: "jane",
            deleted: false,
            is_bot: false,
            profile: { display_name: "Jane Doe" },
          },
          { id: "U002", name: "gone", deleted: true, profile: {} },
        ],
        nextCursor: "page-1",
      },
      {
        members: [
          {
            id: "U003",
            name: "deploybot",
            deleted: false,
            is_bot: true,
            profile: { display_name: "Deploy Bot" },
          },
          { id: "U004", name: "sam", deleted: false, profile: {} },
        ],
        nextCursor: "",
      },
    ]);

    const users = await listUsers("test-token", 2, fetchFn);

    expect(users).toEqual([
      { id: "U001", name: "jane", displayName: "Jane Doe", isBot: false },
      { id: "U003", name: "deploybot", displayName: "Deploy Bot", isBot: true },
    ]);
  });

  it("requests full pages, not limit-sized ones, so deleted filtering never forces thin round-trips", async () => {
    const { fetchFn, urls } = pagedUsersFetch([
      {
        members: [
          { id: "U001", name: "gone1", deleted: true, profile: {} },
          { id: "U002", name: "gone2", deleted: true, profile: {} },
          { id: "U003", name: "jane", deleted: false, profile: {} },
          { id: "U004", name: "sam", deleted: false, profile: {} },
        ],
        nextCursor: "page-1",
      },
      { members: [], nextCursor: "" },
    ]);

    const users = await listUsers("test-token", 2, fetchFn);

    // Two deactivated members lead the page. A page sized to the limit (2)
    // would have held only those dead rows and needed a second round-trip;
    // the full 200-row page yields both live users in the first call.
    expect(users.map((u) => u.id)).toEqual(["U003", "U004"]);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get("limit")).toBe("200");
  });
});

describe("openDirectMessage", () => {
  it("POSTs the user id and returns the DM channel id", async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/conversations.open",
        respond: () => jsonResponse({ ok: true, channel: { id: "D900" } }),
      },
    ]);

    const channelId = await openDirectMessage("test-token", "U111", fetchFn);

    expect(calls[0]!.json).toEqual({ users: "U111" });
    expect(channelId).toBe("D900");
  });

  it("throws when Slack returns no channel id", async () => {
    const emptyFetch = async (): Promise<Response> =>
      jsonResponse({ ok: true, channel: {} });

    await expect(
      openDirectMessage("test-token", "U111", emptyFetch),
    ).rejects.toThrow("Slack conversations.open returned no channel id");
  });
});

describe("postDirectMessage", () => {
  it("opens the DM conversation, then posts into the returned channel", async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/conversations.open",
        respond: () => jsonResponse({ ok: true, channel: { id: "D900" } }),
      },
      {
        match: "/api/chat.postMessage",
        respond: () =>
          jsonResponse({ ok: true, channel: "D900", ts: "1700000006.000600" }),
      },
    ]);

    const result = await postDirectMessage(
      "test-token",
      "U111",
      "hi jane",
      fetchFn,
    );

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/conversations.open",
      "/api/chat.postMessage",
    ]);
    // The post targets the D-channel conversations.open returned.
    expect(calls[1]!.json).toEqual({ channel: "D900", text: "hi jane" });
    expect(result).toEqual({ channelId: "D900", ts: "1700000006.000600" });
  });
});

describe("uploadFile", () => {
  const uploadRoutes = () =>
    routedFetch([
      {
        match: "/api/files.getUploadURLExternal",
        respond: () =>
          jsonResponse({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F123",
          }),
      },
      {
        // Slack's byte sink answers plain text, not the {ok} JSON envelope.
        match: "files.slack.com/upload/",
        respond: () => new Response("OK - 7", { status: 200 }),
      },
      {
        match: "/api/files.completeUploadExternal",
        respond: () =>
          jsonResponse({ ok: true, files: [{ id: "F123", title: "note.md" }] }),
      },
    ]);

  it("runs the three-step flow: ticket, byte POST, complete", async () => {
    const { fetchFn, calls } = uploadRoutes();
    // Multibyte content: length must be the UTF-8 byte count (7), not the
    // character count (6).
    const content = "héllo!";

    const result = await uploadFile(
      "test-token",
      {
        channelId: "C200",
        filename: "note.md",
        content,
        comment: "here you go",
      },
      fetchFn,
    );

    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/files.getUploadURLExternal",
      "/upload/v1/ABC123",
      "/api/files.completeUploadExternal",
    ]);
    expect(calls[0]!.json).toEqual({ filename: "note.md", length: 7 });
    // The byte leg: raw octet-stream POST of the exact content bytes.
    expect(calls[1]!.init?.method).toBe("POST");
    expect(calls[1]!.init?.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
    });
    expect(new TextDecoder().decode(calls[1]!.init?.body as Uint8Array)).toBe(
      content,
    );
    expect(calls[2]!.json).toEqual({
      files: [{ id: "F123", title: "note.md" }],
      channel_id: "C200",
      initial_comment: "here you go",
    });
    expect(result).toEqual({ fileId: "F123", title: "note.md" });
  });

  it("omits initial_comment when no comment is given", async () => {
    const { fetchFn, calls } = uploadRoutes();

    await uploadFile(
      "test-token",
      { channelId: "C200", filename: "note.md", content: "hello!!" },
      fetchFn,
    );

    expect(calls[2]!.json).toEqual({
      files: [{ id: "F123", title: "note.md" }],
      channel_id: "C200",
    });
  });

  it("surfaces a failed byte POST as an error and never completes the upload", async () => {
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/files.getUploadURLExternal",
        respond: () =>
          jsonResponse({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F123",
          }),
      },
      {
        match: "files.slack.com/upload/",
        respond: () => new Response("server error", { status: 500 }),
      },
    ]);

    await expect(
      uploadFile(
        "test-token",
        { channelId: "C200", filename: "note.md", content: "x" },
        fetchFn,
      ),
    ).rejects.toThrow("Slack file upload failed (500)");
    // completeUploadExternal is never reached for un-uploaded bytes.
    expect(
      calls.some((c) => c.url.includes("files.completeUploadExternal")),
    ).toBe(false);
  });

  it("rejects a truncated upload the byte sink under-acknowledges", async () => {
    // 200 OK but the sink echoes fewer bytes than we sent: a partial upload
    // that completeUploadExternal would finalize into a corrupt file. Guard
    // it and never complete.
    const { fetchFn, calls } = routedFetch([
      {
        match: "/api/files.getUploadURLExternal",
        respond: () =>
          jsonResponse({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F123",
          }),
      },
      {
        // "here you go" is 11 bytes; the sink claims only 3 arrived.
        match: "files.slack.com/upload/",
        respond: () => new Response("OK - 3", { status: 200 }),
      },
    ]);

    await expect(
      uploadFile(
        "test-token",
        { channelId: "C200", filename: "note.md", content: "here you go" },
        fetchFn,
      ),
    ).rejects.toThrow("Slack accepted only 3 of 11 bytes");
    expect(
      calls.some((c) => c.url.includes("files.completeUploadExternal")),
    ).toBe(false);
  });

  it("surfaces an ok:false ticket as an error", async () => {
    const errorFetch = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: "file_upload_size_restricted" });

    await expect(
      uploadFile(
        "test-token",
        { channelId: "C200", filename: "big.bin", content: "x" },
        errorFetch,
      ),
    ).rejects.toThrow(
      "Slack files.getUploadURLExternal failed: file_upload_size_restricted",
    );
  });

  it("throws when the ticket carries no upload_url", async () => {
    const emptyTicket = async (): Promise<Response> =>
      jsonResponse({ ok: true });

    await expect(
      uploadFile(
        "test-token",
        { channelId: "C200", filename: "note.md", content: "x" },
        emptyTicket,
      ),
    ).rejects.toThrow(
      "Slack files.getUploadURLExternal returned no upload_url/file_id",
    );
  });
});
