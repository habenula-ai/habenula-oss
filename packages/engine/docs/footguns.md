# Platform Footguns

Known platform behaviors that will surprise you if you're not expecting them. These are not bugs — they are documented Cloudflare (and related) behaviors that require explicit handling.

Read this before writing any code against these primitives.

---

## Cloudflare Durable Objects

### Code deploys disconnect all active WebSockets

**Behavior:** Deploying a new version of a Worker that uses Durable Objects causes all active WebSocket connections to be terminated. Users in the middle of a conversation will be disconnected.

**Required handling:**
- Clients must implement reconnection with exponential backoff
- The DO must serialize enough state to DO SQLite that reconnection restores the session cleanly
- Prefer deploys during low-traffic periods; monitor Cloudflare's connection-draining feature as it matures

### In-memory state is not reliable across hibernation

**Behavior:** A Durable Object hibernates when it has no active connections and no pending alarms. Any state stored only in JavaScript variables is lost on hibernation. The DO resumes from a clean start on the next activation.

**Required handling:**
- All persistent state (conversation history, pending confirmations, permission state, active tool connections) must be written to DO SQLite before the DO can hibernate
- The DO's built-in SQLite is the only bound store in this release — structured queryable data (audit log, permissions, counters) and held conversation state all live there
- Never assume in-memory state persists across a request boundary

### DO upgrade behavior during active sessions

**Behavior:** When a DO migrates to a new code version (triggered lazily, not immediately on deploy), any in-flight WebSocket connections handled by the old code are not automatically migrated. The old DO instance continues running until all its connections close.

**Implication:** During a rolling upgrade, some users may be on old code and some on new code simultaneously. The application must be designed for this — avoid state format changes between versions that would break cross-version compatibility.

---

## Habenula Application Code

### Hash chain field encoding must stay unambiguous

**Behavior:** The audit log hash input encodes each field length-prefixed as `<len>:<value>` (`len` in UTF-8 bytes) and concatenates the frames (`frameField` / `computeEntryHash` in `@habenula-ai/audit`, `hash.ts`). This framing is injective, so no field value can shift a boundary into a neighbour: `noun="a|b", tool="c"` and `noun="a", tool="b|c"` hash differently. A bare separator (the earlier `fields.join("|")`) could not promise this — several hashed fields carry LLM-generated or otherwise unconstrained values (`noun` from `nounExtractor`, `parametersMetadata` whose JSON keys are the model's verbatim param keys, `agentId`, `toolName`), any of which can contain the separator.

**Required handling:**
- Keep the encoding injective. Do not revert to a bare delimiter, and do not add a field to the hash input without framing it through `frameField` the same way.
- The length prefix counts UTF-8 bytes — the same encoding SHA-256 consumes for the concatenated string — so the format is runtime-agnostic. A verifier in any language reproduces it by measuring bytes; do not switch the prefix to `String.length` (UTF-16 code units) or code points, which would frame non-ASCII data differently and report false breaks.
- The byte rule covers each field's *framing*, not its *value*: numeric fields serialize through JavaScript `String(Number)`, which other languages format differently for floats. The shipped verifier (`verifyChainRange` in `@habenula-ai/audit`, bundled into the CLI for `habenula log verify`) recomputes these hashes JS-to-JS and is unaffected; a verifier in another language must reproduce JS number formatting for the float fields. The serialization rules and this hazard are specified for re-implementers in `docs/architecture/audit-chain-format.md`, with a test vector that exercises it — that doc is the one home for the guidance, not this note. `latency_ms` is an integer and is unaffected.
- Any change to the hash format (encoding or which fields are hashed) requires a new epoch — old hashes were computed with the old format.

### A hashed value must be storable as the bytes that were hashed

**Behavior:** An unpaired UTF-16 surrogate is a legal JavaScript string and a legal JSON string, and it has no UTF-8 encoding. Hash one and store it in a SQLite TEXT column, and the two disagree: the hash's UTF-8 conversion collapses the surrogate to a single U+FFFD, where the column's round trip returns one U+FFFD per invalid byte. The row is then self-inconsistent on disk, `verifyChainRange` reports an `entry_hash` break, and every later entry chains off a hash that can never be recomputed. It is not repairable after the fact — the text that was hashed no longer exists. A verifier reports this as tampering, and several hashed fields carry model-authored or caller-authored text (`toolName`, `noun`, `parametersMetadata`, `errorMessage`), so the input is not the writer's to trust.

**Required handling:**
- Condition every string through `wellFormed` (`@habenula-ai/audit`, `hash.ts`) before it is hashed, and store that same conditioned value. One value, used for both. Conditioning only the hash input does not work, because the two substitutions differ.
- The row writer (`insertRow` in `data/helpers/audit-log.ts`) is the single place this happens. A new hashed column is added to the conditioned record there, not bound straight from the caller's params.
- Condition before the value is used as a lookup key, not only before it is stored. The read-previous query keys on `epoch_id`; searching under the raw spelling and storing the conditioned one forks the epoch.
- This is a write-path rule, not a format rule. It changes no digest, so it needs no new epoch, and an independent verifier needs no rule of its own.
- Refuse, at the request boundary, the half of it a schema can see. A `userId` or a `toolName` that is not well-formed is rejected with 400 (`wellFormedString` in `@habenula-ai/contracts`), so a caller is told rather than handed a 200 for a value the engine had to rewrite. `userId` earns this twice over: it is the Durable Object routing key as well as a hashed column, and every unpaired surrogate conditions to the same character, so two distinct identifiers would otherwise name one object.
- Keep both halves. The refusal does not make the conditioning redundant: a model-emitted tool name passes no request schema, and `noun` is derived from the opaque `params` record, which stays conditioned-and-accepted by design.

### `extractMetadata()` bounds

**Behavior:** `extractMetadata()` caps object keys at 100 (truncates with a `truncated: true` marker) and caps total JSON output at 10KB (returns `{ truncated: true, originalKeyCount }` sentinel). The function is non-recursive (one level deep by design), so depth and cycle limits are not needed.

**Required handling:** Preserve these bounds when modifying the function — they prevent audit-log bloat and protect the hash computation from unbounded input. Tests live in `test/agent/extract-metadata.test.ts`.

### `nounExtractor` return value must be validated

**Behavior:** Tool registry entries define a `nounExtractor` callback that extracts the noun from tool params. The return value is used directly in policy evaluation, audit logging, and hash computation.

**What happens if you skip validation:** An extractor can return an empty string (breaks noun-binding semantics) or a multi-MB string (bloats audit log and hash computation). Delimiter characters in the value no longer corrupt the hash — the length-prefixed framing above is injective — but the length and emptiness concerns remain.

**Required handling:**
- Validate that the extracted noun is non-empty and under a reasonable length (e.g., 1000 chars) before passing it downstream
- Be especially careful when registering tools whose params include user-influenced values

---

## Cloudflare KV

### Eventual consistency after writes

**Behavior:** KV has eventual consistency for reads. After writing a key, a read from a different edge location may return the previous value for up to 60 seconds in the worst case (typically much less, but not guaranteed).

**Required handling:**
- **1 write/sec/key limit:** KV enforces a maximum of 1 write per second to the same key. Rapidly-updating values (spend tracking, rate limits) must not use KV. Use DO built-in SQLite for these.
- Kill switch: the kill switch sets state in the DO, not in KV, for this reason — DO state is strongly consistent within the session.
- **Negative caching:** Absence of a key is also cached. Creating a new key may not be visible at other edge locations for up to 60 seconds.

KV is not on the OAuth credential path. Encrypted credentials live in the coordinator DO's SQLite (a `credential` column on the `connected_services` row), which is strongly consistent within the session — see `docs/architecture/oauth-credentials.md`.

---

## Cloudflare D1

### Current status

D1 is GA since April 2024. **Current role in Habenula:** D1 is not used at launch. The audit log uses DO built-in SQLite instead (see `docs/architecture/audit-log.md`). D1 remains available if cross-user queryable data is needed in the future.

### DO SQLite write serialization

**Behavior:** The DO's built-in SQLite has the same single-writer model as D1 — one write at a time. For the audit log hash-chain pattern, `transactionSync()` makes the read-prev-hash → insert operation atomic.

**Required handling:**
- Load test DO SQLite write throughput for the audit log pattern early in development
- Expected: ~1000 writes/sec for simple inserts (1ms per query), which far exceeds any realistic tool call rate per user
- Monitor `rowsWritten` billing metric — indexes add to write count

---

## Wrangler Dev (local loop)

### A failed hot-rebuild hangs all requests silently

**Behavior:** When a file change makes the `wrangler dev` rebuild fail (e.g. a syntax error), the dev server does not serve the last good build and does not return errors — workerd keeps listening and **accepts connections that never get a response**. Every request (health checks included) hangs to client timeout. The process looks wedged: workerd's event loop sits idle at 0% CPU. The only signal is the build error in wrangler's own terminal output; it recovers by itself the moment a rebuild succeeds. Observed on wrangler 4.77.0 (2026-07).

**Required handling:**
- If the local engine suddenly hangs everything but is still listening, check the wrangler terminal for a build error **before** reaching for restarts or state wipes.
- Run `just engine-typecheck` after edit batches — tsc catches most of what esbuild will choke on, before the dev loop goes dark.
- Remember the template-literal-embedded page JS (`src/dev-model/page.ts`) must not contain backticks or dollar-brace — a stray one is exactly this failure.

### The dev loop needs a real encryption key and an explicit visual-model opt-in

**Behavior:** The engine fails closed on a missing, malformed, or publicly known placeholder `CREDENTIAL_ENCRYPTION_KEY`: every route except `GET /api/health` returns 503 with the refusal message, and the same message is printed once to the wrangler terminal. Health stays 200 by design (pure liveness probe), so "health is green but everything else 503s" is this guard, not an outage. `VISUAL_MODEL` also ships off by default — `/dev/model` and `/api/dev/*` 404 unless it is set exactly `"true"`.

**Required handling:**
- `just dev` requires a `.dev.vars` with a real key: `openssl rand -hex 32` (see `.dev.vars.example`).
- Add `VISUAL_MODEL=true` to `.dev.vars` to use the dev observability surface.
- The test suite is unaffected — vitest injects a per-run generated key (see `vitest.config.ts`).

---

## habenula-engine Daemon (container self-host)

### The daemon's persist layout is Miniflare's, not a stable contract

**Behavior:** The self-host daemon persists DO SQLite through Miniflare's `defaultPersistRoot`. The on-disk layout under that root (`do/habenula-UserAgent/<id>.sqlite`, keyed by the daemon's pinned worker name `habenula`) is Miniflare's internal format. It is not contract-stable across Miniflare majors — a format change would strand every self-host volume written by the previous version.

**Required handling:**
- `miniflare` is exact-pinned and bumps only in lockstep with `wrangler` and `@cloudflare/vitest-pool-workers`, so exactly one workerd stays in the tree.
- Any `miniflare` bump must re-verify four things beyond the vendored workerd version: the persist-path layout (boot a pre-bump volume and read the state back — the validation harness's recreation assertions are the check), the SIGTERM behavior of Miniflare's vendored `exit-hook` (it must still kill the workerd child and exit 143 — the daemon deliberately registers no signal handlers of its own), always-on daemon fitness, and that the entry URL Miniflare reports for a `0.0.0.0` bind is still loopback (the liveness probe below targets it).
- Never change the daemon's `name: "habenula"` Miniflare option: the persist path is keyed by it, and a rename orphans every existing volume.

### Miniflare does not respawn a dead workerd child

**Behavior:** Miniflare runs the engine in a workerd child process and gives that child the listening socket. If the child dies on its own — an out-of-memory kill, an external signal — Miniflare neither respawns it nor reports it, and the parent process keeps running. The result is a process that looks healthy while the port refuses every connection. In a container nothing exited, so no restart policy fires and `docker ps` shows a healthy service.

**Required handling:**
- The daemon probes `GET /api/health` over its own bound port and exits non-zero after consecutive failures. Recovery belongs to the supervisor: the Compose file's `restart: unless-stopped` restarts the container on the same volume.
- Do not replace that exit with a Compose `healthcheck` alone. Docker restart policies act on container exit, not on health status, so an unhealthy container stays down.
- Keep the probe silent while it passes. The daemon's one-line output is what makes an always-on log readable.

---

## Worker CPU Time Limits

**Behavior:** Cloudflare Workers have a CPU time limit: 10ms on the free tier, 30 seconds on the paid tier (Unbound). Note: this is CPU time, not wall time — waiting for I/O doesn't count. But complex policy evaluation or large JSON parsing could hit this.

**Required handling:**
- Policy evaluation must be fast (it runs synchronously on every tool call)
- Test with the largest realistic policy file to verify CPU time stays well within limits
- Do not run ML inference synchronously in the permission evaluation path

---

## MCP Protocol

### Protocol version stability

**Behavior:** MCP has stabilized significantly. The last breaking change was 2025-03-26 (SSE → Streamable HTTP). The 2025-11-25 release was fully backward-compatible. The 2026 roadmap commits to no new transports.

**Required handling:**
- Pinned to MCP spec 2025-11-25 and TypeScript SDK v1.x
- Review the changelog before upgrading SDK versions
- Design the MCP integration layer so the protocol version can be changed without rewriting application logic

### SSE transport is deprecated

**Behavior:** The 2025-03-26 spec replaced HTTP+SSE with Streamable HTTP. SSE is still supported by some SDKs for backward compatibility but should not be used for new implementations.

**Required handling:**
- Use Streamable HTTP for all remote MCP connections
- The Cloudflare Agents SDK supports Streamable HTTP via `McpAgent.serve()` and `createMcpHandler()`
- Legacy SSE is available via `serveSSE()` but should only be used if a specific client requires it

---

## Durable Object SQLite

### 10GB per-DO storage limit

**Behavior:** SQLite-backed Durable Objects have a 10GB storage limit per DO on the paid plan (1GB on free). This includes all tables, indexes, and the hidden `__cf_kv` table.

**Required handling:**
- Know that the audit log has no retention machinery in this release — nothing deletes or archives an entry, so the log grows toward this ceiling without bound. The daily-epoch chain structure is designed so future retention can delete whole epochs cleanly (see `architecture/audit-log.md`); the machinery itself is not implemented
- Monitor `ctx.storage.sql.databaseSize` and alert before approaching the limit
- Indexes count toward storage and add to `rowsWritten` billing

### PITR is a hosted-platform feature

**Behavior:** The Point-in-Time Recovery API for SQLite-backed DOs exists only on Cloudflare's platform. It does not work under Miniflare — which means it is unavailable on every self-host path, not just in local development. Nothing in this release uses it.

**Required handling:**
- Do not write code or tests that depend on PITR
- Durability on the self-host paths is the durability of the persisted volume — back it up like any other data on the host

### Transaction restrictions

**Behavior:** Cannot use raw SQL transaction control statements (`BEGIN`, `SAVEPOINT`, `COMMIT`, `ROLLBACK`) via `exec()`. Must use the dedicated `transactionSync()` or `transaction()` APIs.

**Required handling:**
- Always use `ctx.storage.transactionSync()` for the audit log hash-chain pattern
- Do not attempt manual transaction management via SQL strings

---

## Cloudflare Agents SDK

### McpAgent session reset on reconnect

**Behavior:** Each client session creates a new McpAgent instance. When a client disconnects and reconnects, state resets to `initialState`. The SQL database persists, but in-memory state does not.

**Required handling:**
- Persist any important session state to the DO's SQLite, not just in-memory `this.state`
- Design tools to be resumable — a reconnecting client should be able to pick up where it left off

### Agents SDK is pre-1.0

**Behavior:** The `agents` npm package is at v0.8.x (as of May 2026). API surface may change between minor versions.

**Required handling:**
- Pin exact version in `package.json` (no caret/tilde ranges)
- Review the changelog before upgrading
- Isolate Agents SDK usage behind internal interfaces where practical

---

## Toolchain: Node + npm

### @cloudflare/vitest-pool-workers requires Node.js

**Behavior:** The Cloudflare vitest pool worker uses `ws.WebSocket` to bridge vitest and workerd, and depends on Node's runtime. Under Bun (whose WebSocket implementation was missing the `upgrade` event as of Bun 1.3.10) the bridge silently fails to establish and times out after ~90 seconds with `Timeout starting cloudflare-pool runner`. This is one of the forces behind the Node-only toolchain: Node is mandatory regardless, so the shipped surface standardizes on it rather than carrying a second runtime.

**Required handling:**
- The shipped OSS surface — runtime, CI, and self-host path — runs entirely on Node + npm. Tests run via `npx vitest run`.
- A runtime guard in `packages/engine/vitest.config.ts` throws an informative error if the pool is ever launched under Bun.
- Bun is retained only as an internal GStack devtool (a monorepo-root devDependency, absent from the OSS mirror). Do not reintroduce `bun`/`bunx` into package scripts, Justfiles, or CI — that would break the self-host proof.

---

## Dependencies

### Brand-new major versions break ecosystem tooling

**Behavior:** When a major version ships (e.g., TypeScript 6.0, ESLint 10.0), downstream packages (linters, bundlers, test frameworks) typically take days to weeks to release compatible versions. Installing a major version on release day will produce peer dependency violations and potentially broken tooling.

**Example (March 2026):** TypeScript 6.0.2 was released on March 23. typescript-eslint 8.57.2 declares a peer dependency of `typescript >=4.8.4 <6.0.0`. Installing both creates an unsupported configuration where type-aware linting may silently fail or produce incorrect results.

**Required handling:**
- Never adopt a major version in its first week (the dependency-stability rule)
- Before installing any dependency, check peer dependency compatibility with all existing packages
- Tooling such as Dependabot's `cooldown` or Renovate's `minimumReleaseAge` setting enforces this automatically

### Pre-1.0 packages change APIs between minor versions

**Behavior:** Packages below version 1.0.0 (e.g., `@cloudflare/vitest-pool-workers` 0.x, Agents SDK 0.8.x) may make breaking changes in minor or patch releases. SemVer convention treats 0.x as unstable.

**Example (March 2026):** `@cloudflare/vitest-pool-workers` removed `defineWorkersConfig` and replaced it with a `cloudflareTest` Vite plugin pattern between versions. Code written against the old API breaks silently on upgrade.

**Required handling:**
- Pin exact version (a hard invariant of this project)
- Isolate behind internal interfaces where practical
- Review the changelog for every version bump, not just majors
- Allow minimum age per tier before adopting: 7 days for vendor SDK, 14 days for platform-coupled/community (the pre-1.0 dependency rule)

### A duplicate copy of a shared package makes identical types incompatible

**Behavior:** When two packages need different versions of the same dependency, npm installs one copy at the top level and nests the other. The two copies declare separate classes. TypeScript compares classes with private members by declaration site, not by shape, so a value from one copy is not assignable to a parameter typed against the other. The error names a private field and reads as though two unrelated types were confused.

**Example:** `agents` 0.17.4 requires `@modelcontextprotocol/sdk` at an exact `1.29.0`. While the engine pinned `1.26.0`, npm hoisted 1.26.0 and nested 1.29.0 under `agents`. `createMcpHandler` comes from `agents` and is typed against the nested copy, so it rejected the engine's own `McpServer` instances:

```
error TS2345: Argument of type 'McpServer' is not assignable to parameter of type 'McpServer | Server<...>'.
  Types have separate declarations of a private property '_serverInfo'.
```

**Required handling:**
- Pin a package that a dependency also requires to the exact version that dependency declares. Move the two pins together.
- Confirm the resolved tree has one copy. Search the lockfile for the package name and expect a single entry.
- Do not trust a passing `npm install`. npm reuses existing lockfile entries, so a version change can leave the old copy in place and add a third. `npm dedupe` collapses the duplicates, and `npm ci` then proves the result is reproducible.
- Read the failure as a duplicate-copy symptom whenever an error says two types have separate declarations of a private property.

---

## OAuth

### Provider-side token revocation is asynchronous

**Behavior:** When Habenula calls a provider's token revocation endpoint, the revocation may not take effect immediately. Some providers process revocations asynchronously.

**Implication:** In the current release the kill switch does not revoke provider tokens at all — it clears all governance grants to the deny-all floor, which rejects every future tool call. Connections and credentials are preserved but unusable with no grant. Provider-side token revocation is a later-release defense-in-depth addition. When it lands, the same asynchronous-revocation race applies: if an MCP call is in flight at the exact moment of revocation, it may complete before the provider processes the revocation. This is an extremely narrow race condition, but it means token revocation is not a cryptographic guarantee of immediate cessation — it is best-effort and effective in practice.

**Required handling:** User-facing language about later-release token revocation should describe it as best-effort immediate revocation, not as a cryptographic guarantee.

### Every Google connect must request its complete scope set, never a delta

**Behavior:** `googleProvider.beginAuth` does not set `include_granted_scopes`, so a Google consent returns a credential scoped to exactly the scopes that request named — per-service credential scoping is what keeps one leaked `connected_services` row bounded to one service. The flip side: Google no longer unions in previously granted scopes.

**Implication:** A connect that requested only a newly needed scope as a delta would silently drop every previously granted scope from that service's next credential — the older tools would start failing the scope precondition after a "successful" re-connect.

**Required handling:** Every Google service's `connect.scopes` must be its complete scope set, and every `beginAuth` call must thread that complete set — never a delta. `test/integration/oauth/google-provider.test.ts` asserts the authorize request carries Gmail's full set.
