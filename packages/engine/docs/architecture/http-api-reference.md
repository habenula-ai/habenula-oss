# HTTP API Reference

The engine exposes a loopback HTTP API that its clients drive — the CLI, and any local client app. This documents the request/response shape of each endpoint. The executing Zod schemas at each Worker handler (and the shared wire contract in `packages/contracts`) are canonical; this is their human-readable companion.

## Running

```
just engine-dev          # starts wrangler dev on localhost:8787
```

## Endpoints

All endpoints return JSON with CORS headers (`Access-Control-Allow-Origin: *`). Unknown `/api/*` routes return 404. POST endpoints require a JSON body (returns 400 on invalid JSON).

All endpoints accept an optional `userId` field (defaults to `"demo-user"`). Each userId gets its own Durable Object with independent service connections, policy, and audit log.

A `userId` in a request body must be text the engine can record as it was sent. A value carrying an unpaired UTF-16 surrogate returns 400: such a value has no UTF-8 encoding, so recording it would mean recording a substituted spelling. Every unpaired surrogate substitutes to the same character, and `userId` selects the Durable Object, so two distinct identifiers would otherwise name one object and one audit log. A query-string `userId` cannot reach this refusal — the URL decoder replaces the sequence before the engine sees it.

### Health

**GET /api/health** — the deliberate liveness route. Answers "is the engine process serving requests": `{ "status": "ok", "engine": "habenula-engine" }`. State-free by design — no `userId`, no DO read — and it deliberately carries no build version: the route is unauthenticated, so it discloses only that an engine is serving. The CLI's offline probe and `just dev`'s readiness wait consume it; commands never preflight it.

### Service Connection

A single `POST /connect/{service}` entry begins a connection. It dispatches on a service catalog:

| Catalog kind | Behavior |
|--------------|----------|
| OAuth (e.g. `gmail`, `mock_email`) | Returns `{ "authorizeUrl": "...", "flow": "..." }` — the client opens the URL to run the consent flow and polls/cancels the pending flow by its `flow` handle |
| Credential-less (`none`) | Connects directly, no OAuth round-trip |
| Unknown service | 400 |

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/connect/{service}` | — | Begin a connection. OAuth services return `{ authorizeUrl, flow }`; credential-less services connect directly; unknown services return 400 |
| GET | `/api/connect/status` | — | Per-flow status for the connect wait loop (`?userId&service&flow`) → `{ "status": "pending" \| "connected" \| "denied" \| "expired" }` |
| POST | `/api/connect/cancel` | `{ "flow": "..." }` | Drop a pending connect flow. Idempotent — `{ "cancelled": bool }` reports whether a pending row existed |
| POST | `/api/services/disconnect` | `{ "service": "mock_email" }` | Disconnect a service — subsequent tool calls for it are denied. Idempotent: returns `{ disconnected, removed }`, where `removed` is `false` for an unknown or not-connected name (a no-op, not a false success) |
| GET | `/api/services` | — | List all connected services (userId via query param) |
| GET | `/api/services/catalog` | — | Enumerate the connectable set — `{ "services": [{ "service": "gmail" }, …] }`. Discovery only (no userId); the connect route stays the authority on unknown names |
| GET | `/callback/{provider}` | — | The OAuth redirect target — `/callback/google`, `/callback/mock`, `/callback/slack`, `/callback/github`, `/callback/microsoft`, one shared handler per provider. Consumes the OAuth state, exchanges the code, stores the encrypted credential, connects the service. Browser-driven (not client-called); a denial (`?error=`) stamps the flow `denied` and returns 400. Detail in `oauth-credentials.md` |

### Policy

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/policy` | — | Read the standing policy state (userId via query param) |

Default policy is **deny** (the `default-deny` floor). There is no set-allow route — the mutate path was removed with the confirmation flow. Grants are minted by approving a held call: an un-granted call on a connected service parks as `pending`, and `POST /api/resolve` `{ "heldCallId", "choice" }` resolves it (`"task"` mints a single-use grant, `"session"` a session-scoped one, `"deny"` refuses, `"tell_more"` returns the tool's registry metadata, `"approve_once"` answers a spending hold by placing that one order and minting nothing). A **spending hold** — a call held because it would cross a spending cap — accepts only `"deny"`, `"tell_more"`, and `"approve_once"`; an ordinary hold rejects `"approve_once"`. An answer that does not apply to the hold's kind returns **400** with `error_code: "INVALID_CHOICE"`, and the call stays parked. Resolution applies to holds of either origin: a hold parked by a direct `/api/tools/execute` call is resolved through the same `POST /api/resolve` route. Holds expire with the session — a held call is inert once its session passes 90 minutes from start.

### Settings

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/settings` | — | Read the spending caps: both limits in integer cents, whether each is the shipped default, and the current window sums (userId via query param) |
| POST | `/api/settings` | `{ "monthLimitCents": 7500 }` and/or `{ "sessionLimitCents": 2000 }` | Set one or both spending caps (non-negative integer cents). An empty update is a 400. Echoes the post-write read |

### Tool Execution (debug-gated)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/tools/execute` | `{ "toolName": "mock_email_list", "params": { "label": "INBOX" } }` | Execute a tool through the full governance pipeline |

**This route ships off.** It answers 404 unless the engine runs with `DEBUG_MODE=true` — exactly that value; anything else, or unset, keeps it closed. It drives a governed tool call with no conversation behind it, so it is a debugging surface, never an intended feature: the agent's own conversation is the intended way tools run.

`toolName` is required (400 otherwise), and it is refused on the same well-formedness rule as `userId` — it is written to a hashed audit column. The model picks a concrete per-service tool — `gmail_list` or `mock_email_list` — and dispatch routes on the named service.

Returns (flat — the governance internals such as the audit entry never ship on this wire; the audit log is read through `GET /api/audit`):
- `decision`: `"allow"` | `"deny"` | `"pending"` (a parked call awaiting confirmation)
- `service`, `verb`, `noun`: the governed classification of the call
- `execution`: tool result — present only when the decision is `"allow"`
- `denyReason`: present only on a deny that names a remediation — `"not_connected"` | `"needs_authorization"` | `"policy"` (the boundary refusal carries none)
- `held`: present only when the call parked for confirmation — carries the id to resolve

Tool execution requires the service connected, the policy "allow", **and** a stored credential for that service (established by connecting it — see Service Connection above, and `oauth-credentials.md`). With the policy allowing but no credential present, the call passes governance and then fails at credential resolution (`execution.success: false`). Denial reasons are distinguished in the audit log:
- `"Service not connected: mock_email"` — service not connected
- `"gmail is connected but not authorized to <verb>; re-connect to grant it"` — connected, but the stored credential's granted scopes don't cover the tool's declared capability (`denyReason: "needs_authorization"` on the wire)
- `"Denied by policy"` — service connected but policy is deny
- `"Refused: Habenula's control plane is reachable only from the trusted internal surface"` — the call named one of Habenula's own control operations, which this route never reaches. It carries **no** `denyReason`: there is no remediation to name. Nothing was parked, so there is no confirmation to answer. See `inbound-mcp.md`

### Chat (LLM Conversation)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/chat` | `{ "message": "What are my latest emails?" }` | Send a message through the LLM conversation loop |

Returns:
- `response`: LLM's natural language response
- `toolCalls`: list of tools the LLM invoked (name + id + outcome). A call whose `outcome` is `error` also carries `error`: the tool's own failure text. Every other outcome omits the field, because a refusal's reason is the outcome itself. Treat `error` as untrusted. The tool authors it, and it can embed content such as a recipient or a path. Render it as bounded data, never as trusted interface text
- `usage`: token counts (inputTokens, outputTokens)
- `iterations`: number of LLM round-trips
- `held`: present only when the turn parked a tool call awaiting confirmation — carries the id to resolve, and `response` is empty (the end-to-end example below turns on this field)

The LLM decides which tools to call based on the user's message. Each tool call flows through the full governance pipeline (registry lookup → policy check → audit log → execute). The LLM never sees raw OAuth credentials — only tool results.

Requires a configured model provider: `ANTHROPIC_API_KEY` for the default (Anthropic), or the `LLM_*` variables for any OpenAI-compatible backend (set in `packages/engine/.dev.vars` for `wrangler dev`, or in `.env` on the container path).

### Session Lifecycle

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/session/start` | `{}` | The interactive launch's handshake. Creates the active session, or returns **409** `{ "status": "refused", "activeSession": … }` when one is already active (the client attaches to it — no second session is created) |
| POST | `/api/session/quit` | `{}` | End the active session; idempotent — `{ "ended": false }` when nothing is active |
| GET | `/api/session` | — | The active session or `{ "active": null }` (userId via query param). View shape: `{ "sessionId", "startedAt", "expiry" }` |

`/api/chat` and `/api/tools/execute` carry no session id — the DO derives the active session (lazily creating one if none), which is what makes "for this session" grants persist across requests. The current release holds at most one active session per user; see [session-lifecycle.md](session-lifecycle.md).

### Kill Switch

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/kill` | `{}` | Deny-all: clear every policy grant to the `default-deny` floor and sweep held calls |

Returns `{ "killed": true }`. Connected services and their stored credentials are preserved — kill is deny-all, not disconnect. With every grant gone, a surviving credential is unusable, so the user resumes after a kill without re-running OAuth.

### Status

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/status` | — | The aggregate governed-session read (userId via query param) |

Returns `StatusResponse` — `{ session, grants, held, auditTail }`: the active session (or null), the standing grants in force (each `{ service, verb, noun, source: "session" \| "task", expiresAt }`), every pending held call, oldest first (an empty array when none), and the audit chain's tail (`{ hash, prevHash }`).

### Tasks

The task queue — commissioned and human-origin work, with a per-action breakdown. Backs `habenula task list` / `show` / `cancel`.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/tasks` | — | List tasks, newest first (`?userId&limit&cursor`) → `{ tasks, nextCursor }`. Keyset-paginated; `nextCursor` is null on the last page |
| GET | `/api/tasks/get` | — | One task's full record (`?userId&taskId`) → `{ task, statusDetail, awaitedSlotKeys }`. 400 without `taskId`, 404 if unknown |
| POST | `/api/tasks/cancel` | `{ "taskId": "..." }` | Cancel a parked task of any origin. Status union: `cancelled` (with `previousStatus`), `running` / `resolving` (can't cancel mid-flight), or `not_cancellable` (with `currentStatus`) |

A `TaskSummary` is `{ taskId, origin: "mcp_commission" \| "human", status, label, goal, createdAt, updatedAt }`; `statusDetail` is the per-action list (`{ service, verb, noun, outcome: "executed" \| "denied" \| "errored" }`).

### Audit

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/audit` | — | The audit chain, paged newest first (`?userId&limit&cursor`) → `{ entries, nextCursor }`. Keyset-paginated. Chain order — oldest first — is the verification order; a verifier re-sorts or walks the pages back to front |

Each entry is the full hashed row — `{ epochId, sequenceNum, prevHash, id, timestamp, userId, agentId, sessionId, origin, service, verb, noun, toolName, parametersMetadata, decision, outcome, errorMessage, latencyMs, costUsd, decisionEntryId, hash, epochPrevHash }` — so a client recomputes the chain itself. This is what `habenula log verify` consumes; the hash construction is published in `audit-chain-format.md`.

### MCP surfaces

Two MCP transports sit alongside this REST API and are documented separately:

- `/mcp` — the inbound **commission** surface for outside agents (six verbs, read-only capability manifest, no tool surface). See `inbound-mcp.md`.
- `/internal/mcp` — the trusted internal **drive** surface for the local CLI, gated by the `INTERNAL_MCP_TOKEN` caller-token check before dispatch. See `inbound-mcp.md`.

### Dev Observability (visual model)

Gated by `VISUAL_MODEL === "true"` (fail-closed; 404 otherwise — off by
default, opt in via `.dev.vars` with `VISUAL_MODEL=true`; a hosted deploy
leaves it unset):

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/dev/model` | — | The visual model page: a live interactive graph of the DO's governed state (self-contained HTML) |
| GET | `/api/dev/model` | — | `GovernanceSnapshotResponse`: one atomic, sanitized snapshot of the DO (userId via query param) |
| GET | `/api/dev/contracts` | — | `ContractDescriptorsResponse`: every contract-bound route's query, request, and response schema as JSON Schema. A row states both input sides, so `null` means the route takes no input that way |

See [../guides/development/visual-model.md](../guides/development/visual-model.md).

## Example: an end-to-end session

A `mock_email` service is built in for a credential-free walk of the whole path — deny → connect → grant → execute → kill.

The walkthrough drives `POST /api/tools/execute`, which ships off. Set `DEBUG_MODE=true` in `.dev.vars` and restart the engine before you start. Remove it when you are done.

```bash
# 1. Try tool before setup → denied (service not connected)
curl -X POST localhost:8787/api/tools/execute \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"mock_email_list","params":{"label":"INBOX"}}'

# 2. Begin connecting the mock email service. POST /connect/{service} returns
#    { authorizeUrl, flow }; open the URL in a browser and approve — the
#    callback connects mock_email and stores its encrypted credential:
curl -X POST localhost:8787/connect/mock_email   # → { "authorizeUrl": "...", "flow": "..." }
#    open the returned authorizeUrl in a browser and approve

# 3. Mint a session grant through the confirmation flow: a chat turn that
#    calls the un-granted tool parks it → { held: { heldCallId } } …
curl -X POST localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"list my inbox"}'
#    … then approve it for the session:
curl -X POST localhost:8787/api/resolve \
  -H 'Content-Type: application/json' \
  -d '{"heldCallId":"<from step 3>","choice":"session"}'

# 4. Execute tool → allowed under the session grant, returns mock email data
curl -X POST localhost:8787/api/tools/execute \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"mock_email_list","params":{"label":"INBOX","maxResults":3}}'

# 5. Kill switch → everything denied
curl -X POST localhost:8787/api/kill \
  -H 'Content-Type: application/json' \
  -d '{}'

# 6. Tool denied again
curl -X POST localhost:8787/api/tools/execute \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"mock_email_list","params":{"label":"INBOX"}}'
```

There is no connection path that skips the credential step. `POST /connect/{service}` runs the catalog dispatch: OAuth services return an `authorizeUrl` whose callback stores the encrypted credential, and credential-less (`none`) services connect directly because they need no credential. Use the OAuth flow (step 2) for a credential-backed run.

## Not yet supported

- Account authentication — `userId` defaults to `demo-user`; the loopback rule is the trust boundary (see SECURITY.md)
- WebSocket streaming — chat is synchronous REST
- Per-verb policy modifiers: rate limits, time windows, and per-verb spend thresholds (the account-wide spending caps ship — see the Settings routes above); patterns/globs on nouns — a later release
- Per-agent permission scoping — a later release; today grants apply to the single active session
