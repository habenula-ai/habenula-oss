# Outlook Mail Integration

Outlook Mail is the first service on the `microsoft` OAuth provider (`packages/tools/src/services/microsoft/outlook-mail.ts`) — the service that proves the Microsoft Graph harness. Its tools call Microsoft Graph (`/v1.0`) directly with raw `fetch` (no Graph SDK, no MSAL), authenticated by the credential the dispatch layer resolves and injects; an executor never resolves a credential itself. A later Microsoft service (Outlook Calendar, Teams, OneDrive) contributes only its scopes and tools to the existing provider strategy and reuses the shared Graph substrate (`services/microsoft/graph.ts`) — no new secret, redirect URI, or OAuth code.

The four tools ride the shared email verb pool (`services/shared/`): the same builders, page-size ceiling, read-body truncation contract, and recipient-address noun Gmail uses, with a Graph-native executor where the wire format differs.

## Tool surface

Each tool is its own `(service, verb)` permission subject with its own noun. The noun is extracted synchronously from the call's own params — no credential, no network — so it is the grant key and the audit target at once.

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `outlook_mail_list` | `list` | the folder listed (`inbox`, `sentitems`, `drafts`, `deleteditems`, `junkemail`, `archive`; defaults to `inbox`) | read |
| `outlook_mail_read` | `read` | the constant sentinel `mailbox` — read is consented per account/session, not per message; the message id's value is not audited — the row records only the parameter's shape | read |
| `outlook_mail_search` | `search` | the constant `anywhere` — Graph `$search` is whole-mailbox with no `in:`/`label:` operators to narrow on; the raw `q` is never the noun, and its value is not audited — the row records only its shape | read |
| `outlook_mail_send` | `send` | the set of distinct recipient addresses across `to`+`cc`+`bcc` — `recipientAddressesNoun` reused verbatim, the same rule Gmail governs sends by | send |

**The folder vocabulary is identity-mapped.** The labels are Graph well-known folder names usable verbatim in the URL path — no Gmail-style `DRAFTS → DRAFT` translation table. Gmail's `STARRED`/`IMPORTANT` have no folder analogue (they are flags, not folders) and are omitted.

**The read sentinel cannot collide.** No Graph well-known folder is named `mailbox`, and the grant tuple carries the verb regardless. Gmail's non-collision guarantee rests on its nouns being uppercase system IDs; Outlook's vocabulary is lowercase, so the property is re-derived for this vocabulary (pinned by a test), not inherited from Gmail's casing convention.

**Search governs as a whole-mailbox read.** This is a deliberate reduction in policy expressiveness versus Gmail, whose search noun narrows to the resolved label when the query filters: a user cannot grant "search only folder X" for Outlook. Folder-scoped search (`/me/mailFolders/{id}/messages?$search=`), which would let the noun narrow, is deferred future work.

**Send governance is identical to Gmail's.** Any change to the recipient set — an extra address, or a new mailbox even inside an already-granted domain — changes the noun and forces a fresh confirmation (per-address subset coverage is planned follow-up work). The recipient-address noun reads the `to`/`cc`/`bcc` params, not any transmitted wire format, so it transfers across providers unchanged — the "not Google-shaped" proof.

## OAuth scopes and the capability check

`outlookMail.connect.scopes` requests `offline_access` + `Mail.Read` + `Mail.Send` (Graph scopes in their fully-qualified wire form) — the least-privilege set for the four-tool surface. `User.Read` is never requested (nothing in this release reads account identity); `Mail.ReadWrite` is never requested (no hygiene verbs yet). `offline_access` is provider-level, not a service choice: without it Entra issues no refresh token and every Microsoft service silently becomes re-connect-on-expiry.

**Scopes are stored canonicalized.** Entra's token responses vary between fully-qualified (`https://graph.microsoft.com/Mail.Read`) and short (`Mail.Read`) scope forms, and the pre-policy scope gate is an exact string-membership check. The provider's `normalizeGraphScope` (strip the Graph prefix, lowercase) runs on every granted scope at both the exchange and refresh legs, and the capability map (`OUTLOOK_MAIL_CAPABILITY_SCOPES`) declares the same canonical form: `read: [mail.read, mail.readwrite]`, `send: [mail.send]`. Both sides of the comparison are Microsoft-owned code, so the canonical form is self-consistent whatever form Entra returns. `mail.readwrite` in the read arm is forward-compat — never granted in this release, listed so a later service that consents ReadWrite satisfies read with no map edit (broader covers narrower). A miss produces the `needs_authorization` outcome (see `docs/architecture/governance.md`), routing the user to re-connect out of band (`habenula connect outlook_mail`).

**Cross-consent scope union (future concern).** A Microsoft refresh token is valid for every scope the user has consented to on this app registration, and Microsoft has no `include_granted_scopes` to drop — narrowing happens by sending a reduced `scope` on the token request. With one Microsoft service there is no union to narrow; per-service consent scoping is deferred to the second Microsoft service.

**Acquiring the credential.** Registering the Entra app and wiring its client ID/secret into Habenula is covered in [`connect/microsoft.md`](../../connect/microsoft.md).

## Refresh-token rotation

Microsoft returns a new refresh token on **every** successful refresh and invalidates the old one — GitHub's rule, not Google's. The provider asserts the rotated token is present and stores it directly, on both the exchange and refresh legs; a missing token throws rather than falling back to the old value, because a `data.refresh_token ?? old` fallback would silently persist the token Entra just invalidated and brick the connection on the next refresh. The refresher's write-back (`SingleFlightRefresher.doRefresh`) persists the rotated credential automatically. Overlapping refreshes cannot race today: the refresher single-flights per `userId:service`, and the single active session serializes dispatches; the later coordinator/worker split must serialize refresh-and-write per credential for this provider (a standing design obligation).

## API quirks

- **No N+1 fanout.** Graph returns list metadata inline (`$select=subject,from,receivedDateTime`), unlike Gmail's one-subrequest-per-message fanout. The shared `EMAIL_LIST_MAX_RESULTS_CEILING` still caps rows for cross-service consistency.
- **Pagination is bounded twice — and origin-pinned.** A response carrying `@odata.nextLink` has more pages; the substrate follows the link **verbatim** (a complete opaque URL, never reconstructed — and only back to `graph.microsoft.com`: a foreign origin in a response body is refused before the Bearer token is attached) and stops at `maxResults` rows or `GRAPH_PAGE_CAP` (5) pages, whichever comes first — never draining the folder. `$top` asks for the governed page size so one page normally satisfies the request. `$search` responses page differently from a plain folder list (Graph caps search result sets and rejects `$count`/`$skip`), so the bound is enforced — and tested — on each path in its own right.
- **Throttling is honored within a ceiling.** A `429` whose `Retry-After` is within `GRAPH_RETRY_AFTER_CEILING_SECONDS` (5) waits and retries, at most `GRAPH_MAX_RETRIES` (2) times (~10s worst case); a larger value fails the call immediately — no per-tool-call timeout exists in this release, so the ceiling is the operative bound on how long a throttled Graph call can stall the session's synchronous dispatch. Absent the header: bounded exponential backoff (1s, 2s).
- **Search syntax is Graph `$search` (KQL), not Gmail query syntax.** `from:`/`to:`/`subject:` and free text, always whole-mailbox. The `$search` value is double-quoted with embedded backslashes and quotes backslash-escaped (backslashes first, so the escape state cannot corrupt); `$orderby`/`$count`/`$skip` are never sent alongside it (Graph rejects them). Whether Graph accepts the exact escaping the client emits is confirmed by the manual staging round-trip, not a fixture.
- **Bodies arrive as text on request.** `outlook_mail_read` sends `Prefer: outlook.body-content-type="text"`, so Graph converts HTML bodies server-side — no client-side MIME walking or base64 decoding. The body is capped by the shared truncation contract (`EMAIL_READ_BODY_MAX_CHARS`, 25k characters, surrogate-safe cut, explicit marker — `services/shared/email-read.ts`).
- **Send is structured JSON and asynchronous.** `POST /me/sendMail` takes `{ message: { subject, body, toRecipients, … }, saveToSentItems: true }` — no MIME assembly and no header lines, so Gmail's header-injection sanitizer has no analogue here (recipient strings are JSON values end to end). Graph answers `202 Accepted`: the request was accepted, **not** delivered — a downstream Exchange bounce is invisible at call time. The tool result and description both say acceptance; delivery is subject to Exchange Online limits.
- **Message bodies never enter the audit log.** `read`/`search` return bodies to the model (their purpose); the audit entry records parameter metadata only (metadata-only default, unchanged). Send recipient addresses persist as the governed noun on the audit row; bodies are not recorded.
