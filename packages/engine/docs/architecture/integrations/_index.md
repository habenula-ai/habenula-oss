# Integrations Index

Each integration has its own doc covering its OAuth scopes, its tool surface and per-verb nouns, and its API quirks. The service catalog (`packages/tools/src/services/`) is the source of truth for what ships; a row below exists only when its doc file exists.

To document a new integration, copy [`_template.md`](_template.md) and fill it in.

## Shipped integrations

These services are on `main` and connectable by a user. Each is a direct API client Habenula authored — an in-process integration, not a self-declaring external server.

| Service | Doc | Notes |
|---------|-----|-------|
| Gmail | [`gmail.md`](gmail.md) | Read, search, send, reply, draft, and mailbox hygiene. |
| Google Calendar | [`google-calendar.md`](google-calendar.md) | Official Google API. |
| Outlook Mail | [`outlook-mail.md`](outlook-mail.md) | First service on the Microsoft Graph harness. |
| Slack | [`slack.md`](slack.md) | User-token connection; 11 tools across channels, search, and direct messages. |
| GitHub | [`github.md`](github.md) | GitHub App user flow; a single read-only repository-listing tool today, with more planned. |

## Catalog services that are not third-party integrations

Two catalog entries are not services a user connects to a third party. They have rows here so the index matches the catalog, but they are documented elsewhere.

| Service | Doc | What it is |
|---------|-----|-----------|
| Mock Email, Mock Delivery | [`mocks.md`](mocks.md) | Development and test fixtures that exercise the governance pipeline (structured iteration and the spending cap) without a real provider. |
| Habenula (control plane) | [`inbound-mcp.md`](../inbound-mcp.md), [`governance.md`](../governance.md) | The agent's own control operations (`kill`, `disconnect`, `quit`, `status`, and policy reads) as governed tools, reachable only from the trusted internal drive interface. Not a connectable integration. |

## Planned integrations

Named on the roadmap, not yet in the catalog. No doc exists for these until the integration ships; they are listed here without file links so the index never points a reader at a file that is not there.

- **Google Drive** — official Google API.
- **Web Search** — via a search API.
- **File System** — a sandboxed local file service; no third-party ToS.
- **Web Browser** — headless Chromium; ToS depends on the sites accessed.
- **Telegram** — the bot API constrains agent-style use.
- **WhatsApp** — see the ToS warning below.

## WhatsApp ToS warning

WhatsApp's Terms of Service prohibit automated or bulk messaging through unofficial clients. The WhatsApp Business API (Meta's official channel) permits agent-style use but carries significant constraints: business verification, messaging templates for first-contact messages, rate limits, and geographic restrictions. An unofficial client library would violate the ToS and risk account bans, so a WhatsApp integration can only route through the official channel, inheriting those constraints.

## iMessage note

iMessage has no official API. Any iMessage integration would require running on a macOS device with the Messages app — a fundamentally different architecture from the integrations above. iMessage is not planned, and may not be feasible as a server-side integration at all.
