// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

const SLACK_API_BASE = "https://slack.com/api";

type FetchFn = typeof globalThis.fetch;

/**
 * Per-request page sizes for the cursor-paginated list endpoints. Slack caps
 * `conversations.list` at 1000 per page and recommends `users.list` pages of
 * at most 200. `listChannels` filters nothing, so it requests `min(limit,
 * pageSize)` — a small ask fetches exactly `limit` in a single page.
 * `listUsers` filters deactivated members, so a page sized to `limit` could
 * return fewer than `limit` live users and force extra thin round-trips; it
 * requests the whole page and stops at `limit`, like the full-scan resolvers
 * (channel-name and handle resolution).
 */
const CHANNELS_PAGE_SIZE = 1000;
const USERS_PAGE_SIZE = 200;

export class SlackApiError extends Error {
  constructor(
    /** Slack's machine-readable error code (e.g. `channel_not_found`). */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
}

export interface SlackHistoryResult {
  messages: SlackMessage[];
}

export interface SlackPostResult {
  channelId: string;
  ts: string;
}

export interface SlackSearchMatch {
  /** Human channel name the match was found in (DM matches carry a user id). */
  channel: string;
  user: string;
  username: string;
  text: string;
  ts: string;
  permalink: string;
}

export interface SlackSearchResult {
  matches: SlackSearchMatch[];
  /** Total matches Slack reports, beyond the returned page. */
  total: number;
}

export interface SlackUpdateResult {
  ts: string;
  text: string;
}

export interface SlackDirectoryUser {
  id: string;
  /** The username — the primary `@handle` DM tools resolve against. */
  name: string;
  displayName: string;
  isBot: boolean;
}

export interface SlackUploadResult {
  fileId: string;
  title: string;
}

/**
 * One Slack Web API call. Slack reports failures as HTTP 200 with
 * `{ ok: false, error }`, so the `ok` field is the real status — a non-200
 * (e.g. a 429 rate limit) is also surfaced, with whatever body text came back.
 * The access token is used for a single request and never stored.
 */
async function slackApiCall<T extends { ok: boolean; error?: string }>(
  accessToken: string,
  method: string,
  init: { query?: Record<string, string>; jsonBody?: Record<string, unknown> },
  fetchFn: FetchFn,
): Promise<T> {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetchFn(url.toString(), {
    method: init.jsonBody ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.jsonBody
        ? { "Content-Type": "application/json; charset=utf-8" }
        : {}),
    },
    ...(init.jsonBody ? { body: JSON.stringify(init.jsonBody) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new SlackApiError(
      `http_${res.status}`,
      `Slack ${method} failed (${res.status}): ${text}`,
    );
  }

  const data = (await res.json()) as T;
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    throw new SlackApiError(code, `Slack ${method} failed: ${code}`);
  }
  return data;
}

/**
 * Resolve a human channel name (the governed noun, e.g. `eng-alerts`) to
 * Slack's channel id. Requests BOTH public and private channel types and
 * paginates `next_cursor` to exhaustion — `conversations.list` defaults to
 * public channels only and returns a bounded page, so dropping either
 * argument falsely reports an accessible channel as unknown.
 * An unmatched name throws a self-correcting
 * "unknown channel" error.
 */
export async function resolveChannelId(
  accessToken: string,
  channelName: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  let cursor = "";
  do {
    const data = await slackApiCall<{
      ok: boolean;
      error?: string;
      channels?: { id: string; name: string }[];
      response_metadata?: { next_cursor?: string };
    }>(
      accessToken,
      "conversations.list",
      {
        query: {
          types: "public_channel,private_channel",
          limit: String(CHANNELS_PAGE_SIZE),
          ...(cursor ? { cursor } : {}),
        },
      },
      fetchFn,
    );

    const match = (data.channels ?? []).find((c) => c.name === channelName);
    if (match) {
      return match.id;
    }
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor !== "");

  throw new SlackApiError(
    "unknown_channel",
    `Unknown or inaccessible Slack channel: ${channelName}`,
  );
}

/**
 * Fetch a channel's most recent messages via `conversations.history`.
 * Speaks channel ids — name resolution lives in resolveChannelId; the
 * SLACK_READ adapter composes the two.
 */
export async function fetchChannelHistory(
  accessToken: string,
  channelId: string,
  limit: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackHistoryResult> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    messages?: { user?: string; text?: string; ts?: string }[];
  }>(
    accessToken,
    "conversations.history",
    { query: { channel: channelId, limit: String(limit) } },
    fetchFn,
  );

  return {
    messages: (data.messages ?? []).map((m) => ({
      user: m.user ?? "",
      text: m.text ?? "",
      ts: m.ts ?? "",
    })),
  };
}

/**
 * Post a message to a channel via `chat.postMessage`. With the rotating user
 * token this posts as the authorizing user — the identity the governance
 * grant covers.
 */
export async function postChannelMessage(
  accessToken: string,
  channelId: string,
  text: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackPostResult> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  }>(
    accessToken,
    "chat.postMessage",
    { jsonBody: { channel: channelId, text } },
    fetchFn,
  );

  return { channelId: data.channel ?? channelId, ts: data.ts ?? "" };
}

/**
 * List channels the credential can see via `conversations.list` — the same
 * public+private types and cursor pagination as resolveChannelId, but
 * accumulating entries instead of matching one name, stopping once `limit`
 * entries are collected or the listing is exhausted.
 */
export async function listChannels(
  accessToken: string,
  limit: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  do {
    const data = await slackApiCall<{
      ok: boolean;
      error?: string;
      channels?: { id: string; name: string }[];
      response_metadata?: { next_cursor?: string };
    }>(
      accessToken,
      "conversations.list",
      {
        query: {
          types: "public_channel,private_channel",
          limit: String(Math.min(limit, CHANNELS_PAGE_SIZE)),
          ...(cursor ? { cursor } : {}),
        },
      },
      fetchFn,
    );

    for (const c of data.channels ?? []) {
      channels.push({ id: c.id, name: c.name });
      if (channels.length >= limit) {
        return channels;
      }
    }
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor !== "");

  return channels;
}

/**
 * Search the workspace's messages via `search.messages`. The method only
 * accepts a USER token (verified 2026-07-10, docs.slack.dev) — which is the
 * one token kind this integration stores — and its reach is bounded by the
 * workspace's plan: on free workspaces only the retained recent history
 * (~90 days) is searchable, so an empty result does not prove absence.
 */
export async function searchMessages(
  accessToken: string,
  query: string,
  count: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackSearchResult> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    messages?: {
      total?: number;
      matches?: {
        channel?: { id?: string; name?: string };
        user?: string;
        username?: string;
        text?: string;
        ts?: string;
        permalink?: string;
      }[];
    };
  }>(
    accessToken,
    "search.messages",
    { query: { query, count: String(count) } },
    fetchFn,
  );

  return {
    matches: (data.messages?.matches ?? []).map((m) => ({
      channel: m.channel?.name ?? "",
      user: m.user ?? "",
      username: m.username ?? "",
      text: m.text ?? "",
      ts: m.ts ?? "",
      permalink: m.permalink ?? "",
    })),
    total: data.messages?.total ?? 0,
  };
}

/**
 * Reply within a thread: `chat.postMessage` with `thread_ts` naming the
 * parent message. Same user-token posting identity as postChannelMessage.
 */
export async function postThreadReply(
  accessToken: string,
  channelId: string,
  threadTs: string,
  text: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackPostResult> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  }>(
    accessToken,
    "chat.postMessage",
    { jsonBody: { channel: channelId, thread_ts: threadTs, text } },
    fetchFn,
  );

  return { channelId: data.channel ?? channelId, ts: data.ts ?? "" };
}

/**
 * Add an emoji reaction to a message via `reactions.add`. Slack keys the
 * message by (channel id, timestamp); the emoji name goes without colons.
 */
export async function addReaction(
  accessToken: string,
  channelId: string,
  timestamp: string,
  emojiName: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  await slackApiCall<{ ok: boolean; error?: string }>(
    accessToken,
    "reactions.add",
    { jsonBody: { channel: channelId, timestamp, name: emojiName } },
    fetchFn,
  );
}

/**
 * Edit a message via `chat.update`. Slack only lets the authenticated user
 * update their own messages — editing anyone else's fails with
 * `cant_update_message`, surfaced like any other Slack error code.
 */
export async function updateMessage(
  accessToken: string,
  channelId: string,
  ts: string,
  text: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackUpdateResult> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    ts?: string;
    text?: string;
  }>(
    accessToken,
    "chat.update",
    { jsonBody: { channel: channelId, ts, text } },
    fetchFn,
  );

  return { ts: data.ts ?? ts, text: data.text ?? text };
}

/**
 * Resolve a human handle (the governed DM noun, without the `@`) to Slack's
 * user id, mirroring resolveChannelId: paginate `users.list` to exhaustion.
 * Deactivated accounts are skipped — they cannot receive DMs, and a freed
 * username must not resolve to a dead account when a live user has since
 * claimed the display name.
 *
 * The `name` (username) is unique within a workspace, so an exact username
 * match is authoritative and returns immediately. A display name is neither
 * unique nor immutable — any member can set their own to anything — so
 * matching one is only safe when exactly ONE active member carries it. A
 * bare display-name match could otherwise send the user's DM to an impostor
 * or the wrong "jane". So when no username matches, the scan collects every
 * active display-name match: exactly one resolves; two or more throw a
 * self-correcting "ambiguous handle" error steering the caller to a
 * username; none throws "unknown user".
 */
export async function resolveUserId(
  accessToken: string,
  handle: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  let cursor = "";
  // User ids of every active member whose display name equals the handle,
  // collected only while no exact username match has been found.
  const displayNameMatches: string[] = [];
  do {
    const data = await slackApiCall<{
      ok: boolean;
      error?: string;
      members?: {
        id: string;
        name?: string;
        deleted?: boolean;
        profile?: { display_name?: string };
      }[];
      response_metadata?: { next_cursor?: string };
    }>(
      accessToken,
      "users.list",
      // Full scan for one match, so request Slack's full recommended page.
      { query: { limit: String(USERS_PAGE_SIZE), ...(cursor ? { cursor } : {}) } },
      fetchFn,
    );

    for (const m of data.members ?? []) {
      if (m.deleted) {
        continue;
      }
      // Exact username match wins outright — unique, so no need to read on.
      if (m.name === handle) {
        return m.id;
      }
      if (m.profile?.display_name === handle) {
        displayNameMatches.push(m.id);
      }
    }
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor !== "");

  if (displayNameMatches.length === 1) {
    return displayNameMatches[0]!;
  }
  if (displayNameMatches.length > 1) {
    throw new SlackApiError(
      "ambiguous_user",
      `Ambiguous Slack handle @${handle}: ${displayNameMatches.length} active ` +
        `members share that display name; use the exact username instead.`,
    );
  }
  throw new SlackApiError(
    "unknown_user",
    `Unknown or inaccessible Slack user: @${handle}`,
  );
}

/**
 * List the workspace's active members via `users.list`, paginating like
 * resolveUserId but accumulating up to `limit` entries. Deactivated accounts
 * are skipped for the same reason resolveUserId skips them.
 */
export async function listUsers(
  accessToken: string,
  limit: number,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackDirectoryUser[]> {
  const users: SlackDirectoryUser[] = [];
  let cursor = "";
  do {
    const data = await slackApiCall<{
      ok: boolean;
      error?: string;
      members?: {
        id: string;
        name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: { display_name?: string };
      }[];
      response_metadata?: { next_cursor?: string };
    }>(
      accessToken,
      "users.list",
      // Full page every time: deactivated members are filtered below, so a
      // page sized to `limit` could yield fewer than `limit` live users and
      // force extra thin round-trips. Request Slack's full recommended page
      // and stop once `limit` active users are collected.
      { query: { limit: String(USERS_PAGE_SIZE), ...(cursor ? { cursor } : {}) } },
      fetchFn,
    );

    for (const m of data.members ?? []) {
      if (m.deleted) {
        continue;
      }
      users.push({
        id: m.id,
        name: m.name ?? "",
        displayName: m.profile?.display_name ?? "",
        isBot: m.is_bot ?? false,
      });
      if (users.length >= limit) {
        return users;
      }
    }
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor !== "");

  return users;
}

/**
 * Open (or resume) the 1:1 DM conversation with a user via
 * `conversations.open`, returning the D-channel id that
 * `conversations.history` / `chat.postMessage` then speak.
 */
export async function openDirectMessage(
  accessToken: string,
  userId: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  const data = await slackApiCall<{
    ok: boolean;
    error?: string;
    channel?: { id?: string };
  }>(
    accessToken,
    "conversations.open",
    { jsonBody: { users: userId } },
    fetchFn,
  );

  const channelId = data.channel?.id;
  if (!channelId) {
    throw new SlackApiError(
      "no_dm_channel",
      "Slack conversations.open returned no channel id",
    );
  }
  return channelId;
}

/**
 * Send a direct message: open the DM conversation, then post into it. Takes
 * the already-resolved user id — handle resolution stays in resolveUserId so
 * the DM tools compose the two exactly like the channel tools compose
 * resolveChannelId with their action call.
 */
export async function postDirectMessage(
  accessToken: string,
  userId: string,
  text: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackPostResult> {
  const channelId = await openDirectMessage(accessToken, userId, fetchFn);
  return postChannelMessage(accessToken, channelId, text, fetchFn);
}

export interface SlackUploadParams {
  channelId: string;
  filename: string;
  /** UTF-8 text content of the file to upload. */
  content: string;
  /** Optional message posted alongside the shared file. */
  comment?: string;
}

/**
 * Upload a file and share it to a channel via Slack's three-step external
 * upload flow (verified 2026-07-10, docs.slack.dev): (1)
 * `files.getUploadURLExternal` with the filename and byte length returns a
 * one-time `upload_url` + `file_id`; (2) the raw bytes are POSTed to that
 * URL as `application/octet-stream` — an unauthenticated files.slack.com
 * endpoint whose success response is plain text, not the `{ok}` JSON
 * envelope, so it bypasses slackApiCall; (3) `files.completeUploadExternal`
 * finalizes the file and shares it to the channel with the optional comment.
 */
export async function uploadFile(
  accessToken: string,
  params: SlackUploadParams,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SlackUploadResult> {
  const bytes = new TextEncoder().encode(params.content);

  const ticket = await slackApiCall<{
    ok: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  }>(
    accessToken,
    "files.getUploadURLExternal",
    { jsonBody: { filename: params.filename, length: bytes.byteLength } },
    fetchFn,
  );
  if (!ticket.upload_url || !ticket.file_id) {
    throw new SlackApiError(
      "invalid_upload_ticket",
      "Slack files.getUploadURLExternal returned no upload_url/file_id",
    );
  }

  const uploadRes = await fetchFn(ticket.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const ack = (await uploadRes.text()).trim();
  if (!uploadRes.ok) {
    throw new SlackApiError(
      `http_${uploadRes.status}`,
      `Slack file upload failed (${uploadRes.status}): ${ack}`,
    );
  }
  // The byte sink answers plain text "OK - <bytes received>" (verified
  // 2026-07-11, docs.slack.dev). When it echoes a count, assert it matches
  // what we sent: a short count is a truncated upload that
  // completeUploadExternal would otherwise finalize into a corrupt file. An
  // unrecognized 2xx body falls back to the status check the docs prescribe.
  const echoed = /^OK\s*-\s*(\d+)$/i.exec(ack);
  if (echoed && Number(echoed[1]) !== bytes.byteLength) {
    throw new SlackApiError(
      "upload_incomplete",
      `Slack accepted only ${echoed[1]} of ${bytes.byteLength} bytes for ` +
        `${params.filename}; upload was truncated`,
    );
  }

  const completed = await slackApiCall<{
    ok: boolean;
    error?: string;
    files?: { id?: string; title?: string }[];
  }>(
    accessToken,
    "files.completeUploadExternal",
    {
      jsonBody: {
        files: [{ id: ticket.file_id, title: params.filename }],
        channel_id: params.channelId,
        ...(params.comment ? { initial_comment: params.comment } : {}),
      },
    },
    fetchFn,
  );

  const file = completed.files?.[0];
  return {
    fileId: file?.id ?? ticket.file_id,
    title: file?.title ?? params.filename,
  };
}
