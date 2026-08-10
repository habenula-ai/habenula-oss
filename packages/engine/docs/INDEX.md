# Document Index

**Last updated:** 2026-08-05 (agent-runtime entry tracks the in-process tool-execution rewrite; two CLI variables added to the `connect/_index.md` inventory)

This index must be updated whenever a document is added, removed, or renamed under `docs/`.

> **Repo scope.** This is the engine's public documentation. Internal-team-only material (strategy, research, planning, internal specs, decision rationale) is maintained separately and is not indexed here.

---

## Architecture

System and domain architecture. The `docs/architecture/overview.md` doc is the system-level entry point; individual files cover one domain each.

| Document | Purpose |
|----------|---------|
| [architecture/overview.md](architecture/overview.md) | System-level architecture: domain boundaries, layering, deployment paths (Miniflare / workerd / Cloudflare) |
| [architecture/agent-runtime.md](architecture/agent-runtime.md) | Worker DO lifecycle, conversation loop, in-process tool execution |
| [architecture/session-lifecycle.md](architecture/session-lifecycle.md) | Single active session in the current release: DO-owned derive/attach, start/quit/timeout/kill end paths, grant clock, CLI verbs |
| [architecture/inbound-mcp.md](architecture/inbound-mcp.md) | Inbound MCP commission surface: closed commission interface, the two enforcement points that keep the control plane out of reach, capability manifest, data-slot binding, run lifecycle, turn gate, origin provenance, loopback hardening |
| [architecture/audit-log.md](architecture/audit-log.md) | Hash-chain design, epoch boundaries, verification, and the deletion design epochs allow (retention itself is not implemented in this release) |
| [architecture/audit-chain-format.md](architecture/audit-chain-format.md) | Published audit-chain format specification for independent verifiers; test vectors in [audit-chain-vectors.json](architecture/audit-chain-vectors.json) |
| [architecture/governance.md](architecture/governance.md) | Pipeline: tool-registry mapping → permission check → spending check → audit → execute |
| [architecture/oauth-credentials.md](architecture/oauth-credentials.md) | Credential storage, AES-256-GCM encryption, rotation strategy, single-flight refresh |
| [architecture/privacy.md](architecture/privacy.md) | What this release does with data: runs on your hardware, no telemetry or transfer to Habenula, metadata-only audit by default. Names the two destinations data does reach — the services you connect and the model endpoint you configure |
| [architecture/infrastructure.md](architecture/infrastructure.md) | Cloudflare primitive mapping — what this release binds (DO + built-in SQLite) and the hosted design around it |
| [architecture/http-api-reference.md](architecture/http-api-reference.md) | The engine's loopback HTTP API: per-endpoint request/response shapes (health, connect, resolve, tools/execute, chat, session, settings, kill, dev observability) — human-readable companion to the canonical Zod contracts |
| [architecture/integrations/_index.md](architecture/integrations/_index.md) | Index of service integrations: the shipped catalog services and their docs, the catalog services that are not third-party integrations (mocks, control plane), and the planned list |
| [architecture/integrations/_template.md](architecture/integrations/_template.md) | Fill-in template for a new integration doc: tool surface and noun posture, the scope-gate decision, and the API-quirk checklist |
| [architecture/integrations/github.md](architecture/integrations/github.md) | GitHub integration: GitHub App user flow with empty scopes and no scope gate, the owner/@me listing noun, owner-routing fallback and paging cap |
| [architecture/integrations/gmail.md](architecture/integrations/gmail.md) | Gmail integration: tool surface with per-tool nouns, capability→scope map and the needs-authorization gate, API quirks |
| [architecture/integrations/google-calendar.md](architecture/integrations/google-calendar.md) | Google Calendar integration: tool surface with calendar-name and invitee-domain nouns, the binary scope gate, events.patch and RSVP quirks |
| [architecture/integrations/mocks.md](architecture/integrations/mocks.md) | Mock integrations: the mock_email (structured iteration) and mock_delivery (money-verb / spending cap) development and test fixtures |
| [architecture/integrations/outlook-mail.md](architecture/integrations/outlook-mail.md) | Outlook Mail integration: tool surface on the Graph harness, canonicalized scope map, refresh rotation, $search / 202-accept / paging quirks |
| [architecture/integrations/slack.md](architecture/integrations/slack.md) | Slack integration: user-token tool surface (channels, search, DMs) with sentinel and handle nouns, all-or-nothing scope consent, ok:false-on-200 and 3-step upload quirks |

## Security

| Document | Purpose |
|----------|---------|
| [security/threat-model.md](security/threat-model.md) | Attack surface and trust boundaries — STRIDE-style decomposition |

## Whitepapers

Consolidated public-shipping write-ups of Habenula's architecture, governance model, and security posture. Published as RFC v1.0 drafts inviting community review; pending legal review before the open-source release.

| Document | Purpose |
|----------|---------|
| [whitepapers/architecture.md](whitepapers/architecture.md) | The machine that enforces the contract: runtime and DO topology, state placement, inbound surfaces, deployment paths (local / self-host / hosted), OSS↔hosted boundary, platform constraints |
| [whitepapers/governance.md](whitepapers/governance.md) | The contract: untrusted-optimizer worldview, verb-noun calculus with mandatory noun binding, the deterministic pipeline, consent and grant lifecycle, kill semantics, separation of duties, honest limits, the control-harness category and the tool-surface antipattern |
| [whitepapers/security.md](whitepapers/security.md) | The adversary's view: the three invariants, credential custody (incl. hosted-vs-self-host key custody), audit-chain integrity, threat boundaries, kill precision, the launch gap table |

## Development Guides

How to contribute, set up, and test code in this repo.

| Document | Purpose |
|----------|---------|
| [guides/development/getting-started.md](guides/development/getting-started.md) | Setup, mise install, first build |
| [guides/development/contributing.md](guides/development/contributing.md) | How to contribute (branching, commit conventions, PR review) |
| [guides/development/visual-model.md](guides/development/visual-model.md) | Dev visual model: live interactive graph of the engine's governed state at `/dev/model` — how to run and drive it, troubleshooting, gating, snapshot contract, trust rules |

## Public Docs

User-facing OSS documentation. Sanitized derivatives of internal docs (typically architecture/ or kb material), never the source of truth.

| Document | Purpose |
|----------|---------|
| [public/product-overview.md](public/product-overview.md) | The product overview: what the personal agent control harness is, the sidecar and standalone pictures, structural properties, what Habenula is not, trust verification |
| [public/how-it-works.md](public/how-it-works.md) | How it fits together: the components (client apps, commissioning surface, planning agent, tool registry, policy engine, credential store, OAuth ingress, audit log) and the deliberate boundaries — commissioning ≠ approving, planning proposes / runtime disposes, no direct door to the gate or the tools |
| [public/roadmap.md](public/roadmap.md) | Public roadmap: the launch surface and honest limits, the later releases, and the never-on-the-roadmap commitments |
| [public/guides/cli-reference.md](public/guides/cli-reference.md) | CLI command reference |
| [public/guides/user-voice.md](public/guides/user-voice.md) | Voice: Habenula has no native voice interface; how voice reaches it indirectly, through a voice-capable commissioning agent |

## Setup

| Document | Purpose |
|----------|---------|
| `SELF-HOSTING.md` (repository root) | T-local runbook: run the engine locally as a loopback container daemon — key setup, the mock-connector governance loop, where state lives and how to back it up, the security boundary |
| [footguns.md](footguns.md) | Platform footguns: Cloudflare DO/KV/Workers behaviors and Habenula application invariants. Read before writing code against any Cloudflare primitive |

## Connecting Services

Registering the provider app behind each integration. One guide per OAuth provider, one registration per provider whatever the service count.

| Document | Purpose |
|----------|---------|
| [connect/_index.md](connect/_index.md) | Entry point: service→provider map, who registers what and where, callback paths and redirect rules, the one-way doors per provider, and the canonical inventory of every environment variable the engine and CLI read |
| [connect/google.md](connect/google.md) | Registering the Google OAuth client that authorizes the whole Google provider (Gmail, Google Calendar): Cloud Console project, per-service API enablement, consent screen, scopes, redirect URI, wiring the client ID/secret into `.dev.vars` / Wrangler |
| [connect/microsoft.md](connect/microsoft.md) | Registering the Entra ID app that authorizes the whole Microsoft provider (Outlook Mail today): app registration, account types, redirect URIs, Graph permissions, client secret, wiring into `.dev.vars` / Wrangler |
| [connect/slack.md](connect/slack.md) | Registering the Slack app and connecting it to a local engine: HTTPS tunnel + OAUTH_REDIRECT_BASE_URL_SLACK, user token scopes, mandatory token rotation, PKCE stays off, CLI connect |
| [connect/github.md](connect/github.md) | Registering the GitHub App and connecting it to a local engine: Expire-tokens setting, authorize vs. install, org install and owner approval, CLI connect |

## Reference

| Document | Purpose |
|----------|---------|
| [../README.md](../README.md) | Repo top-level intro |
| [INDEX.md](INDEX.md) | This file |
