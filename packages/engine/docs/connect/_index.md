# Connecting Services

Start here before you follow any per-service guide.

Habenula reaches a third-party service with an OAuth credential that **you** authorize. You register your own app with the provider. You put its client ID and secret into the engine's configuration. Then you run `npx habenula connect <service>`. Consent happens in your browser. The engine exchanges the authorization code server-side and stores the tokens AES-256-GCM-encrypted in your per-user Durable Object. The LLM and the CLI never see a raw token.

Two things surprise people, so they are stated up front:

- **You register the app, not Habenula.** Every operator of a Habenula engine creates their own provider app. There is no shared client to borrow.
- **Connecting is not a permission grant.** A connected service gives the engine a credential and nothing more. The first time an agent calls one of that service's tools, the governance pipeline holds the call and asks you. That confirmation is where scope is granted. See [`../architecture/governance.md`](../architecture/governance.md).

## One registration per provider, not per service

A **provider** is the identity system you register with. A **service** is the tool surface an agent calls. One registration authorizes every service on its provider, so the setup is done once even when you connect two services.

| Service | Provider | Guide |
|---------|----------|-------|
| `gmail` | Google | [`google.md`](google.md) |
| `google_calendar` | Google | [`google.md`](google.md) |
| `outlook_mail` | Microsoft | [`microsoft.md`](microsoft.md) |
| `slack` | Slack | [`slack.md`](slack.md) |
| `github` | GitHub | [`github.md`](github.md) |
| `mock_email` | mock | none needed — see below |
| `mock_delivery` | mock | none needed — see below |

`mock_email` and `mock_delivery` are the built-in test connectors. Each mints its own credential, so `npx habenula connect <name>` needs no registration, no console, and no provider credentials. Use `mock_email` to exercise the governance loop before you register anything real. Use `mock_delivery` to exercise the spending cap — it is a sandbox paid service, with no real merchant and no real money. The `habenula` control-plane service needs no connection at all; its tools operate your own engine.

## Who registers what

| Provider | Where you register | One registration covers | Console |
|----------|--------------------|-------------------------|---------|
| Google | A project in the Google Cloud Console. One OAuth client per deployment. | Every Google service. Each service also needs its own API enabled and its scopes added to the consent screen. | [console.cloud.google.com](https://console.cloud.google.com) |
| Microsoft | An app registration in the Microsoft Entra admin center. Any tenant you can register apps in. | Every Microsoft service. Each service also needs its own Graph permissions added. | [entra.microsoft.com](https://entra.microsoft.com) |
| Slack | An app in a Slack workspace you control. Each operator creates their own. | Every Slack service, in that workspace. | [api.slack.com/apps](https://api.slack.com/apps) |
| GitHub | A GitHub App under your account or organization. | Every GitHub service. Repository reach also depends on where the App is installed. | [github.com/settings/apps](https://github.com/settings/apps) |

## Redirect rules

The engine serves one callback path per provider. Register that path on every origin the engine answers on.

| Provider | Callback path | Accepts `http://localhost`? | Tunnel needed for a local engine? |
|----------|---------------|------------------------------|-----------------------------------|
| Google | `/callback/google` | yes | no |
| Microsoft | `/callback/microsoft` | yes, on a **Web** platform | no |
| Slack | `/callback/slack` | **no** | **yes** — a public HTTPS tunnel |
| GitHub | `/callback/github` | yes | no |
| mock | `/callback/mock` | yes | no |

Every provider matches the redirect byte for byte. Scheme, host, port, and path must all agree with what you registered.

The origin to register is the one `npx habenula up` reported, not an assumed `http://localhost:8787`. If the default port is busy on the first run, the engine starts one port over — and that port is a different origin. `npx habenula up` prints the origin whenever it is not the default.

The engine builds the redirect from a base origin, resolved most-specific-first:

1. `OAUTH_REDIRECT_BASE_URL_<PROVIDER>` — scoped to one provider.
2. `OAUTH_REDIRECT_BASE_URL` — applies to every provider.
3. The incoming request URL.

`<PROVIDER>` is the **provider** id, uppercased: `GOOGLE`, `MICROSOFT`, `SLACK`, `GITHUB`. It is not the service name you type. So Gmail's override is `OAUTH_REDIRECT_BASE_URL_GOOGLE`; an `OAUTH_REDIRECT_BASE_URL_GMAIL` is silently ignored.

Prefer the per-provider form. The global form moves every provider's redirect at once. Setting it to tunnel Slack also moves Google off `http://localhost` and forces a needless re-registration in the Google console.

Set the base to an **origin only** (scheme and host). The engine appends the callback path itself.

## One-way doors and traps

Read the row for your provider before you start. Each of these has a cost you cannot undo, or wastes an hour if you miss it.

| Provider | What to watch |
|----------|---------------|
| Google | A Testing-mode app caps at 100 test users, and its refresh tokens expire after 7 days. Publishing to general availability needs Google verification, including an annual security assessment. Enabling a service's API is separate from consent: if you skip the enable, the connect still succeeds and the first tool call fails. |
| Microsoft | The client secret's **Value** is shown once. Copy it immediately. The secret also expires on the date you chose, and an expired secret fails every exchange and refresh. Supported account types must match the `common` endpoint the engine authorizes against, so a narrower choice rejects the accounts that endpoint invites. |
| Slack | **Token rotation is mandatory and cannot be turned off once enabled.** The engine rejects a non-rotating token, so you must opt in. Leave the PKCE opt-in **off**: the flow sends no `code_verifier`, and opting in breaks the token exchange. Redirect URLs need the separate **Save URLs** click. A quick-tunnel hostname changes on every restart. |
| GitHub | **Expire user authorization tokens must be enabled.** With it off, GitHub issues a non-refreshable token and the exchange fails by design. Authorizing is not installing: repositories stay invisible until you also install the App and select them. A modern Client ID already carries its `Iv23li` prefix — never prepend `Iv1.`. |

## Environment variable inventory

Every value below goes in one place per run path:

- **`wrangler dev`** reads `packages/engine/.dev.vars`. Start from [`.dev.vars.example`](../../.dev.vars.example).
- **The container** reads `.env` beside `compose.yaml` at the repository root. Start from [`.env.example`](../../.env.example).
- **A host-run engine started by `npx habenula up`** reads `~/.habenula/config` (moved by `HABENULA_PERSIST_ROOT`, named outright by `HABENULA_CONFIG`). `npx habenula up` forwards every variable in that file to the engine, so `ANTHROPIC_API_KEY` and the provider client credentials may live there instead of the shell.
- **A Cloudflare-account deployment** (a planned path — the shipping self-host is the container in [`SELF-HOSTING.md`](../../../../SELF-HOSTING.md)) sets these as Wrangler secrets.

Every engine variable is read at startup. Restart the engine after any change.

Names marked **secret** must never appear in `wrangler.toml`'s `[vars]` block. A `[vars]` entry deploys as plain text and overwrites a same-named secret on every deploy.

### Core

| Variable | Purpose | Required | Secret |
|----------|---------|----------|--------|
| `CREDENTIAL_ENCRYPTION_KEY` | 256-bit AES key encrypting every stored credential. 64 hex characters, from `openssl rand -hex 32`. The engine fails closed on a missing, malformed, or placeholder key. | yes | yes |
| `INTERNAL_MCP_TOKEN` | Caller token for the trusted internal drive interface. The CLI's conversation and its `status` verb both use it, so the CLI does not work without it. An unset token fails closed. The CLI must send the same value as `HABENULA_INTERNAL_MCP_TOKEN`. | for the CLI | yes |
| `ANTHROPIC_API_KEY` | Key for the default LLM provider. The governance loop over `mock_email` needs no key. | for conversation | yes |
| `LOCALHOST_ONLY` | Loopback guard. For any value except `false`, the engine rejects a non-loopback `Host`. When a callback arrives through a tunnel or a public origin, set it to `false` — and note the engine ships no authentication: loopback is the trust boundary, so widen it only for a private tunnel. | no | no |

### LLM provider

Leave these unset to use Anthropic.

| Variable | Purpose | Required | Secret |
|----------|---------|----------|--------|
| `LLM_PROVIDER` | `anthropic` (default) or `openai-compatible`. | no | no |
| `LLM_ENDPOINT` | Base URL for an OpenAI-compatible backend. The engine appends `/chat/completions`. From inside the container, a runtime on your host is `http://host.docker.internal:<port>/v1`, never `localhost`. | with `openai-compatible` | no |
| `LLM_MODEL` | Model id. | with `openai-compatible` | no |
| `LLM_API_KEY` | Key for the selected provider, if it needs one. Leave it unset for a keyless local runtime. For Anthropic, `ANTHROPIC_API_KEY` takes precedence, and a present-but-empty `ANTHROPIC_API_KEY=` line still counts as set. Comment that line out to fall back to this one. | no | yes |

### OAuth client credentials

Set only the pairs for the providers you connect. Each pair comes from that provider's console; the per-service guide says which field is which.

| Variable | Provider | Required | Secret |
|----------|----------|----------|--------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google | to connect a Google service | yes |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft | to connect a Microsoft service | yes |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack | to connect Slack | yes |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub | to connect GitHub | yes |

### Redirect overrides

| Variable | Purpose | Required | Secret |
|----------|---------|----------|--------|
| `OAUTH_REDIRECT_BASE_URL_<PROVIDER>` | Stable public origin for one provider's redirect. Preferred form. One of `_GOOGLE`, `_MICROSOFT`, `_SLACK`, `_GITHUB`. | for Slack on a local engine | no |
| `OAUTH_REDIRECT_BASE_URL` | Stable public origin for every provider's redirect. `npx habenula up` records `http://localhost:<recorded port>` here on the run that establishes the port, so the origin is a recorded fact rather than whatever host each client used. The per-provider form above still wins, so a tunnel override is unaffected. | no | no |

### Development options

| Variable | Purpose | Required | Secret |
|----------|---------|----------|--------|
| `VISUAL_MODEL` | Set to exactly `true` to serve the live state graph at `/dev/model`. Any other value leaves it a 404. See [`../guides/development/visual-model.md`](../guides/development/visual-model.md). | no | no |
| `DEBUG_MODE` | Set to exactly `true` to serve `POST /api/tools/execute`, which drives one governed tool call with no conversation behind it. Any other value leaves it a 404. A debugging surface, never an intended feature; leave it off unless you are inspecting the governance pipeline by hand. See [`../architecture/http-api-reference.md`](../architecture/http-api-reference.md). | no | no |
| `HABENULA_PORT` | Port the engine listens on. Default `8787`. On the container run path it moves the host port published on `127.0.0.1`, and the port inside the container stays `8787`. A different port is a different origin, so register the new redirect with every provider first. See [Redirect rules](#redirect-rules). | no | no |
| `HABENULA_PERSIST_ROOT` | Directory the Durable Object writes its SQLite state to. Host runs default to `~/.habenula`; the container image sets it to `/data`, the mount point of the named volume. Leave it alone unless you are relocating that state. | no | no |

### CLI variables

These belong in the shell that runs the CLI, not in the engine's configuration.

| Variable | Purpose | Default |
|----------|---------|---------|
| `HABENULA_API_URL` | Engine origin the CLI talks to. | `http://localhost:8787` |
| `HABENULA_INTERNAL_MCP_TOKEN` | Must match the engine's `INTERNAL_MCP_TOKEN`. Not needed against a local engine started by `npx habenula up`: the CLI reads the token from the config file, and only for that engine. | unset — the config file supplies it for the local engine; otherwise the internal interface rejects the caller |
| `HABENULA_INTERNAL_MCP_URL` | Full URL of the internal MCP interface, path included — the value is used verbatim, so an origin without `/internal/mcp` silently misses the interface. Environment-only: a line naming it inside the config file is refused. | unset — derived from `HABENULA_API_URL` |
| `HABENULA_USER_ID` | Routing key the credential is stored under. | `cli-user` |
| `HABENULA_CONFIG` | Path of the shared config file `npx habenula up` writes and every command reads. Environment-only: a line naming it inside the file is refused. | `<persist root>/config` |
| `HABENULA_ENGINE_CMD` | Explicit engine command line for `npx habenula up` — the override a contributor points at a local build. Split on whitespace and run without a shell. | unset — `habenula-engine` on `PATH`, then npx |
| `HABENULA_PLAIN_INPUT` | Any non-empty value forces the plain line reader instead of the interactive editor. A piped or non-interactive session uses the plain reader anyway. | unset |
| `HABENULA_HUMAN_TOUCH` | Turns on the Human Touch presence gate: a macOS Touch ID check runs immediately before the CLI sends an approval for a held call. Value-based, not presence-based — `1`, `true`, `yes`, or `on` (any case) enables it; any other value fails safe to off. Read from the environment first, then the config file; a blank environment value falls through to the file, and an explicit `off` wins. The Touch ID helper ships only in a source checkout; in the packaged CLI the gate withholds approvals and says so. | unset — off |
| `HABENULA_NO_BANNER` | Set to any value, even empty, to suppress the startup banner — the check is on presence, not content. A non-TTY session never draws the banner. A terminal narrower than the banner prints a one-line wordmark instead. | unset |
| `NO_COLOR` | Any non-empty value strips color from every command. State words and glyphs still carry the meaning. | unset |

The CLI also reads `TERM` and `COLORTERM` to pick a color depth. Neither is a Habenula setting; set them only if your terminal reports itself wrongly.

## Adding an integration

Contributors adding a service: the checklist for landing a guide and a row in these tables is in [`../guides/development/contributing.md`](../guides/development/contributing.md#adding-a-service-setup-guide).
