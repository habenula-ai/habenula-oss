# Security Policy

## Current Security Posture

Habenula's current release is an early build. The architecture is designed with security as a core principle — credential isolation, encrypted storage, audit hash chains, and a governance pipeline are baked into the foundation. However, some essential security controls are not yet implemented.

### Known Limitations

**No authentication (critical).** The API trusts a client-supplied `userId` from the request body or query string, defaulting to `"demo-user"`. There is no session management, bearer tokens, or API keys. Any caller can impersonate any user. This is the highest-priority item for the next release and is prerequisite for any production deployment.

**Loopback only — never publish the engine to a network.** The supported self-host path runs the engine on your machine's loopback interface ([runbook](../../SELF-HOSTING.md)): the shipped Compose file publishes the port to `127.0.0.1` only, and the `npx @habenula-ai/engine` daemon entry binds loopback in code. That scope is what makes no-auth tenable — nothing is network-reachable. Widening it — editing the Compose `ports:` line, a manual `docker run -p`, a reverse proxy — exposes an unauthenticated engine holding credentials at rest, which is unsupported and unsafe until engine authentication ships. The widest ungated read on an exposed engine is the complete governed audit history: the audit read route returns every recorded action, so what leaks is a full behavioral record, not only a bounded status snapshot. The `LOCALHOST_ONLY` Host-header guard is defense-in-depth against cross-origin and DNS-rebinding tricks, not a substitute for the loopback publish scope: the `Host` header is spoofable and does not backstop a wide bind.

**Encryption key placeholder fails closed.** The file `packages/engine/wrangler.toml` contains a publicly known test placeholder for `CREDENTIAL_ENCRYPTION_KEY`. The engine refuses to serve under it: every route except the `GET /api/health` liveness probe returns 503 until a real key is supplied — via `.dev.vars` locally (`openssl rand -hex 32`) or `wrangler secret put` on a deploy. Real credentials are never encrypted under the placeholder.

**CORS wildcard.** `Access-Control-Allow-Origin: *` is configured for local development. Restrict to specific origins before production deployment.

**No rate limiting.** API endpoints are not throttled. Without this, cost attacks (LLM token burn) and resource exhaustion are possible.

### If something goes wrong

You run this deployment, so you are the responder. Three situations and what to do:

**An agent did something you did not intend.** Run `habenula kill` — it clears every grant to the deny-all floor, so nothing further can pass the gate. Connected services and stored credentials survive, so you resume without re-running OAuth. Then read the audit record: `habenula log` shows the newest page, and `habenula log dump <path>` writes the whole chain when you need to find something older. Expect the dump to be large — a long history can run to hundreds of megabytes, so pick a destination with room before running it mid-incident. Parameter *metadata* is recorded; content is not, so the record tells you what was called and with what shape, not what was written.

**Your host or its credential store was compromised.** Disconnect every affected service, which deletes the stored credential in the same atomic write and makes it unresolvable, then reconnect to force fresh authorization. **There is no provider-side revocation in this release on any path**, so a token that was already exfiltrated stays valid at the provider until you revoke it there — do that manually in each provider's console for anything sensitive. If the credential master key itself may have been exposed, treat every stored token as exposed even though it was encrypted, and rotate the key: supply a new one and reconnect each service, since existing rows cannot be decrypted under a new key.

**`habenula log verify` reports a broken chain (exit 3).** Treat the oldest break it names, and every entry after it, as unreliable — the verify output tells you where the damage starts and how far it runs. The chain proves integrity only within the range it covered, so read `docs/architecture/audit-chain-format.md` on what a clean verdict does and does not establish before drawing conclusions. Then work out which of three it is: a bug that wrote a malformed entry, storage corruption on the volume, or deliberate tampering — which means the host is compromised and the credential store should be treated as exposed. Exit `4`, `5` and `130` are **not** integrity failures; `docs/public/guides/cli-reference.md` says what each means.

**An agent is calling tools far faster than expected.** `habenula kill`. Rate limiting is not enforced in this release, so nothing throttles a runaway agent automatically — the kill switch is the control. Then read the session's audit entries to work out whether the trigger was your own instruction, a compromised host, or content the agent read.

### What's Done Well

- **Credential encryption:** All OAuth tokens are encrypted at rest with AES-256-GCM. Each encryption call uses a unique 12-byte IV. Decryption validates integrity via GCM authentication tag.
- **Credential isolation:** The LLM never receives raw OAuth tokens. Tokens are resolved from encrypted storage at execution time and discarded after use.
- **Governance pipeline:** Policy evaluation is a pure function with no side effects. Every tool call goes through permission checks before execution.
- **Audit log integrity:** Append-only SHA-256 hash chain with epoch linking. Entries are written atomically inside DO transactions. Tampering is detectable by verifying the chain.
- **PKCE OAuth:** Correct S256 code challenge implementation on every flow whose provider supports it prevents auth code interception; Slack's exchange is authenticated with the server-held client secret instead.
- **Dependency pinning:** All dependencies are pinned to exact versions (no `^` or `~`), with a minimum release age before updates.
- **Tests run in real Workers runtime:** No mocks of KV, DO, SQLite, or R2. Tests run inside Miniflare with real bindings.

### On security audits

There is no published audit for this release, deliberately. The engine ships unauthenticated and loopback-only, and says so at the top of this file. An audit of that posture would score the documented design as critical findings — which tells a reader nothing they cannot already read here, while implying a discovery that did not happen.

The Known Limitations above are the security posture. A third-party audit is planned for when there is authentication to audit, and it will mean something then.

---

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | :white_check_mark: |

---

## Reporting a Vulnerability

Do not open a public GitHub issue for security vulnerabilities.

Email **security@habenula.ai** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

You will get an acknowledgment within 72 hours. We ask that you give us reasonable time to address the issue before any public disclosure.

---

## What to Report

- Credential leakage — OAuth tokens appearing in logs, responses, or LLM context
- Hash chain tampering — any mechanism that could break audit log integrity
- Unexpected credential access — agents accessing services or data outside their granted permissions
- Authentication or authorization bypasses
- Supply chain vulnerabilities in pinned dependencies
- Any of the known limitations listed above if they affect your specific deployment

---

## What Not to Report

Feature requests and bug reports for non-security issues go on [GitHub Issues](https://github.com/habenula-ai/habenula-oss/issues).
