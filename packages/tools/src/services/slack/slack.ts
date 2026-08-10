// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
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
  updateMessage,
  uploadFile,
} from "./slack-client.js";

export * from "./slack-client.js";

/**
 * The requested user-scope set (`connect.scopes`): the full launch Slack
 * surface — read and post in channels the user belongs to, resolve channel
 * and user names, search the workspace, react, edit, exchange 1:1 direct
 * messages, and upload files. All requested via `user_scope=` — write scopes
 * therefore grant the user-token variant, so every action is performed as
 * the authorizing user, not a bot. Slack's consent
 * grants the set all-or-nothing; a credential consented under the original
 * narrower set hits the scope precondition on the newer tools and is routed
 * to reconnect (see SLACK_CAPABILITY_SCOPES).
 *
 * Least-privilege to the shipped tools: the DM tools open and read a 1:1 `im`
 * only (`conversations.open` needs `im:write`, its history needs
 * `im:history` — verified 2026-07-11, docs.slack.dev), so `im:read` and every
 * `mpim:*` scope are omitted. No tool opens a multi-party DM; multi-party DM
 * access stays deferred rather than requesting scopes
 * nothing exercises.
 */
export const SLACK_USER_SCOPES = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "chat:write",
  "search:read",
  "reactions:write",
  "users:read",
  "im:write",
  "im:history",
  "files:write",
];

/** The capability classes Slack tools declare — one per verb. */
export type SlackCapability =
  | "read"
  | "send"
  | "reply"
  | "react"
  | "edit"
  | "upload"
  | "list_channels"
  | "search"
  | "list_users"
  | "dm_read"
  | "dm_send";

/**
 * Capability → the granted scopes that satisfy it (any one suffices — a
 * credential holding only `channels:history` still reads public channels).
 * Each tool sets its `requiredScopes` from this map, feeding the pre-policy
 * scope precondition: a connected credential whose
 * granted scopes cover none of a tool's entry is denied `needs_authorization`
 * before policy and routed to reconnect — how a credential consented under
 * the original five-scope set meets the tools added since, the same
 * cross-tier behavior gmail's map provides.
 *
 * Name-resolution scopes are deliberately absent from verbs that use them
 * only incidentally: channel ops resolve names via `channels:read` /
 * `groups:read` and DM ops resolve handles via `users:read`, and a
 * resolution failure there should surface as the self-correcting "unknown
 * channel/user" tool error, not a scope denial. The same scopes ARE the
 * entry for `list_channels` / `list_users`, whose whole action is directory
 * reading.
 *
 * `list_channels` lists both public and private channels
 * (`types=public_channel,private_channel`), which needs `channels:read` AND
 * `groups:read` at the API. The gate lists both as any-of rather than
 * requiring both: because Slack consent is all-or-nothing over the requested
 * set — and every scope set this integration has ever requested holds both
 * (the original five-scope set included them) — a credential that passes the
 * gate on either always carries both. The any-of form never admits a
 * `channels:read`-only credential that the private half would reject. This
 * safety is coupled to that all-or-nothing invariant: a future public-only
 * scope variant that dropped `groups:read` would let a
 * `channels:read`-only credential pass this gate and then hit a raw
 * `missing_scope` on the private half of the listing — the same trap the
 * channel-name resolver's `types=public_channel,private_channel` argument
 * carries. Before shipping such a variant, split this into a public-only
 * entry, or request `private_channel` only when `groups:read` is granted.
 *
 * `dm_send` gates on `im:write` alone even though posting also uses
 * `chat:write`: the gate passes on ANY listed scope, so listing `chat:write`
 * would wave a pre-DM-tier credential through to a raw missing_scope at
 * `conversations.open`. `im:write` is the scope that distinguishes the DM
 * consent tier, and `chat:write` always accompanies it (Slack consent is
 * all-or-nothing over the requested set). `dm_read` likewise gates on
 * `im:history` alone: the DM tools open a 1:1 `im` only, never a multi-party
 * `mpim`, so `mpim:history` is neither requested nor an alternative here.
 */
export const SLACK_CAPABILITY_SCOPES: Record<SlackCapability, string[]> = {
  read: ["channels:history", "groups:history"],
  send: ["chat:write"],
  reply: ["chat:write"],
  react: ["reactions:write"],
  edit: ["chat:write"],
  upload: ["files:write"],
  list_channels: ["channels:read", "groups:read"],
  search: ["search:read"],
  list_users: ["users:read"],
  dm_read: ["im:history"],
  dm_send: ["im:write"],
};

/**
 * Account-level sentinel nouns for the verbs whose object is the workspace
 * itself, not one channel. UPPERCASE on purpose: Slack forces channel names
 * to lowercase, so an uppercase sentinel can never collide with a real
 * channel name — gmail's sentinel-noun collision-proofing, inverted
 * (gmail's label nouns are uppercase, so its sentinel is
 * lowercase). Do not lowercase these.
 */
export const SLACK_CHANNELS_NOUN = "CHANNELS";
export const SLACK_WORKSPACE_NOUN = "WORKSPACE";
export const SLACK_DIRECTORY_NOUN = "DIRECTORY";

/** Default page size for message-reading tools when `limit` is omitted. */
export const SLACK_READ_DEFAULT_LIMIT = 10;

/** Upper bound on message-reading `limit` — one conversations.history page. */
export const SLACK_READ_MAX_LIMIT = 100;

/** Default result count for slack_search — Slack's own default page size. */
export const SLACK_SEARCH_DEFAULT_LIMIT = 20;

/** Upper bound on slack_search's `limit` — one search.messages page. */
export const SLACK_SEARCH_MAX_LIMIT = 100;

/** Default entry count for the directory tools (list_channels, list_users). */
export const SLACK_LIST_DEFAULT_LIMIT = 100;

/** Upper bound on the directory tools' `limit`. */
export const SLACK_LIST_MAX_LIMIT = 1000;

function isValidLimit(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= max
  );
}

function invalidLimitError(max: number): ToolExecutionResult {
  return {
    success: false,
    error: `Invalid parameter: limit must be an integer between 1 and ${max}`,
  };
}

/**
 * Required-string re-validation shared by every executor. The input schema
 * is advisory to the LLM, not enforced upstream, so each executor
 * re-validates here — a missing or non-string param fails as an input error
 * before any fetch.
 */
function invalidString(value: unknown, description: string): string | null {
  if (typeof value !== "string" || value === "") {
    return `Invalid parameter: ${description}`;
  }
  return null;
}

/** The channel param the channel-scoped tools govern on. */
function invalidChannel(value: unknown): string | null {
  return invalidString(value, "channel must be a non-empty channel name");
}

/**
 * The counterparty handle the DM tools govern on, canonicalized: any
 * caller-typed leading `@`s are stripped so the noun (`@` + handle) is never
 * doubled and resolution sees the bare username. Returns null when invalid.
 */
function canonicalHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const handle = value.replace(/^@+/, "");
  return handle === "" ? null : handle;
}

/**
 * The DM noun: `@` + the canonical counterparty handle. Derived through the
 * same canonicalHandle the executor resolves with, so the governed noun is
 * always `@` + the exact string handed to resolveUserId — they cannot
 * diverge on a doubled or malformed `@`. An invalid handle yields the bare
 * `@` sentinel; the executor rejects it before any fetch. `@` cannot appear
 * in a Slack channel name, so a DM grant can never match a channel grant or
 * vice versa.
 *
 * The noun is the literal handle the caller typed (canonicalized), NOT the
 * resolved user id — resolution needs a network round trip and the noun must
 * be derivable synchronously before governance. So the same person reached by
 * username (`@jane`) and by display name (`@Jane Doe`) governs as two distinct
 * nouns, and a grant on one does not cover the other. This fails closed — an
 * ungranted form is held, never silently allowed — at the cost of a coarser
 * grant surface than one keyed on identity.
 */
function dmNoun(params: Record<string, unknown>): string {
  return `@${canonicalHandle(params.handle) ?? ""}`;
}

function toErrorResult(err: unknown): ToolExecutionResult {
  const message = err instanceof Error ? err.message : "Tool execution failed";
  return { success: false, error: message };
}

const NO_CREDENTIAL: ToolExecutionResult = {
  success: false,
  error: "No credential found for service: slack",
};

/**
 * Read a channel's recent messages: resolve the human channel name (the
 * governed noun) to its id, then fetch history. Scaffolding (credential
 * check, validation, error wrapping) is inline — Slack's channel vocabulary
 * does not fit the email-shaped capability builder.
 */
export const SLACK_READ: Tool = {
  service: "slack",
  verb: "read",
  description:
    "Read recent messages from a Slack channel the user belongs to. " +
    "Takes the channel name (without the leading #) and returns message " +
    "sender, text, and timestamp.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.read,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SLACK_READ_MAX_LIMIT,
        description:
          `Maximum number of messages to return. Defaults to ` +
          `${SLACK_READ_DEFAULT_LIMIT}, at most ${SLACK_READ_MAX_LIMIT}.`,
      },
    },
    required: ["channel"],
  },
  // Verbatim, so channel-pattern policies (eng-*) match what the caller sent
  // and the audited noun is the name the user reads.
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const channelError = invalidChannel(params.channel);
    if (channelError) {
      return { success: false, error: channelError };
    }
    const limit = params.limit ?? SLACK_READ_DEFAULT_LIMIT;
    if (!isValidLimit(limit, SLACK_READ_MAX_LIMIT)) {
      return invalidLimitError(SLACK_READ_MAX_LIMIT);
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      const data = await fetchChannelHistory(token, channelId, limit);
      return { success: true, data: { channel, messages: data.messages } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Post a message to a channel as the authorizing user: resolve the channel
 * name, then chat.postMessage with the user token.
 */
export const SLACK_SEND: Tool = {
  service: "slack",
  verb: "send",
  description:
    "Send a message to a Slack channel as the user. Takes the channel name " +
    "(without the leading #) and the message text.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.send,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      text: {
        type: "string",
        description: "The message text to post.",
      },
    },
    required: ["channel", "text"],
  },
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const channelError = invalidChannel(params.channel);
    if (channelError) {
      return { success: false, error: channelError };
    }
    const textError = invalidString(
      params.text,
      "text must be a non-empty string",
    );
    if (textError) {
      return { success: false, error: textError };
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      const posted = await postChannelMessage(
        token,
        channelId,
        params.text as string,
      );
      return { success: true, data: { channel, ts: posted.ts } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Reply within a channel thread — its own verb and grant, governed on the
 * same verbatim channel noun as send; `thread_ts` sets threading only and
 * never enters the noun.
 */
export const SLACK_REPLY: Tool = {
  service: "slack",
  verb: "reply",
  description:
    "Reply to a message thread in a Slack channel as the user. Takes the " +
    "channel name (without the leading #), the thread_ts of the thread's " +
    "parent message (e.g. from slack_read), and the reply text.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.reply,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      thread_ts: {
        type: "string",
        description:
          "Timestamp (ts) of the thread's parent message, e.g. from slack_read.",
      },
      text: {
        type: "string",
        description: "The reply text to post.",
      },
    },
    required: ["channel", "thread_ts", "text"],
  },
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidChannel(params.channel) ??
      invalidString(
        params.thread_ts,
        "thread_ts must be a non-empty message timestamp",
      ) ??
      invalidString(params.text, "text must be a non-empty string");
    if (error) {
      return { success: false, error };
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      const posted = await postThreadReply(
        token,
        channelId,
        params.thread_ts as string,
        params.text as string,
      );
      return {
        success: true,
        data: { channel, thread_ts: params.thread_ts, ts: posted.ts },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Add an emoji reaction to a channel message. The reacted-to message is
 * addressed by (channel, timestamp); the channel is the governed noun.
 */
export const SLACK_REACT: Tool = {
  service: "slack",
  verb: "react",
  description:
    "Add an emoji reaction to a message in a Slack channel as the user. " +
    "Takes the channel name (without the leading #), the message timestamp " +
    "(ts from slack_read), and the emoji name without colons, e.g. thumbsup.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.react,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      timestamp: {
        type: "string",
        description: "Timestamp (ts) of the message to react to.",
      },
      emoji: {
        type: "string",
        description: "Emoji name without colons, e.g. thumbsup.",
      },
    },
    required: ["channel", "timestamp", "emoji"],
  },
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidChannel(params.channel) ??
      invalidString(
        params.timestamp,
        "timestamp must be a non-empty message timestamp",
      ) ??
      invalidString(params.emoji, "emoji must be a non-empty emoji name");
    if (error) {
      return { success: false, error };
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      await addReaction(
        token,
        channelId,
        params.timestamp as string,
        params.emoji as string,
      );
      return {
        success: true,
        data: { channel, timestamp: params.timestamp, emoji: params.emoji },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Edit a message the user previously posted. Slack itself restricts
 * chat.update to the authenticated user's own messages (anything else fails
 * with cant_update_message), so the blast radius is the user's own words.
 */
export const SLACK_EDIT: Tool = {
  service: "slack",
  verb: "edit",
  description:
    "Edit a message the user previously posted in a Slack channel. Takes " +
    "the channel name (without the leading #), the message timestamp (ts), " +
    "and the replacement text. Only the user's own messages can be edited.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.edit,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      ts: {
        type: "string",
        description: "Timestamp (ts) of the message to edit.",
      },
      text: {
        type: "string",
        description: "The replacement message text.",
      },
    },
    required: ["channel", "ts", "text"],
  },
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidChannel(params.channel) ??
      invalidString(params.ts, "ts must be a non-empty message timestamp") ??
      invalidString(params.text, "text must be a non-empty string");
    if (error) {
      return { success: false, error };
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      const updated = await updateMessage(
        token,
        channelId,
        params.ts as string,
        params.text as string,
      );
      return { success: true, data: { channel, ts: updated.ts } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Upload a text file to a channel via Slack's three-step external upload
 * flow (see uploadFile). The channel the file is shared to is the governed
 * noun; filename and content are audited as parameter metadata.
 */
export const SLACK_UPLOAD: Tool = {
  service: "slack",
  verb: "upload",
  description:
    "Upload a text file to a Slack channel as the user. Takes the channel " +
    "name (without the leading #), a filename, the file's text content, and " +
    "an optional comment to post alongside it.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.upload,
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel name without the leading #, e.g. eng-alerts.",
      },
      filename: {
        type: "string",
        description: "Name for the uploaded file, e.g. report.md.",
      },
      content: {
        type: "string",
        description: "The file's text content.",
      },
      comment: {
        type: "string",
        description: "Optional message posted alongside the shared file.",
      },
    },
    required: ["channel", "filename", "content"],
  },
  nounExtractor: (params) => String(params.channel),
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const comment = params.comment ?? undefined;
    const error =
      invalidChannel(params.channel) ??
      invalidString(params.filename, "filename must be a non-empty string") ??
      invalidString(params.content, "content must be a non-empty string") ??
      (comment === undefined
        ? null
        : invalidString(
            comment,
            "comment must be a non-empty string when provided",
          ));
    if (error) {
      return { success: false, error };
    }
    const channel = params.channel as string;
    try {
      const channelId = await resolveChannelId(token, channel);
      const uploaded = await uploadFile(token, {
        channelId,
        filename: params.filename as string,
        content: params.content as string,
        comment: comment as string | undefined,
      });
      return {
        success: true,
        data: { channel, fileId: uploaded.fileId, title: uploaded.title },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * List the workspace's channels. Governed as the account-level CHANNELS
 * sentinel: enumerating the channel directory is consented per
 * account/session, not per channel — no single channel noun exists to bind.
 */
export const SLACK_LIST_CHANNELS: Tool = {
  service: "slack",
  verb: "list_channels",
  description:
    "List Slack channels in the user's workspace: public channels, and " +
    "private channels the user belongs to. Returns channel names.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.list_channels,
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SLACK_LIST_MAX_LIMIT,
        description:
          `Maximum number of channels to return. Defaults to ` +
          `${SLACK_LIST_DEFAULT_LIMIT}, at most ${SLACK_LIST_MAX_LIMIT}.`,
      },
    },
  },
  nounExtractor: () => SLACK_CHANNELS_NOUN,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const limit = params.limit ?? SLACK_LIST_DEFAULT_LIMIT;
    if (!isValidLimit(limit, SLACK_LIST_MAX_LIMIT)) {
      return invalidLimitError(SLACK_LIST_MAX_LIMIT);
    }
    try {
      const channels = await listChannels(token, limit);
      return { success: true, data: { channels } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Search messages across the workspace. Governed as the account-level
 * WORKSPACE sentinel, and the WORKSPACE grant is deliberately coarse: it is
 * the single broadest read grant in the Slack surface. `search.messages`
 * with a user token reaches everything the authorizing user can see — every
 * public and private channel they belong to AND their direct messages
 * (verified 2026-07-11, docs.slack.dev) — so this crosses the channel/DM
 * boundary that the verbatim-channel and `@handle` nouns otherwise keep
 * disjoint. It is NOT scoped per channel: an `in:#channel` operator in the
 * query bounds the *results* but never the *grant*, so a WORKSPACE grant
 * covers any query. The raw query is audited as parameter metadata, never
 * the noun — the free-form string is a poor grant key. A caller who wants
 * per-channel read governance uses slack_read, not a scoped search.
 */
export const SLACK_SEARCH: Tool = {
  service: "slack",
  verb: "search",
  description:
    "Search messages across everything the user can see in Slack — all " +
    "channels they belong to (public and private) AND their direct " +
    "messages — using Slack search syntax (operators like in:#channel and " +
    "from:@user narrow the results). Returns matching messages with channel, " +
    "sender, text, and timestamp.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.search,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Slack search query, e.g. 'deploy failed in:#eng-alerts'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SLACK_SEARCH_MAX_LIMIT,
        description:
          `Maximum number of matches to return. Defaults to ` +
          `${SLACK_SEARCH_DEFAULT_LIMIT}, at most ${SLACK_SEARCH_MAX_LIMIT}.`,
      },
    },
    required: ["query"],
  },
  nounExtractor: () => SLACK_WORKSPACE_NOUN,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const queryError = invalidString(
      params.query,
      "query must be a non-empty string",
    );
    if (queryError) {
      return { success: false, error: queryError };
    }
    const limit = params.limit ?? SLACK_SEARCH_DEFAULT_LIMIT;
    if (!isValidLimit(limit, SLACK_SEARCH_MAX_LIMIT)) {
      return invalidLimitError(SLACK_SEARCH_MAX_LIMIT);
    }
    try {
      const result = await searchMessages(token, params.query as string, limit);
      return {
        success: true,
        data: { total: result.total, matches: result.matches },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * List the workspace's members. Governed as the account-level DIRECTORY
 * sentinel — reading the user directory is the action itself, so its
 * users:read scope IS the gated capability here (unlike the DM tools, where
 * it is incidental resolution).
 */
export const SLACK_LIST_USERS: Tool = {
  service: "slack",
  verb: "list_users",
  description:
    "List the members of the user's Slack workspace. Returns each member's " +
    "username (the handle for slack_dm_read / slack_dm_send), display name, " +
    "and whether it is a bot.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.list_users,
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SLACK_LIST_MAX_LIMIT,
        description:
          `Maximum number of members to return. Defaults to ` +
          `${SLACK_LIST_DEFAULT_LIMIT}, at most ${SLACK_LIST_MAX_LIMIT}.`,
      },
    },
  },
  nounExtractor: () => SLACK_DIRECTORY_NOUN,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const limit = params.limit ?? SLACK_LIST_DEFAULT_LIMIT;
    if (!isValidLimit(limit, SLACK_LIST_MAX_LIMIT)) {
      return invalidLimitError(SLACK_LIST_MAX_LIMIT);
    }
    try {
      const users = await listUsers(token, limit);
      return { success: true, data: { users } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Read the user's 1:1 direct-message history with one counterparty: resolve
 * the handle (the governed `@handle` noun) to a user id, open the DM
 * conversation, then fetch its history.
 */
export const SLACK_DM_READ: Tool = {
  service: "slack",
  verb: "dm_read",
  description:
    "Read recent messages from the user's Slack direct-message conversation " +
    "with one person. Takes the counterparty's username or display name " +
    "(without the leading @).",
  requiredScopes: SLACK_CAPABILITY_SCOPES.dm_read,
  inputSchema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The counterparty's Slack username or display name, without the " +
          "leading @, e.g. jane.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SLACK_READ_MAX_LIMIT,
        description:
          `Maximum number of messages to return. Defaults to ` +
          `${SLACK_READ_DEFAULT_LIMIT}, at most ${SLACK_READ_MAX_LIMIT}.`,
      },
    },
    required: ["handle"],
  },
  nounExtractor: dmNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const handle = canonicalHandle(params.handle);
    if (handle === null) {
      return {
        success: false,
        error: "Invalid parameter: handle must be a non-empty Slack username",
      };
    }
    const limit = params.limit ?? SLACK_READ_DEFAULT_LIMIT;
    if (!isValidLimit(limit, SLACK_READ_MAX_LIMIT)) {
      return invalidLimitError(SLACK_READ_MAX_LIMIT);
    }
    try {
      const userId = await resolveUserId(token, handle);
      const dmChannelId = await openDirectMessage(token, userId);
      const data = await fetchChannelHistory(token, dmChannelId, limit);
      return {
        success: true,
        data: { handle: `@${handle}`, messages: data.messages },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Send a 1:1 direct message as the user: resolve the handle (the governed
 * `@handle` noun) to a user id, then open-and-post via the client.
 */
export const SLACK_DM_SEND: Tool = {
  service: "slack",
  verb: "dm_send",
  description:
    "Send a Slack direct message to one person as the user. Takes the " +
    "counterparty's username or display name (without the leading @) and " +
    "the message text.",
  requiredScopes: SLACK_CAPABILITY_SCOPES.dm_send,
  inputSchema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description:
          "The counterparty's Slack username or display name, without the " +
          "leading @, e.g. jane.",
      },
      text: {
        type: "string",
        description: "The message text to send.",
      },
    },
    required: ["handle", "text"],
  },
  nounExtractor: dmNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const handle = canonicalHandle(params.handle);
    if (handle === null) {
      return {
        success: false,
        error: "Invalid parameter: handle must be a non-empty Slack username",
      };
    }
    const textError = invalidString(
      params.text,
      "text must be a non-empty string",
    );
    if (textError) {
      return { success: false, error: textError };
    }
    try {
      const userId = await resolveUserId(token, handle);
      const posted = await postDirectMessage(
        token,
        userId,
        params.text as string,
      );
      return { success: true, data: { handle: `@${handle}`, ts: posted.ts } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * The slack service: declarative data only. Its OAuth machinery lives on the
 * `slack` provider strategy; this contributes the scopes and tools. SLACK_READ
 * stays first — the iterated catalog invariants exercise each service's first
 * tool with channel-shaped params.
 */
export const slack: ServiceDefinition = {
  service: "slack",
  connect: {
    type: "oauth",
    provider: "slack",
    scopes: SLACK_USER_SCOPES,
  },
  tools: [
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
  ],
};
