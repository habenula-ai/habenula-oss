# Habenula

**The personal agent control harness**

[![TypeScript](https://img.shields.io/badge/types-strict-blue)]()
[![License](https://img.shields.io/badge/license-AGPL%20v3-red.svg)](LICENSE)

The model does the thinking; Habenula governs the *doing*. This is the `@habenula-ai/engine` package — the agent runtime at the core of Habenula: the tool-execution pipeline, the governance gate, credential custody, and the hash-chained audit log. When an agent reaches for a consequential action, it passes through the engine first: classified, checked against your rules, recorded, and executed only with authority you granted.

Run it as a **sidecar** to a coding agent like Cursor or Claude Code, or **standalone** as its own governed agent. For the full product story, see the [product overview](docs/public/product-overview.md).

**Current status:** early alpha, first public release. The agent runtime, governance pipeline, CLI, and five service integrations are functional. One agent runs in one session at a time. Authentication is not yet implemented (see [SECURITY.md](SECURITY.md)).

## What is Habenula?

Habenula is a control harness for AI agents: the model proposes an action, and a deterministic gate you can read decides whether it happens. Permissions, audit logs, spending controls, confirmations, and the kill switch are application logic — the runtime itself — not middleware bolted in front of a model. It assumes any model can be wrong or manipulated, and gives you the controls to stay responsible for your agents rather than guaranteeing safety on your behalf.

## Key Features

- **Accountable agents** — `(service, verb, noun)` permission model; no bare verb grants
- **Credential isolation** — the LLM never sees a raw OAuth token
- **Audit log** — append-only with SHA-256 hash chain (`habenula log verify` recomputes it locally)
- **Kill switch** — `habenula kill` sets a global deny, typically in tens of milliseconds
- **MCP surfaces** — external agents commission work over the Model Context Protocol, and the CLI drives the agent over a trusted local MCP interface
- **Real credential encryption** — AES-256-GCM with per-call random IVs
- **First-party OAuth** — mock, Google, Microsoft, Slack, and GitHub flows implemented; PKCE (S256) wherever the provider supports it

## Quick Start

Run the engine as a local loopback container — the packaged self-host path.
The full walkthrough is the [self-host runbook](../../SELF-HOSTING.md).

```bash
# Prerequisites: Docker (Compose v2); node, npm, just via mise (.mise.toml)
# All commands run from the repo root. The guard keeps an existing .env safe.
[ -f .env ] || cat > .env <<EOF
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_MCP_TOKEN=$(openssl rand -hex 16)
EOF
docker compose up -d --build
curl http://127.0.0.1:8787/api/health
```

In another terminal, talk to it with the CLI (from the repo root):

```bash
mise install && npm ci      # once — this also builds the habenula command
export HABENULA_INTERNAL_MCP_TOKEN=$(grep '^INTERNAL_MCP_TOKEN=' .env | tail -1 | cut -d= -f2)
npx habenula status
npx habenula connect mock_email
```

> **Loopback only — no authentication.** The engine ships without auth; the
> Compose file publishes the port to `127.0.0.1` only. Publishing it to a
> network exposes an unauthenticated engine holding credentials at rest.
> See [SECURITY.md](SECURITY.md).

For engine development, the `wrangler dev` loop remains. The engine fails
closed without a real encryption key (every route except `/api/health`
returns 503 under the shipped placeholder), so create a `.dev.vars` first —
`just setup` at the repo root scaffolds it with generated local secrets, or by
hand:
```bash
cd packages/engine
cp .dev.vars.example .dev.vars
# then set CREDENTIAL_ENCRYPTION_KEY in .dev.vars to the output of:
openssl rand -hex 32
npx wrangler dev
```

Run the tests:
```bash
just engine-test    # engine suite (Workers runtime via Miniflare)
just cli-test       # CLI suite (Node)
```

## Run on the Host (Node, No Container)

The engine daemon also runs directly on the host, from the compiled output.
It is the same daemon the container runs, on the same loopback-only terms.

Requirements:

- Node 22.22.1 or newer. The package `engines` field states this floor. npm
  enforces it only when your project sets `engine-strict`.
- A glibc system: Linux (glibc) or macOS. The embedded Workers runtime
  (workerd) ships no musl binary, so musl-based hosts such as Alpine are not
  supported.

From npm, no checkout needed (repeat any time):

```bash
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32) npx @habenula-ai/engine
```

Or from this repository — build once, then start the daemon. Both commands
run from `packages/engine/`:

```bash
npm run build
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32) node dist/daemon/index.js
```

The daemon prints one line when it is ready:
`habenula-engine ready at http://127.0.0.1:8787/`.

### Environment

Set these in the daemon's environment. There is no config file on the host path.

| Variable | Required | Purpose |
|---|---|---|
| `CREDENTIAL_ENCRYPTION_KEY` | yes | 64 hex characters (a 256-bit key). Generate with `openssl rand -hex 32`. The engine fails closed without a real key: the daemon refuses to start, and a running engine returns 503 on every route except `/api/health`. Losing the key makes stored service credentials unrecoverable. |
| `ANTHROPIC_API_KEY` | for agent turns | Credential for the default LLM provider. |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_ENDPOINT`, `LLM_API_KEY` | no | Point the engine at an OpenAI-compatible backend instead of the Anthropic default. `LLM_API_KEY` is a credential; omit it for keyless local runtimes. |
| `INTERNAL_MCP_TOKEN` | for the CLI conversation | Shared-secret caller token for the trusted `/internal/mcp` surface. Unset fails closed: that surface answers 401. The CLI sends the same value as `HABENULA_INTERNAL_MCP_TOKEN`. |
| `HABENULA_PORT` | no | Listen port. Default 8787. |
| `HABENULA_PERSIST_ROOT` | no | Where engine state lives. Default `~/.habenula`. |
| `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET` | per connect | OAuth app credentials for real service connects (Google, Slack, GitHub, Microsoft). See [docs/connect/](docs/connect/_index.md). |

### Where State Lives

Engine state — the audit chain, connected services, and their encrypted
credentials — persists under one directory: `~/.habenula` by default,
`HABENULA_PERSIST_ROOT` when set. The container image sets it to `/data`.
To back up, stop the daemon and copy that directory.

### Deploying the Shipped wrangler.toml

The package ships its `wrangler.toml` with `name = "habenula"`. If you deploy
it to your own Cloudflare account, the Worker deploys under that name and
replaces any existing Worker named `habenula`. Rename it before you deploy.

## Security Posture

This is an early release. Key security limitations are transparently documented:

- **Authentication:** Not yet implemented. The API trusts a client-supplied `userId`. See [SECURITY.md](SECURITY.md) for details.
- **Encryption:** OAuth tokens are encrypted with AES-256-GCM. The encryption key must be set via `wrangler secret put` in production.
- **CORS:** Configured with wildcard origin for local development — restrict before production deployment.

Security posture, in full: [SECURITY.md](SECURITY.md)

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **LLM:** Anthropic Claude by default; model-agnostic (any OpenAI-compatible endpoint, including a local one)
- **MCP:** 2025-11-25 spec — the inbound servers are built with the official MCP TypeScript SDK and served via the Agents SDK
- **Storage:** Durable Object built-in SQLite (the only bound store)
- **CLI:** Node + Commander.js (bundled to `dist/` via esbuild)

## Package Structure

This is the `@habenula-ai/engine` package. Inside:

```
src/          Engine source: governance pipeline, audit log, OAuth, MCP surfaces, agent runtime
test/         Test suite (runs in a real Workers runtime via Miniflare)
docs/         Documentation (see docs/INDEX.md)
wrangler.toml Cloudflare Worker config
package.json  Dependencies + scripts
```

The engine ships alongside seven sibling packages — [`@habenula-ai/cli`](../cli), contracts, tools, credentials, governance, audit, and the unscoped `habenula` front door — as the OSS surface of the broader Habenula monorepo.

## Documentation

**See [`docs/INDEX.md`](docs/INDEX.md)** for the full list of every doc with a one-line purpose, grouped by section. Common entry points:

- [`docs/public/`](docs/public/) — user-facing documentation (product overview, how it works, roadmap, CLI reference, voice)
- [`docs/architecture/`](docs/architecture/) — technical architecture overview
- [`docs/guides/development/getting-started.md`](docs/guides/development/getting-started.md) — development setup guide

## License

Open source under **AGPL v3** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for
details. The worker bundle inlines `@habenula-ai/audit`, which is MIT so that a
log can be verified by a party independent of the one that wrote it;
[NOTICE](NOTICE) reproduces its terms.

```
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
```

## Contact

- **Inquiries:** hello@habenula.ai
- **Security:** security@habenula.ai (see [SECURITY.md](SECURITY.md) for reporting)
