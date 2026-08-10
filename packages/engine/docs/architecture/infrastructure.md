# Infrastructure

## Cloudflare (Core Platform)

All core platform logic runs on Cloudflare.

In this release the engine binds exactly one platform primitive: the per-user Durable Object and its built-in SQLite (`packages/engine/wrangler.toml` binds no KV namespace and no R2 bucket). The KV and R2 rows below are the hosted deployment design, not running code.

| Service | Use | Key Constraint |
|---------|-----|---------------|
| Workers | API routing, permission eval, tool execution | 30s CPU time limit (paid); no persistent in-process state |
| Durable Objects | Per-user agent sessions, pending confirmations, **built-in SQLite** (audit chain, permission state, spending windows over the spend ledger, encrypted OAuth credentials) | Code deploys disconnect all WebSockets; in-memory state lost on hibernation; 10GB SQLite per DO (paid) |
| KV | Hosted design — session cache (read-heavy, staleness-tolerant); not bound in this release | Eventual consistency (up to 60s); 1 write/sec/key; no read-your-own-writes guarantee. Not on the credential path — encrypted OAuth credentials live in DO SQLite |
| R2 | Hosted design — conversation history, app assets; not bound in this release | S3-compatible; no egress fees |
| Agents SDK (`agents` npm) | `Agent` base class — the UserAgent DO extends it | Pre-1.0 — exact version pinned in `packages/engine/package.json`. The engine uses only the base class: the inbound MCP surfaces (commission + internal drive) are hosted with `@modelcontextprotocol/sdk`, and OAuth flows are Habenula-authored provider strategies in `@habenula-ai/tools` |


## Deployment Notes

- **Self-hosting ships today.** The container and host-run paths run the same wrangler-bundled Worker under Miniflare on your own machine — see the deployment table in [overview.md](overview.md) and the [self-host runbook](../../../../SELF-HOSTING.md). Running the engine on your own Cloudflare account is planned.
- **DO code deploys disconnect WebSockets** (a hosted-design consideration). Deploying a new Worker version terminates every active WebSocket connection, so clients must reconnect with exponential backoff. See [footguns.md](../footguns.md).
