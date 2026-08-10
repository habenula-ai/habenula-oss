# Slack Integration

Slack is a Slack-provider OAuth service (`packages/tools/src/services/slack/slack.ts`). Its tools call the Slack Web API directly with raw `fetch` (no Slack SDK), authenticated by the credential the dispatch layer resolves and injects; an executor never resolves a credential itself.

The connection uses a **user token**, not a bot token. The OAuth flow requests `user_scope`, so the agent acts as the authorizing user — it sees exactly the channels, direct messages, and search results that person sees, and every action is attributed to them. There is no separate bot identity to add to channels.

## Tool surface

Each tool is its own `(service, verb)` permission subject with its own noun. The noun is extracted synchronously from the call's own params — no credential, no network — so it is the grant key and the audit target at once.

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `slack_read` | `read` | the channel name read, verbatim | read |
| `slack_send` | `send` | the channel name posted to, verbatim | send |
| `slack_reply` | `reply` | the channel name replied in; `thread_ts` sets threading only and never enters the noun | send |
| `slack_react` | `react` | the channel name reacted in, verbatim | react |
| `slack_edit` | `edit` | the channel name of the edited message, verbatim | edit |
| `slack_upload` | `upload` | the channel name a file is shared to, verbatim | upload |
| `slack_list_channels` | `list_channels` | the constant sentinel `CHANNELS` — a directory read is consented once per session, not per channel | read |
| `slack_search` | `search` | the constant sentinel `WORKSPACE` — search is deliberately the single broadest read grant (see quirks) | read |
| `slack_list_users` | `list_users` | the constant sentinel `DIRECTORY` | read |
| `slack_dm_read` | `dm_read` | `@` plus the counterparty handle as typed, canonicalized — the literal handle, never the resolved user id | read |
| `slack_dm_send` | `dm_send` | `@` plus the counterparty handle as typed, canonicalized | send |

The channel nouns are the channel name exactly as the call supplies it. Send, reply, react, edit, upload, and both direct-message verbs are consequential: with no seeded grant they hold for confirmation on first use, and any change of channel or counterparty changes the noun and forces a fresh confirmation. A grant covers exactly the confirmed channel for the session.

The three directory verbs (`list_channels`, `search`, `list_users`) noun as fixed uppercase sentinels. Slack forces channel names to lowercase, so an uppercase sentinel can never collide with a real channel name — a directory grant can never be mistaken for a grant over a channel called `channels`.

Direct messages noun on the **typed handle**, not the resolved Slack user id. `@jane` and `@Jane Doe` are two distinct nouns, even if they resolve to the same person, so a direct-message grant is bound to the exact handle the user confirmed. An ambiguous handle fails closed rather than resolving to a wider target.

## OAuth scopes and the capability check

`slack.connect.scopes` requests eleven user scopes, each mapped to the tools that need it:

| Scope | Tools it enables |
|-------|------------------|
| `channels:read`, `groups:read` | `slack_list_channels` |
| `channels:history`, `groups:history` | `slack_read` |
| `chat:write` | `slack_send`, `slack_reply`, `slack_edit` |
| `reactions:write` | `slack_react` |
| `files:write` | `slack_upload` |
| `search:read` | `slack_search` |
| `users:read` | `slack_list_users` |
| `im:write` | `slack_dm_send` |
| `im:history` | `slack_dm_read` |

Each tool declares a **capability** (`Tool.requiredScopes`): the set of scopes any one of which covers it (`SLACK_CAPABILITY_SCOPES`). The pre-policy scope precondition checks capability coverage against the credential's *actually granted* scopes, never exact-string membership. A miss produces the `needs_authorization` outcome (see [`governance.md`](../governance.md)), routing the user to re-connect out of band (`habenula connect slack`). Slack grants a connection's scopes all-or-nothing — a user cannot decline a single scope from the consent screen — so the any-of capability check is safe here: a granted connection holds the full requested set.

**Acquiring the credential.** Registering the Slack app and wiring its client ID and secret into Habenula is covered in [`connect/slack.md`](../../connect/slack.md).

## API quirks

- **Failures arrive as HTTP 200.** The Slack Web API reports most errors with a `200` status and an `{ "ok": false, "error": "…" }` body. Every call checks the `ok` field, not the HTTP status alone; a naive status check would read a permission failure as success.
- **`slack_search` crosses the channel and direct-message boundary.** A user token's search reaches every channel that person belongs to *and* their direct messages, which is why the noun is the single `WORKSPACE` sentinel rather than a channel. An `in:#channel` filter narrows the returned *results*, not the *grant* — the grant still authorizes a workspace-wide read. Consent for `slack_search` is consent to search everything the user can see.
- **`slack_edit` can only edit the user's own messages.** Slack's `chat.update` refuses another author's message with `cant_update_message`. Because the connection is a user token, the agent can edit only messages that user sent.
- **The user token nests differently on connect and refresh.** The initial code exchange returns the user token inside an `authed_user` object; a refresh returns it flat at the top level. The two mappings are read separately — reading the top-level `access_token` from the exchange response yields an empty credential.
- **Refresh tokens rotate and are single-use.** Each refresh returns a new refresh token that invalidates the previous one, so the new token must be persisted or the connection breaks. Token rotation must be enabled on the Slack app, or the exchange fails.
- **Cursor pagination runs to exhaustion.** List endpoints page on `next_cursor`. `conversations.list` caps at 1000 entries per page; `users.list` is paged conservatively. A rate-limited response (`429`) is surfaced with the body Slack returned.
- **File upload is a three-step external flow.** `slack_upload` calls `files.getUploadURLExternal` for a one-time URL, POSTs the raw bytes to `files.slack.com` as `application/octet-stream` (an unauthenticated upload host that answers in plain text, outside the `ok` envelope), then calls `files.completeUploadExternal` to share the file into the channel. A failure at any step surfaces as a tool error.
- **Scopes are comma-separated.** Slack returns granted scopes as a comma-separated string, split on connect and stored as the credential's granted-scope set.
- **Message content never enters the audit log.** Send, reply, edit, DM, and upload bodies pass through to Slack; the audit entry records parameter metadata only, with the channel or recipient persisting as the governed noun (the metadata-only default).
