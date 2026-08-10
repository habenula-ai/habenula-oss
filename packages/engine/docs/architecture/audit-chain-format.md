# Audit Chain Format

**Hash format identifier: `fieldwise-sha256-v1`**

This document specifies the audit log's hash-chain format completely enough to build an independent verifier. You do not need Habenula's source code, and you do not need Habenula's own verifier. Check your implementation against the published test vectors in [audit-chain-vectors.json](audit-chain-vectors.json).

The identifier above names this exact format. A future format revision gets a new identifier and a migration path; a verifier must refuse an identifier it does not recognise rather than guess.

## Chain structure

The audit log is a sequence of entries partitioned into **epochs**. One epoch normally spans one calendar day; nothing in verification depends on that mapping.

- `epochId` is a UTC date string, `YYYY-MM-DD`. It is a name, not an ordinal: nothing in an epoch's id says which epoch precedes it, or whether one does.
- `sequenceNum` is the entry's position within its epoch, starting at 0.
- The pair `(epochId, sequenceNum)` orders the whole log. Ascending order — oldest first — is **chain order**, the order entries are written in and the order a verifier consumes them in.

Two kinds of link make the log tamper-evident:

- **Intra-epoch:** every entry stores `prevHash`, the stored `hash` of the entry before it in the same epoch. The first entry of an epoch (`sequenceNum` 0, its **genesis**) stores the sentinel string `GENESIS` instead.
- **Cross-epoch:** every genesis entry stores `epochPrevHash`, the final entry hash of the epoch before it. The genesis of the log's first epoch stores null — no prior epoch existed.

## The entry hash

Each entry's `hash` is the lowercase hex SHA-256 of its fields, framed and concatenated:

1. Serialize each field to a string (rules below).
2. Frame each string as `<n>:<value>`, where `<n>` is the value's UTF-8 **byte** count in decimal.
3. Concatenate the frames in the field order below, with no separator.
4. `hash` = SHA-256 of the concatenation's UTF-8 bytes, as lowercase hex.

For example, `frame("2026-07-01")` is `10:2026-07-01`, and `frame("héllo")` is `6:héllo` — five characters, six bytes.

Measure bytes, always. UTF-16 code units (JavaScript `String.length`) and Unicode code points both frame non-ASCII data differently and report false chain breaks.

The length prefix is what makes the concatenation injective: given the concatenation you recover the field sequence uniquely, so no field value — however hostile — can shift a boundary into its neighbour and collide with a different tuple. A bare separator cannot promise this.

### Field order

The hash input is these 20 fields, in exactly this order:

| # | Field | Type | Nullable | SQLite column |
|---|-------|------|----------|---------------|
| 1 | `epochId` | string | no | `epoch_id` |
| 2 | `sequenceNum` | integer | no | `sequence_num` |
| 3 | `prevHash` | string | no | `prev_hash` |
| 4 | `id` | string | no | `id` |
| 5 | `timestamp` | string | no | `timestamp` |
| 6 | `userId` | string | no | `user_id` |
| 7 | `agentId` | string | no | `agent_id` |
| 8 | `sessionId` | string | no | `session_id` |
| 9 | `origin` | string | no | `origin` |
| 10 | `service` | string | no | `service` |
| 11 | `verb` | string | no | `verb` |
| 12 | `noun` | string | no | `noun` |
| 13 | `toolName` | string | no | `tool_name` |
| 14 | `parametersMetadata` | string | no | `parameters_metadata` |
| 15 | `decision` | string | no | `decision` |
| 16 | `outcome` | string | no | `outcome` |
| 17 | `errorMessage` | string | yes | `error_message` |
| 18 | `decisionEntryId` | string | yes | `decision_entry_id` |
| 19 | `latencyMs` | integer | no | `latency_ms` |
| 20 | `costUsd` | float | yes | `cost_usd` |

Field names in this document and in the test vectors are the camelCase forms; the engine's SQLite columns are the snake_case forms in the last column.

Three stored columns are deliberately **excluded** from the hash input:

- `hash` — it is the digest output.
- `epochPrevHash` — the cross-epoch link is verified separately (below). Keeping it out of the entry hash bounds a lawful single-epoch redaction to that epoch; folding it in would cascade a recompute through every later epoch.
- `parametersContent` — not captured at launch, and excluded from read surfaces. It joins the hash when opt-in content capture ships.

### Serialization rules

- **Strings** join the hash input verbatim. The writer stores only well-formed text: before it hashes a string it replaces any unpaired UTF-16 surrogate with U+FFFD, and it stores that same conditioned value. So the text you read back is always the text that was hashed, and you re-hash it exactly as it is. A verifier needs no rule of its own for this — a well-formed string frames and hashes the same way it always did.
- `parametersMetadata` holds JSON **text**. Hash the stored string exactly as it is. Do not parse and re-serialize it: a re-serialization of the same object is not guaranteed to be the same bytes.
- **Null** serializes as the empty string, so a null field frames as `0:`. Only `errorMessage`, `decisionEntryId`, and `costUsd` can be null. Inside the hash, null and `""` are therefore interchangeable; in the JSON artifacts they are distinct values, and a reader must not turn one into the other (and must never turn null into the string `"null"`).
- **Integers** (`sequenceNum`, `latencyMs`) serialize in decimal with no sign, no padding, and no fraction.
- **Floats** (`costUsd`) serialize as JavaScript `String(Number)` output. This is the one language-sensitive rule in the format, and it is where a cross-language verifier meets its sharpest hazard: JavaScript renders `0.0000005` as `5e-7`, where Python and Rust default formatting produce `5e-07`. A verifier in another language must reproduce JavaScript number formatting for this field, not merely format the same number. One published vector carries a `costUsd` of `5e-7` and exercises exactly this. A future format revision with canonical numeric serialization removes this rule.

## Verifying a range

A verifier takes a contiguous **range** of entries in ascending chain order — not necessarily the whole log — and each entry carries the 20 hashed fields plus `hash` and `epochPrevHash` (22 fields total). Optionally it also takes one **boundary entry**: the entry that immediately follows the range's newest, used to close the seam between paged reads. It produces a verdict:

```
{
  entriesChecked: integer,
  epochsCovered:  [epochId, ...]        // oldest first
  lowerEdge:      closed | genesis_shaped | unchecked (+ location)
  upperEdge:      closed | unchecked (+ location)
  breaks:         [break, ...]          // oldest first
}
```

Verification is single-pass and does not stop at the first break: the verdict carries the extent of the damage, not only its newest edge. Each break names its `kind`, its location (`epochId`, `sequenceNum`), the `expected` and `actual` values, and a `rowsMissing` flag.

### The checks

Apply to each entry, oldest first:

1. **Recompute the entry hash** from the 20 fields and compare it with the stored `hash`. A mismatch is an `entry_hash` break: the row was mutated. `expected` is the recomputed digest; `actual` is the stored one.
2. **Check the intra-epoch link.** A `sequenceNum` 0 entry must carry `prevHash` = `GENESIS` — anything else is a `genesis_sentinel` break. Every other entry's `prevHash` must equal its in-range predecessor's stored `hash` — a mismatch is a `prev_hash` break, with `expected` the predecessor's stored hash and `actual` the entry's `prevHash`.
3. **Check the cross-epoch link.** On a genesis entry whose predecessor epoch is present in the range, compare `epochPrevHash` with the predecessor epoch's final in-range hash. A mismatch is an `epoch_link` break. A **null** there is its own kind, `epoch_link_null`: this column sits outside the entry hash, so one nulled cell would otherwise sever history without breaking a single hash.

If a boundary entry was supplied, close the upper seam the same way: its `prevHash` against the range's newest stored hash, or — when the boundary is a genesis — its `epochPrevHash` against it. The boundary's own hash is not recomputed here; it belongs to the page that carried it. With a boundary the upper edge is `closed` (closed means *checked* — a seam break is still reported in `breaks`); without one it is `unchecked` and names the range's newest entry.

### The positional rules

Two rules keep a verifier from misreading its own input. Both are positional, not value-based:

- **A null `epochPrevHash` is a break only on a genesis whose predecessor epoch is in the input.** On every entry with `sequenceNum` > 0 the column is structurally null and means nothing — applied row-wise, this rule would flag most of the table. And on the *oldest* epoch of the range there is no predecessor to compare against, so a null there is not a break either: it makes the range's lower edge **`genesis_shaped`**.
- **A link whose predecessor is absent from the input is a range boundary, never a break.** The oldest entry's `prevHash` — and, on the range's oldest genesis, a non-null `epochPrevHash` — point at values the verifier was never handed. The lower edge is `unchecked` and names that entry. The verdict neither claims a break nor claims integrity it did not establish.

### Missing rows

A gap in `sequenceNum` within an epoch classifies a break rather than creating one: a broken link **with** a gap means a row is missing (`rowsMissing` true); a broken link **without** one means a row was mutated. Those are different investigations. The classification stops there — a row a transport dropped and a row an attacker deleted produce identical observations, so the verdict says a row is missing and where, never why.

The gap check spans the boundary entry, so a row missing at a page seam is caught rather than absorbed into the seam. It never runs across epochs: `epochId` is a date, not an ordinal, so an epoch missing from the input and an epoch deleted from the log are indistinguishable, and both surface as an `epoch_link` mismatch at the next epoch's genesis. An epoch whose own genesis is missing from the input surfaces as a `prev_hash` break at its first present row, with `rowsMissing` true and no `expected` value — the reference row was never handed to the verifier.

An empty range verifies to zero entries checked, no breaks, and both edges `unchecked` with no location to name.

Stop reasons — why a caller's walk ended where it did — are properties of the walk, not of the range, and are outside this specification. A conforming verifier reports *that* an edge is unchecked; the tool driving it says why.

## What a verdict establishes

A clean verdict proves integrity **within the range it covered**: no entry inside that range was altered, removed, or reordered without detection. It proves nothing about the range's edges, and no tool or document should claim more.

- **`genesis_shaped` is necessary, not sufficient.** A lower edge at `sequenceNum` 0 with a null `epochPrevHash` establishes the walk was not cut off partway. It does not establish that the log begins there: deleting the oldest epochs and nulling the new oldest genesis's `epochPrevHash` leaves exactly this shape.
- **Suffix truncation is invisible.** Deleting the newest entries, or newest whole epochs, leaves every surviving hash recomputing and every surviving link intact. The log simply looks like it stopped earlier.
- **Regeneration is invisible.** An actor with full write access can rebuild a consistent chain from any point — wholesale from genesis, or forward from an interior cut with the survivors renumbered and re-hashed.

Every adversary in this list needs the same missing thing to answer it: a chain tip obtained somewhere other than the system under audit. Recording tips over time anchors against suffix deletion, and a copy of the log taken earlier anchors everything older than it.

## Test vectors

[audit-chain-vectors.json](audit-chain-vectors.json) carries two chains under this document's hash format identifier, entries in ascending chain order:

- **`intact`** — a two-epoch chain in which every hash recomputes and every link holds. One entry carries the exponential-notation `costUsd` described above.
- **`broken`** — the same chain with one row mutated in place and one row deleted, plus `expectedVerdict`: the verdict (no boundary entry supplied) a conforming verifier must produce for it, byte for byte.

A test in the Habenula repository recomputes every published vector against the shipped implementation, so these values cannot drift from the code unnoticed.
