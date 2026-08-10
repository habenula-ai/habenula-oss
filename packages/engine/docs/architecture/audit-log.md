# Audit Log

Every tool call, permission decision, and outcome is recorded in an append-only, tamper-evident log stored per-user in the Durable Object's built-in SQLite database.

**Decision:** Use DO built-in SQLite instead of D1. Rationale is consolidated into the security whitepaper (`docs/whitepapers/security.md`).

## Entry Schema

```typescript
interface AuditEntry {
  id: string;                    // UUID v4
  epoch_id: string;              // date string, e.g. "2026-04-04"
  sequence_num: number;          // position within epoch (starts at 0)
  prev_hash: string;             // SHA-256 of previous entry in epoch
  hash: string;                  // SHA-256 over every length-prefix-framed field (see Atomic write below + audit/hash.ts)
  epoch_prev_hash?: string;      // genesis entries: final hash of previous epoch
  timestamp: string;             // ISO 8601 UTC
  user_id: string;
  agent_id: string;
  session_id: string;
  tool_name: string;             // e.g. "gmail_list_messages"
  service: string;               // e.g. "gmail"
  verb: string;                  // e.g. "list" — from tool registry
  noun: string;                  // e.g. "messages" — from tool registry
  decision: "allow" | "deny" | "pending";  // pending = held awaiting user resolution
  parameters_metadata: object;   // shape of params, no content values
  parameters_content?: string;   // AES-256 encrypted, user opt-in only
  outcome: "success" | "error" | "timeout";  // on decision entries, mirrors decision (redundant, backlogged for removal)
  error_message?: string;
  decision_entry_id?: string;       // outcome entries reference their decision entry
  latency_ms: number;
  cost_usd?: number;
  origin: "human" | "mcp_commission";  // who initiated the action — a human user or an inbound /mcp commission
}
```

**Two-entry pattern:** Allowed tool calls produce two hash-chained entries: a decision entry (before execution, `decision_entry_id: null`) and an outcome entry (after execution, `decision_entry_id` references the decision). Deny paths produce one entry. Both are immutable and tamper-evident. Query patterns: decisions = `WHERE decision_entry_id IS NULL`, outcomes = `WHERE decision_entry_id IS NOT NULL`, paired = `JOIN audit_log o ON o.decision_entry_id = d.id`. The referent column, not the `decision` word, is what separates the two: the spend-supersede row is an outcome row that carries `decision: "pending"`, so a query for outcome rows written as `decision != 'pending'` would miss it. Which decisions are still *open* is a further question the referent column alone cannot answer — a deny row and all three lifecycle rows also carry a NULL referent, and none of them owes a closer.

A decision normally gets one closer, but it can carry more than one, and **a second closer is a correction, not an error**. Every write that names a decision entry passes through one function, which takes the writer's basis and applies an asymmetric rule. A writer that *observed* the disposition (or holds the only durable record of it, like the `dispatched` marker) always writes: if a wrong closer already sits on the decision, the truthful second row is the correction, and the log keeps both. A writer that *inferred* the disposition (the expiry and cancel sweeps) skips when a closer already exists, because its fabricated timeout would contradict a recorded truth. That function is the only way to set the column at all, so a new sweep path inherits the rule rather than having to remember it. Every path that closes a decision entry still records the fact that it did so, in the same transaction, before anything that could fail and be retried.

Because a decision can carry a second closer, the `paired` join above can return more than one row for one decision. A reader aggregating over it — summing `cost_usd`, counting tool calls — must account for that, or a corrected decision is counted twice.

**Lifecycle events** use the same chained row with a synthetic `service`/`verb` outside the tool registry, because they record something that happened to the *system* rather than a governed tool call. Their disposition lives in `error_message` behind fixed `decision`/`outcome` placeholders (which is why that column joins the hash — see Field coverage):

| `tool_name` | Records | Disposition in `error_message` |
|-------------|---------|-------------------------------|
| `session.start` | A session began | none; the row carries no disposition |
| `session.end` | A session ended | `timeout` / `kill` / `quit` / `superseded` / `terminated` |
| `task.cancel` | A task was cancelled (`noun` is the task id) | which surface cancelled it — the user's CLI or the owning MCP client |

Those three `tool_name` values are the complete set. A reader identifies a lifecycle event by `tool_name`, because no column marks the row as one. Do not read a lifecycle row's `decision`/`outcome` as a verdict. `session.start` and `task.cancel` store `allow`/`success`; `session.end` stores `deny`/`timeout`. All of those are placeholders, so a reader that treats them as verdicts reports an ordinary session ending as a denied action. `habenula log` renders these rows neutrally for this reason, and labels the `error_message` a reason rather than an error.

A cancelled task also closes each hold it owned: every parked hold's open `pending` decision gets a terminal entry referencing it via `decision_entry_id`, so no `pending` is left dangling when the hold row is swept. A hold that is already mid-resolve (dispatched or answered) is **not** closed this way — its real outcome is owed by the resolve path, so cancel is refused rather than recording a false "never ran" disposition.

## SQLite Schema (DO Built-in)

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,              -- date string, e.g. "2026-04-04"
  sequence_num INTEGER NOT NULL,       -- position within epoch
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  epoch_prev_hash TEXT,                -- genesis entries link to previous epoch
  timestamp TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  service TEXT NOT NULL,
  verb TEXT NOT NULL,                   -- from tool registry
  noun TEXT NOT NULL,                   -- from tool registry
  decision TEXT NOT NULL,
  parameters_metadata TEXT NOT NULL,    -- JSON
  parameters_content TEXT,              -- AES-256 encrypted JSON, nullable
  outcome TEXT NOT NULL,
  error_message TEXT,
  decision_entry_id TEXT,              -- outcome entries reference their decision entry
  latency_ms INTEGER NOT NULL,
  cost_usd REAL,
  origin TEXT NOT NULL DEFAULT 'human' CHECK(origin IN ('human','mcp_commission'))
);

CREATE UNIQUE INDEX idx_epoch ON audit_log(epoch_id, sequence_num);
CREATE INDEX idx_timestamp ON audit_log(timestamp);
CREATE INDEX idx_service   ON audit_log(service);
CREATE INDEX idx_decision  ON audit_log(decision);
CREATE INDEX idx_decision_entry ON audit_log(decision_entry_id);
-- idx_decision_entry is deliberately NON-unique: a UNIQUE constraint on an
-- append-only table enforces first-writer-wins, and the losing write may be
-- the true one. The write rule lives in UserAgent.closeDecisionEntryInTxn.
```

Accessed via `this.sql.exec()` within the Durable Object. Each user's audit log lives in their DO's embedded SQLite — per-user isolation is inherent.

## Epoch-Based Hash Chain

The hash chain runs in daily epochs so that entries can one day be deleted without destroying tamper evidence. Each day starts an independent chain, so a future retention feature can remove whole epochs and the remaining chains still verify. A single continuous chain would make any deletion indistinguishable from tampering. The structure ships; nothing in this release performs the deletion.

### Epoch structure

- `epoch_id`: date string (e.g., `"2026-04-04"`) — one epoch per day
- `sequence_num`: position within epoch (starts at 0)
- Genesis entry of each epoch includes `epoch_prev_hash`: the final hash of the previous epoch, linking epochs for cross-epoch verification
- Within an epoch, each entry's `prev_hash` points to the previous entry in the same epoch
- First entry of the first epoch uses a fixed sentinel as `prev_hash`

### Atomic write

Each epoch chain uses `transactionSync()` for atomic read-previous + insert.

The write also conditions its text. Every string bound below is passed through `wellFormed` (`@habenula-ai/audit`) once, and both the hash input and the INSERT use that one conditioned value. An unpaired UTF-16 surrogate has no UTF-8 encoding, so a raw write would store bytes that were never hashed and the entry could never be verified again. Conditioning changes no digest — the hash performed the same substitution already — it makes the stored text and the hashed text the same text.

```typescript
this.ctx.storage.transactionSync(() => {
  const today = new Date().toISOString().slice(0, 10); // "2026-04-04"
  const prev = this.sql.exec(
    "SELECT hash, epoch_id, sequence_num FROM audit_log WHERE epoch_id = ? ORDER BY sequence_num DESC LIMIT 1",
    today
  ).one();

  let prev_hash: string;
  let sequence_num: number;
  let epoch_prev_hash: string | null = null;

  if (prev) {
    // Continuing within current epoch
    prev_hash = prev.hash;
    sequence_num = prev.sequence_num + 1;
  } else {
    // New epoch — link to previous epoch's final hash
    const lastEntry = this.sql.exec(
      "SELECT hash FROM audit_log ORDER BY epoch_id DESC, sequence_num DESC LIMIT 1"
    ).one();
    prev_hash = GENESIS_SENTINEL;
    epoch_prev_hash = lastEntry?.hash ?? null;
    sequence_num = 0;
  }

  // Each field is length-prefixed (`<len>:<value>`, len in UTF-8 bytes) before
  // concatenation so a field value cannot shift a boundary into its neighbour —
  // see footguns.md. Field order here is the hash-input order, which is
  // independent of the table's column order.
  const frame = (v) => `${new TextEncoder().encode(String(v ?? "")).length}:${String(v ?? "")}`;
  const hash = sha256([epoch_id, sequence_num, prev_hash, id, timestamp, user_id, agent_id, session_id, origin, service, verb, noun, tool_name, params_metadata, decision, outcome, error_message, decision_entry_id, latency_ms, cost_usd].map(frame).join(""));
  this.sql.exec(
    "INSERT INTO audit_log (...) VALUES (...)",
    id, today, sequence_num, prev_hash, hash, epoch_prev_hash, ...
  );
});
```

### Verification

- **Within epoch:** Walk entries by `sequence_num`, verify each hash matches SHA-256 of its fields + prev_hash. Modifying any entry breaks the chain from that point within the epoch.
- **Cross-epoch:** Verify each epoch's genesis entry `epoch_prev_hash` matches the final entry hash of the previous epoch. Deleting or reordering **interior** epochs is detectable. The chain's two edges are not: deleting the newest epochs, or the oldest ones with the new head's link nulled, leaves a chain that verifies clean — see the claim's boundary in [audit-chain-format.md](audit-chain-format.md).
- **The canonical verifier is `verifyChainRange`** in `@habenula-ai/audit` (`verify-chain.ts`) — a pure function from a range of entries to a located verdict, holding the same no-I/O discipline as `evaluatePolicy`. `habenula log verify` pulls rows over the paged read route and recomputes every hash client-side with it; the engine returns rows, never a verdict.
- `habenula log verify` walks all retained epochs by default and leads with the oldest break it reached — the chain's *first* break only when the walk also closed at a genesis-shaped head; a walk stopped by its page ceiling or a pruned head found only the oldest break within its range. The verdict names the range it covered, and a range it could not close is reported as unchecked (exit `4`), never as whole.
- The same walk checks decision **closure** (`checkDecisionClosure` in `@habenula-ai/audit`, `decision-closure.ts`): a decision carrying two or more closers is *conflicted* and exits `5` — a located finding about the log's content, distinct from a broken chain (`3`, which outranks it). A decision owing a closer with none is reported as text and never moves the code: an open confirmation prompt is the ordinary state of a healthy engine.
- **Framing invariant for re-implementers:** the field length prefix counts UTF-8 bytes — the same encoding SHA-256 consumes for the concatenated string — so the format is runtime-agnostic. A verifier in any language reproduces it by measuring bytes; do not measure UTF-16 code units (JavaScript `String.length`) or Unicode code points, which would frame non-ASCII data differently and report false chain breaks. The complete published specification — field order, framing, per-type serialization rules, both link kinds, and the positional rules — is [audit-chain-format.md](audit-chain-format.md), with test vectors beside it; re-implementer guidance lives there rather than being restated here.
- **Numeric field values carry JS number formatting.** The byte rule above fixes each field's *framing*; the float fields' *values* are still whatever JavaScript `String(Number)` produces, which other languages format differently. The shipped verifier is JS-to-JS and unaffected; the hazard, and the test vector that exercises it, are specified for cross-language re-implementers in [audit-chain-format.md](audit-chain-format.md).
- **Field coverage:** every persisted, semantically-meaningful column joins the hash, so no stored field can be edited without breaking the chain. This includes `error_message` — the only record of why a call was denied or failed, and the sole discriminator of a `session.end` reason (timeout/kill/quit/superseded/terminated), which `writeSessionEnd` stores there behind fixed `decision`/`outcome` placeholders — and the `user_id`/`session_id` attribution fields. A null value frames identically to an empty string (`0:`); for these fields both denote absence, and any change to a meaningful value alters the frame. Three columns are **excluded by design**: `hash` (it is the digest output); `epoch_prev_hash` (the cross-epoch link is verified separately by the cross-epoch check above, and keeping it out of the entry hash preserves the option of bounded, single-epoch redaction (deferred — see Deleting entries below) — folding it in would cascade a redaction forward through every later epoch); and `parameters_content` (always null in this release, it joins the hash when opt-in content capture lands, alongside that feature's encryption and redaction design).

### Deleting entries

Nothing in this release deletes an audit entry — retention machinery is not implemented, so the log grows until the operator intervenes. The epoch structure is what makes deletion viable later: removing whole epochs leaves the remaining chain verifiable, so the chain is built to survive the operation even though the operation does not ship.

- **Retention-based deletion (not implemented):** delete entire epochs past a retention window, leaving remaining epochs unaffected. The design unit exists; nothing performs the deletion yet.
- **Mid-epoch erasure** — removing a single entry inside an epoch — is deferred to a later release.
- **Export:** `habenula log dump` writes the complete chain as JSONL regardless of chain structure. The hash chain is an integrity mechanism, not part of the exported record.

## Metadata-Only Default

`parameters_metadata` stores the shape of a tool call, not its content:

```json
{
  "to":      { "type": "email", "count": 1 },
  "subject": { "type": "string", "length": 42 },
  "body":    { "type": "string", "length": 380 }
}
```

The `parameters_content` column exists and is **always null in this release** — there is no content-logging path to enable, and the projection that serves the chain never selects it. Storing content, and whatever key custody that would require, is a later-release question.

## Retention

Retention is not implemented in this release: nothing deletes an entry, and the log grows until the operator intervenes. The daily-epoch structure is designed so a future retention feature can delete whole epochs while hash-chain integrity holds for what remains. There is **no archival tier either** — no R2 binding exists in `packages/engine/wrangler.toml`. Export what you want to keep with `habenula log dump`.

## Storage Budget

At ~200 bytes per metadata-only entry, 10GB supports ~50 million entries per user. With indexes, practical capacity is lower but still far exceeds any realistic usage — which is why missing retention machinery is a growth concern rather than an immediate cap.

## Durability

The audit log's durability is the durability of the volume Miniflare persists to — `/data` in the container, `~/.habenula` on the host-run path. Back that up as you would any other data on the host; nothing in this release replicates it anywhere. `habenula log dump` writes the complete chain as JSONL, and `habenula log verify --file` checks a dump offline, so an exported copy stays independently verifiable.

Managed durability — scheduled off-host backup, point-in-time recovery — belongs to a hosted deployment and is not part of this release.
