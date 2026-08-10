# Public Roadmap

Where Habenula is, and where it's going. Releases are sequenced, not dated — each entry lists what it contains and roughly how it follows from the one before. We keep "shipped" and "planned" strictly separated; anything not marked shipped should be read as intent, not commitment.

This roadmap covers the open-source runtime and its surfaces. Pricing and hosted-service details live on [habenula.ai](https://habenula.ai).

## Public release: the developer sidecar *(you are here)*

The runtime is open, and the core trust claims are real code you can run and test — not a demo of a future architecture.

**Shipped in this release:**

- The governed runtime on Cloudflare Workers + Durable Objects: every tool call classified to `(service, verb, noun)` and evaluated by a deterministic policy engine, deny-by-default
- **Model-agnostic:** run any model behind the agent. Anthropic works out of the box; so does any provider speaking the OpenAI inference API — OpenAI, Google, open-weight hosts, and local models via Ollama. Governance holds identically, because the gate judges the action, not the model that proposed it
- Credential custody: OAuth handled by Habenula, tokens AES-256-GCM encrypted in your own per-user database, never visible to the model
- Append-only, hash-chained audit log written before execution, with per-entry origin tagging (human vs. commissioned)
- **Check the chain yourself:** `habenula log` reads the newest entries. `log dump` writes the complete chain to a file. `log verify` recomputes every hash on your own machine, against the live engine or a dump file, with a distinct exit code for a broken chain. Verification is client-side by design; the runtime never asserts its own integrity. The chain format is published with test vectors, so an independent implementation needs nothing of ours
- Confirmation flow: un-granted actions are held, you decide with scoped choices ("for this task" / "for this session"); no permanent grants exist — the strongest grant dies with the session
- Kill switch: one command clears every grant to the deny-all floor and sweeps pending work. Connections survive, so recovery needs no re-auth. Nothing can act: the deny floor matches everything and no grant remains
- **Human Touch (opt-in):** on macOS, a Touch ID check in front of affirmative approvals in the CLI
- **Inbound commission surface:** an MCP endpoint your coding agent (Cursor, Claude Code, custom) can hand goals to — commission, status and result, plus supply/correct/cancel on your own run — and nothing else; no tool surface, no approve verb
- Interactive CLI: chat, connect services, review and resolve held actions, status, kill
- Integrations: Gmail, Google Calendar, Outlook Mail, Slack, and GitHub, plus a built-in mock email service so you can exercise the whole loop with zero real credentials
- **Run it yourself:** the launch release ships two ways — a `workerd`-plus-CLI container on any Docker host, or the packages on npm (`npx @habenula-ai/engine` runs the engine on loopback) — to run and explore the whole product.
  - The credential master key lives in Habenula's own secret store, running on your machine, so the company never sees it. A bring-your-own at-rest secret store is a fast-follow.
  - It is single-node: a hosted service's global edge and hibernation economics are not reproduced.
  - It runs `workerd`, Cloudflare's open-source runtime. At runtime it stays independent of Cloudflare the company — not free of Cloudflare-authored code, and we won't blur that line.
  - Self-hosting on your own Cloudflare account is what ships next; a hosted option and multi-node scale follow, all on the same code
- Tests run in the real Workers runtime — no mocked platform primitives

**Honest limits of this release** — each is a scheduled fix, listed below where it lands:

- One active session at a time.
- The local API is unauthenticated; loopback-only exposure is the boundary.
- Policy is granted per user session, not per named agent.
- Audit-log query filters are not yet in the CLI: `habenula log` shows the newest page; reach older entries with `log dump`.

## Next: power-user feature-complete

The full multi-agent platform for technical users.

- **Multi-agent:** the coordinator/worker split — one kernel per user (audit, policy, kill, counters), one isolated process per agent; per-agent policy scoping and per-agent kill
- Account creation and authentication, replacing the single-user development mode
- Audit-log query filters for `habenula log`: time, agent, service, and action. The commands themselves ship at launch; the filters are the remaining gap
- Hosted tier (bring-your-own-key), and a production hardening guide for the self-host container (TLS/ingress, OAuth redirect setup, backups, upgrades)
- **The custody spec** — the criteria this runtime is built to (credential isolation, user-verifiable audit, a real kill, scoped mortal grants) formalized as an open, community-RFC'd public standard, with an open test runner. Announced now so the intent is on the record; published when this runtime passes every criterion it states — a standard whose author doesn't clear it isn't one
- Web search integration. Hardening pass: rate limiting, input validation, and per-service and per-transaction spend caps on top of the account-wide caps that ship at launch

## Soon after: mobile companion

A deliberately minimal phone app for agents that run while you're away from your machine: push notifications for pending approvals, approve/deny with scope choice, the kill switch, and a recent-activity view. Not a chat app — the IDE-sidecar approval surface remains the CLI, because that's where you are.

## The consumer release

The same runtime, past the command line — the same governance in more of the flows people live in, whether or not they work from an editor.

- Full mobile app and management web dashboard: plain-language permissions, audit browser, connected services, kill switch
- Voice
- **Plan-level governance:** multi-step tasks compile to a structured plan you approve once, carrying declared limits the runtime holds the agent to, instead of a stream of per-call prompts
- Confirmation-as-onboarding for non-technical users; heartbeat timeouts so unattended agents wind down instead of running forever
- Hardware-key (WebAuthn) approval for the highest-stakes actions — approval signatures bound to the exact action, so not even Habenula can substitute what you approved
- Managed model access (no API keys needed), activity digests, and a wider integration set: Drive, messaging (Telegram, WhatsApp), sandboxed files, headless browser

## Later: the trust ecosystem

- **Habenula Store:** curated, Habenula-vetted agents
- Inter-agent delegation under governance: agents propose sub-agent scopes, you approve them, provenance is recorded end to end
- Third-party security audit of the runtime, published in full

## What will never be on this roadmap

- **A public tool surface.** Habenula will not expose its integrations as MCP tools for outside agent loops to drive piecemeal. Outside agents commission goals; the governed runtime does the work; humans approve on Habenula surfaces. This is an architectural commitment, not a deferral.
- **Paywalled control.** Features that make Habenula's trust claims verifiable — the audit chain, verification, the kill switch, the policy engine — stay free and open. Paid tiers gate capacity and convenience, never control.
