# Privacy Architecture

## What this release is, and why that decides most of it

This release runs entirely on your own hardware: a container on a Docker host you control. There is no Habenula-operated service in the path, and **the shipped code contains no Habenula endpoint** — no telemetry, no usage reporting, no crash reporting, no update check, no phone-home of any kind. That is checkable rather than asserted: grep the source for outbound hosts. What you will find is the services you connect and the model endpoint you configure. Nothing reports anywhere.

So the strongest privacy property here is structural, not cryptographic. Habenula the company does not receive your conversations, your audit log, or your content, because there is nowhere for them to go.

**Data does leave your machine — to parties you chose.** Two destinations, both deliberate:

- **The services you connect.** Gmail, Google Calendar, Outlook Mail, Slack and GitHub receive exactly the requests the agent makes, under the credential you authorized. That is the product doing its job.
- **The model endpoint you configure.** Conversation content goes to whichever provider you point the engine at. If that is a hosted model API, your content reaches that vendor under their terms, not ours. Running a local model keeps it on your machine.

Nothing in this document promises anything about what a *hosted* Habenula service would do with your data. Later releases add hybrid and fully-hosted options, and the data-use commitments that go with them are made when those exist — not here, and not by implication from this page.

## Where the network boundary actually is

Worth stating precisely, because the two run paths differ and only one is protected by the process itself.

- **The container** binds all interfaces — `startDaemon("0.0.0.0", "/data")` in `src/daemon/container.ts`. A published port requires it. What keeps the engine off your network is the **Compose publish scope**, `127.0.0.1:${HABENULA_PORT:-8787}:8787` in the shipped `compose.yaml`. Widen that — edit the `ports:` line, or run your own `docker run -p 8787:8787` — and you expose an unauthenticated engine holding credentials at rest. The engine will not stop you.
- **The host-run path** (the engine daemon running directly on the host rather than in the container) binds loopback in code: `startDaemon("127.0.0.1", …)` in `src/daemon/index.ts`.

The `LOCALHOST_ONLY` Host-header check is defence-in-depth against cross-origin and DNS-rebinding tricks. The `Host` header is client-supplied, so it does not backstop a wide bind.

## Principles

- Metadata-only governance by default — content is never required for a safety decision.
- Content flows through the runtime for execution because it must, and is not written to the audit log.
- No data is transmitted to Habenula.

## What is stored, and where

Everything below lives in the Durable Object SQLite that Miniflare persists to disk on your machine — `/data` in the container, `~/.habenula` on the host-run path. **Exactly one column is encrypted.** Everything else is plaintext in that volume, so its protection is the file permissions and disk encryption of the machine, not cryptography inside the product.

| Data | At rest | Notes |
|---|---|---|
| OAuth credentials | **AES-256-GCM** — `connected_services.credential` | The only encrypted column. The engine must decrypt to use the token; the master key comes from the environment at run time and is never written into an image layer. The model never sees it — it holds a session reference resolved at execution time |
| Audit log (metadata) | Plaintext | Timestamps, service, verb, noun, tool name, decision, outcome, latency, cost. No content |
| Audit log (content) | Not stored at all | `parameters_content` exists and is **always null in this release**; there is no path that writes it |
| Held tool calls | Plaintext — `held_tool_calls.turn_state` | **The largest content store in the product.** When a call is held for confirmation, this row keeps the conversation up to that turn *and* the held call's real parameters — an email's recipients and body, for instance — so the turn can resume after eviction |
| Commission runs | Plaintext — `commission_runs.goal`, `.data` | The goal text an outside agent commissioned, and its payload |
| Policy, spending ledger, sessions, OAuth state, settings | Plaintext | `policy_entries`, `spend_ledger`, `session_state`, `oauth_state`, `user_settings` |

Live conversation state outside a hold is an in-memory field on the Durable Object (`conversationMessages`), not a table. It does not survive eviction, which is why a held turn is written down.

**On the credential trade-off.** The engine holds a decryptable credential because it has to use it to make the call. That makes the deployment a trusted party for credential access — and in this release the deployment is yours. What the model never sees is the credential itself: it holds a session reference, and the token is resolved at execution time and discarded.

## Metadata-only default

The governance pipeline operates entirely on metadata:

```
✓ timestamp           ✓ tool_name           ✓ service
✓ parameter shapes    ✓ byte sizes          ✓ call frequency
✓ cost                ✓ outcome             ✗ content values
```

The integration docs that exist — Gmail, Google Calendar, Outlook Mail — state the same boundary per service: message bodies and event contents flow through for execution and never enter the audit log. Slack and GitHub have no integration doc yet.

## Retention

Retention is not implemented in this release: nothing deletes an audit entry, and the log grows until you intervene. The chain is built in whole daily epochs so that a future retention release can remove a day's entries and leave the remaining chain verifiable — the structure ships; the deletion does not. Export what you want to keep with `habenula log dump`.

## Content inspection (later)

Inspecting content against user-defined rules — "flag if the agent is about to send an email mentioning salary" — is a direction, not a feature of this release. Nothing about where such inspection would run, or what it would emit, is settled, and this page will not describe a design that does not exist.

## Voice (later)

Native voice is not part of this release: no pipeline, provider, or on-device path is committed. When it is designed, the handling model starts from the same place as everything else here — minimize what is captured, prefer transcripts over audio, and gate any biometric step behind explicit consent. Specifics are settled with that work.
