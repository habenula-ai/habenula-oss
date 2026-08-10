# Security: Invariants, Boundaries, and Honest Limits

**Habenula Whitepaper · RFC v1.0**

> **Status: Request for Comments.** This paper documents the security model of the current open-source release — what is enforced, how, and where the edges are. It is written for the reader who intends to check it against the code, and it lists known limitations with the same prominence as guarantees. Vulnerability reports: see [SECURITY.md](../../SECURITY.md).

---

## 1. Posture

Habenula asks for custody of the keys to a person's digital life — email, files, messages, and eventually money. For that product, "trust us" is not a security posture. Habenula's posture is instead:

- **Structural over behavioral.** Guarantees come from architecture — what components *cannot* reach — not from a model behaving well or a vendor promising restraint.
- **Deterministic over judgmental.** Nothing in the safety layer consults a model. Policy evaluation is a pure function; the audit write is unconditional; the kill switch is a transaction.
- **Verifiable over asserted.** The credential broker, policy engine, audit chain, and kill switch are open source under AGPL v3, and the container or npm packages you run yourself today run exactly that code; the hosted service to follow will run the same code. Claims in this paper are checkable.
- **Honest over impressive.** This is an early release. It has real, listed gaps (§7), and the sharpest of them are stated in this paper rather than left for a reader to discover.
- **Configurable over coarse.** Trust in Habenula is not demanded whole: the system factors along its trust seams, and you place each component — on your infrastructure or on ours — as you choose, with every placement's cost stated. §3.4 lays out the pieces and what each placement costs.

Habenula makes users' agents *governable*; it does not make them *safe* on the user's behalf. The user's grants define the blast radius; Habenula's job is to enforce those grants faithfully, record everything, and make stopping fast sand real. That division of responsibility is deliberate, and we state it in plain terms wherever it bears rather than in fine print.

## 2. The invariants

These rules hold everywhere in the runtime, in every context, with no exceptions. Each is held by the shape of the runtime code — and several additionally by a named guard script in the open repository, cited inline, because an invariant a reader can open and run beats one they are asked to trust.

**Invariant 1 — the model's context never contains a raw credential.** OAuth tokens are encrypted at rest and resolved only at execution time, inside the runtime, for the duration of one outbound call. The model receives conversation and tool results; it never receives a token. On the sidecar path, the content a credential unlocks does not flow back into the calling agent's model context in this release — the commission seam returns run status, not work product. Read that as the current shape rather than a permanent guarantee: governed content-return to a commissioner is planned, and the durable property is that content leaves only under governance, not that it never leaves. A fully prompt-injected model cannot exfiltrate what was never in its context. The property is one of routing — the model-facing path and the execution path meet only at the governance pipeline — and the credential-isolation test guards it.

**Invariant 2 — policy evaluation is a pure function.** `evaluatePolicy(entries, action) → decision` performs no I/O, no network calls, no logging, and consults no model. It is independently testable and deterministic: same grants, same action, same answer, forever. The decision to *hold* an un-granted call is made by the pipeline around it, so the function itself stays pure. CI keeps it pure: `check-governance-purity.cjs` bans I/O, Node built-ins, and platform imports from the evaluator, and holds the spend evaluator `evaluateSpend` to the same bar.

**Invariant 3 — the audit write precedes execution.** Every decision is committed to the append-only log before the corresponding action runs. A tool call that fails after approval gets its failure recorded against the same entry. There are no automatic retries without a new audit entry, and there is no code path from decision to execution that skips the write.

**Invariant 4 — no grant is permanent.** The only standing policy entry is the irremovable `default-deny` floor; every allow is mortal — a session grant that expires with the session, or a single-use task grant consumed on use. No code path mints a standing allow, a wildcard entry matches only for a *deny*, and `assertDenyFloor()` re-checks the floor on every boot. `check-allow-all-removed.cjs` forbids any standing-allow surface across code, tests, and shipping docs, so the absence is enforced in CI, not merely current.

**Invariant 5 — no tool executes outside the pipeline.** Every tool call the model emits funnels through one path — registry lookup, policy evaluation, audit write, then execute-or-hold — with no bypass; an unregistered tool is held for confirmation, never run by default. This one is held by the shape of the code rather than a guard: a single execution funnel, with no second route to a provider or MCP call. It is the precondition that makes Invariants 2 and 3 bind — a decision cannot be routed around.

**Invariant 6 — control-plane tools are reachable only through the token-gated internal channel.** Operating Habenula — kill, disconnect, quit, reading standing policy — is a governed service exposed only on the `/internal/mcp` drive surface, gated by a caller token (`INTERNAL_MCP_TOKEN`). A run's origin is stamped by the surface it arrived on, not declared by the caller: a request on the open commission surface (`/mcp`) is stamped `commission` and can never present as `internal`, because it does not hold the token. So `controlPlaneAllowed(origin)` — consulted where tools are offered, where a call is dispatched, and where a parked hold resolves — enforces a channel boundary, not a self-asserted flag. A prompt-injected or attacker-commissioned model can name `kill`; on a commission run the name is *refused*, not held, because a held call is a question put to the user and this one must never be asked. This bounds the model, not a compromised local caller: a process that already holds the token is inside the boundary — the machine is the trust boundary in this release, a gap stated in §5 and §7.

## 3. Credential custody

### 3.1 Acquisition

Habenula is the OAuth client for every connected service. Every flow whose provider supports PKCE uses it (S256): the code verifier never leaves the user's Durable Object, the challenge travels to the provider, and the token exchange is protected against authorization-code interception. Slack is the deliberate exception. It authenticates its token exchange with the client secret rather than a PKCE challenge; its optional PKCE support actually breaks the exchange, so the flow sends no challenge by design. The protection is equivalent: without the server-held client secret, an intercepted authorization code cannot be exchanged. OAuth state is stored in the DO's SQLite and consumed atomically — read-and-delete in one transaction — so a state value authorizes at most one completion. Protocol operations are plain `fetch` against provider endpoints via the Web Crypto API, with no OAuth library in the dependency chain to audit at one remove.

### 3.2 Storage

The encrypted credential lives in a column on the service's own connection row, in the per-user Durable Object SQLite — not in any shared or eventually-consistent store. Consequences, each load-bearing:

- **Connect and disconnect are atomic.** The connection and its credential are one row; there is no window where one exists without the other.
- **Revocation is immediately consistent.** Disconnecting a service deletes the row and the credential in the same operation. There is no propagation delay during which a stale read could resolve a removed credential.
- **Per-user isolation is inherent.** Each user's credentials live inside that user's isolated database, not in a shared namespace partitioned by key-naming discipline.

Encryption is AES-256-GCM via the platform's Web Crypto: a 256-bit key, a fresh random 96-bit IV per encryption, a full 128-bit authentication tag, and shape validation of the decrypted payload as defense in depth behind GCM's integrity check.

### 3.3 Use and disposal

The runtime holds a session *reference*, never a plaintext token. At execution time the reference is resolved, the credential decrypted, used for the single outbound call, and discarded — it is not persisted decrypted, not cached in agent state, and not returned to the model. Concurrent calls that discover an expired token coordinate through a single-flight refresh, so providers that invalidate the old refresh token on use — GitHub, Microsoft and Slack all rotate this way — cannot be tripped into a lockout by parallelism.

### 3.4 Placing the components — sovereignty and convenience

Habenula must be able to decrypt credentials to use them on the user's behalf; that is what delegation means, and this paper will not obscure it. But "custody" is not one thing. A credential *rests* somewhere encrypted and is *used* somewhere in plaintext, and a different component — each placed independently, on your own infrastructure or on Habenula's — governs each moment. The honest question is per moment. Running every component yourself ships today; the finer-grained placements — a store you choose, a hosted engine, a hosted ingress — are the committed direction:

- **Where the engine runs decides at-*use* custody.** The engine decrypts a credential and makes the authenticated call, so whoever runs it holds the plaintext at that instant. Run the engine yourself — the placement that ships today — and at-use custody is yours end to end; a hosted engine (planned) holds the credential in its process at each call. This is the irreducible moment: at-use custody can be *relocated*, never eliminated.
- **Where the master key rests decides at-*rest* custody, and it composes with either engine.** Today the key sits in a store Habenula bundles; on the self-hosted placement that store is on your machine, so Habenula never sees it. Bring-your-own secret store — your own KMS or secret manager — is a planned fast-follow, and a *separate* choice from where the engine runs. With a self-hosted engine, your own store means the key never leaves your infrastructure at all. With a hosted engine, it means Habenula keeps no standing store of your key — a real cut in central-store breach risk — but the engine still fetches it to use, so at-use custody stays with whoever runs the engine.
- **Where the OAuth ingress runs decides the acquisition path.** The ingress that runs the OAuth client is its own component — deployable on Habenula's infrastructure (our verified client registrations, zero friction) or on yours (your own client IDs), independent of where the engine runs. Its reach onto your tokens is stated per connector: for a public client with PKCE or a device flow it is off the token path entirely and your engine exchanges the token itself; for the cloud redirect problem it relays only a PKCE-protected code it cannot use; only for a confidential-secret holdout like Slack does a hosted ingress briefly handle the token in transit, never at rest.
- **Fully hosted** is the corner where every component, the secret store included, sits on Habenula's side — the standard at-rest exposure of any cloud credential product, where a platform with administrative access to its own store could in principle decrypt what it holds. Anyone that matters to has the at-rest axis above as the answer: keep the secret manager yourself and let Habenula host the rest, and the key at rest is never in Habenula's reach.

**Known limitation:** a key-rotation procedure (re-encrypting stored credentials under a new master key) is not yet designed or implemented. The single-store layout is built to make such a procedure straightforward when it lands, but the rotation strategy itself is still open. Until it ships, key compromise response is manual. This is tracked and stated here deliberately.

## 4. Audit integrity

### 4.1 Design

Every governance decision and every execution outcome is written to an append-only log in the user's own Durable Object SQLite. Entries are hash-chained: each carries a SHA-256 hash over its content and the previous entry's hash, computed and inserted atomically in one synchronous transaction, so the read-previous/write-next pair cannot interleave.

The chain runs in **daily epochs**. Each day's entries chain internally; each epoch's first entry carries the final hash of the previous epoch, so the epochs themselves chain end to end. Epochs exist for a reason beyond tidiness: they reconcile tamper evidence with data-deletion obligations. The design intent is that retention expiry — and, where law requires, erasure — can remove whole epochs cleanly without breaking the integrity of what remains. That property is a consequence of the epoch structure, which ships. **The retention and archival machinery that would exercise it does not: nothing on the current release deletes or archives an epoch.** The chain is built to survive the operation; the operation is not yet implemented. The surviving chain still verifies, and the *absence* of an epoch is itself detectable from the cross-epoch links.

Every entry additionally records its **origin** — whether the action arose from the human's own session or from a goal commissioned by an outside agent — and origin is an input to the entry hash. Provenance is not an annotation on the record; it is part of what the chain protects.

Verification walks the chain and recomputes: any modified entry breaks every subsequent link within its epoch. Epoch-level tampering is a weaker guarantee and we will not round it up. Because `epoch_prev_hash` is outside the entry hash, an adversary with database write access who deletes an interior epoch produces entries that still hash correctly. If they leave the successor's link stale or null it, the separate cross-epoch comparison catches the break — and the shipped verifier performs it: `habenula log verify` recomputes every entry hash and both link kinds on the user's own machine, against the live engine or a dump file, and the chain format is published with test vectors so an independent implementation can perform the same checks without running our code. If they also re-stamp the successor's link to the surviving predecessor, the deletion hashes correctly and passes — which is why what verification establishes is range integrity, no entry inside the covered range altered, removed, or reordered undetected, never proof about the range's edges; the published format specification states that boundary explicitly. Content is not required for any of this — by default the log records metadata (parameter *shapes*, sizes, counts), never bodies, so the integrity mechanism and the privacy default do not trade against each other.

### 4.2 Encoding discipline

A tamper-evidence claim rests on more than hashing fields together. Two properties of the construction carry it:

1. **Injective field framing.** The hash length-prefix-frames every field (`<byte-length>:<value>`, counted in UTF-8 bytes — the same encoding the hash consumes) rather than joining fields with a delimiter. A bare delimiter would not be injective when a model-influenced field can contain that delimiter: an adversary with database write access could shift content across a field boundary without changing the hash. Length-prefix framing removes that ambiguity and is runtime-agnostic — a verifier in any language reproduces the boundaries by measuring bytes.
2. **Every load-bearing field is hashed.** Every stored field an incident review depends on — including the reason text that distinguishes *why* a session ended or a call was denied — is an input to the entry hash. A field that is stored but not hashed is a field that can be silently rewritten.

   Two fields are deliberately outside the entry hash, and the reasons matter. `parameters_content` is always null in this release, and joins the hash when opt-in content capture ships alongside that feature's encryption and redaction design. `epoch_prev_hash` is excluded so that a mid-epoch redaction stays bounded to its own epoch rather than cascading forward through every later one — folding it in would trade the erasure property for a link that is checked separately anyway.

The adversarial tamper cases for both are covered by tests. One planned evolution remains, for schema flexibility rather than integrity: a two-tier layout that hashes each entry as a single canonically-serialized payload with a fixed chain header, decoupling the hash format from the entry schema so future fields never require a format migration.

## 5. Threat boundaries

The trust map is small enough to state in prose. **Untrusted:** the model (any vendor's), all tool and web content, third-party MCP servers, outside commissioning agents, and the public internet. **Trusted:** the Habenula Worker and the user's Durable Object — the code in this repository. **The credential boundary** sits inside the trusted zone: tokens are reachable only from the execution path, never from the model-facing path.

Selected surfaces and their treatment:

- **Prompt injection via tool output.** Malicious content retrieved by a tool can steer the model. Two layers respond. Injected instructions arrive inside a nonce-fenced envelope labeled as data — a mitigation, not a guarantee. The actual backstop is that whatever the model then *requests* still faces the deterministic gate, the user's narrow grants, and the held-call flow for anything un-granted. Injection can waste an agent's turn; within a tight policy it cannot spend, send, or delete beyond the user's explicit scope.
- **A lying or compromised tool.** Governance evaluates tool *calls*, not tool honesty — it binds the request, not the effect (governance whitepaper §7). Any tool runs on infrastructure Habenula does not control, so it can act other than as asked and return false results to the model and the user. It cannot trigger *additional* unauthorized calls — those still face the gate. The authored built-ins are the tightest case — at launch the connected set is a small, curated group of major providers Habenula wrote the client for, and the audit trail bounds the forensics regardless.
- **OAuth interception.** PKCE on every flow whose provider supports it; Slack's exchange is secret-authenticated instead; state consumed atomically; single-use.
- **The model requesting its own permissions.** There is no path. Policy lives in the runtime's storage; the model has no tool that writes policy; grants are minted only by the user's resolution of a held call.
- **A compromised local process (this release's sharpest edge).** The runtime's API is local, unauthenticated, and guarded by a loopback-only rule. The drive-by and DNS-rebinding class from the browser is refused on every route. But a hostile process already running as the user is *inside* this release's boundary and could drive the API directly, including resolving holds. The machine is the trust boundary in this release. Inbound authentication (and with it, real containment of local callers) is scheduled on the roadmap, and until it ships we describe the CLI-approval workflow as the designed pattern, not an enforced property. Users running untrusted software on the same machine as their agent runtime should weigh that plainly.

What the sandbox does **not** contain is documented in the governance whitepaper §7 — the policy is the blast radius, permitted channels can carry anything, and per-call evaluation does not yet judge cross-action combinations. Those limits are governance-shaped, but a security reader should hold them too.

## 6. The kill switch, precisely

One command; one atomic transaction carries the safety guarantee: every grant is deleted down to the irremovable deny-all floor, and every held call is swept away in the same commit. A best-effort second transaction then closes each swept call with a terminal, audited denial recorded against its pending entry, and writes a session-end entry that names the kill as its reason, ending the active session. If that bookkeeping fails, the deny-all still stands — it committed first, on its own, ahead of the audit write. This is the one deliberate inversion of Invariant 3: for kill alone, safety commits before its own audit record rather than after, because a kill that fails to record must still stop the agent. Propagation is edge-fast — typically tens of milliseconds.

What kill does *not* do by default, stated exactly: it does not terminate the process serving an in-flight outbound call (a call already past the gate completes), it does not delete stored credentials, and it does not revoke tokens at the provider. None of these weakens the guarantee that matters: after the transaction commits, no new action can pass the gate, because there is nothing left to match but the deny floor. There is no provider-side revocation in this release on any path, which §7 lists as a gap rather than leaving to inference.

## 7. Launch baseline: the current gaps, in one place

For the reader who wants the risk register without the prose:

| Gap | Status |
|-----|--------|
| No API authentication — local, loopback-guarded only; any local process is inside the boundary | Scheduled: account auth + inbound token scoping (roadmap, next phase) |
| No key-rotation procedure for the credential master key | Not implemented; rotation strategy still open, tracked (backlog) |
| Credential master key sits in the secret store the launch container bundles (on your machine) | Bring-your-own secret store — your own KMS or secret manager — is a planned fast-follow (§3.4, architecture §7) |
| No rate enforcement in the governance pipeline. Three of the permission model's six verb modifiers — rate limits, daily limits, active hours — are published in the model but unimplemented. (Spending enforcement ships: an action that spends money is priced against per-session and per-month caps before it runs, and going over asks rather than failing silently.) | Scheduled. The counter substrate lands first, then the rate-enforcement stage that reads it. Per-service and per-transaction spend caps are also still to come |
| CORS configured permissively for local development | Must be restricted for any non-local deployment; documented in SECURITY.md |
| Human Touch is a CLI-side presence gesture, not payload-bound proof (see governance §6) | Hardware-bound approval signatures on the roadmap |
| Single active session | Multi-agent isolation lands next phase |
| Grants scope to the session (single-agent in this release), not yet to named agents independently | Arrives with the multi-agent split |
| Single-node only | Launch ships the run-it-yourself `workerd` build two ways — a container on any Docker host, and the npm packages (host-run on loopback) — both single-node. Self-host on your own Cloudflare account ships next; a hosted option and multi-node / non-`workerd` horizontal scale follow (architecture §4) |

Deployments that ignore this table — for instance, exposing this release's API beyond loopback, or shipping the repository's placeholder encryption key into production instead of setting a real secret — are running outside the documented envelope, and SECURITY.md says so in bold.

## 8. Verifying this paper

The mechanisms here are the open repository's smallest, most-reviewed modules: the credential crypto and store, the PKCE implementation, the pure policy evaluator, the audit write path and its transaction, and the kill transaction. The test suite runs against the real Workers runtime — platform primitives are not mocked — and includes the credential-isolation and chain-tamper tests that correspond to Invariants 1 and 3. The architecture whitepaper maps where each component runs and what its trust relationships are; the governance whitepaper covers the decision model these mechanisms enforce. Disclosure of anything this paper gets wrong: security@habenula.ai, per [SECURITY.md](../../SECURITY.md).
