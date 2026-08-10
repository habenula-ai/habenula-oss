// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Named query helpers over the `audit_log` table, read and write.
 *
 * The write path is exactly two exported functions — `insertAuditEntryInTxn`
 * for rows that name no decision entry, and `closeDecisionEntryInTxn`, the
 * only function that can set `decision_entry_id`. The row writer they share
 * is module-private, so those two are the whole surface: the asymmetric
 * closer rule cannot be bypassed by reaching for something rawer, and the
 * type split keeps the non-referencing write from carrying a referent at all.
 *
 * Neither EVER opens a transaction of its own — `transactionSync()` lives on
 * `DurableObjectStorage`, which helpers don't hold. The caller provides
 * atomicity: `UserAgent.writeAuditEntry()` is the standalone wrapper that
 * opens one, and orchestrators with a transaction already open
 * (createSessionInTxn, the reaper, killSwitch TX2) call this directly inside
 * it. That single rule replaces the old helper-opens-its-own-transaction
 * form; there are no exceptions.
 *
 * The read-prev queries are kept on one line so their SQL text is
 * byte-identical to the former `storage.sql.exec` strings — the audit
 * hot-path guarantee, pinned by test.
 */
import type { EngineSql } from "./types";
import type { AuditLogRow } from "../schemas/audit-log";
import { GENESIS_SENTINEL, computeEntryHash, wellFormed } from "@habenula-ai/audit";

/** Who initiated the recorded event. */
export type AuditOrigin = "human" | "mcp_commission";

/** Every column an audit row carries except the referent. */
interface AuditEntryFields {
  userId: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  service: string;
  verb: string;
  noun: string;
  decision: "allow" | "deny" | "pending";
  /** Provenance; defaults to 'human'. Joins the hash input (tamper-evident). */
  origin?: AuditOrigin;
  parametersMetadata: Record<string, unknown>;
  outcome: "success" | "error" | "timeout";
  errorMessage?: string;
  latencyMs: number;
  costUsd?: number;
  /** Override for testing epoch boundaries. Defaults to today (YYYY-MM-DD). */
  epochId?: string;
  /** Override for testing. Defaults to now (ISO 8601). */
  timestamp?: string;
}

/**
 * Params for a row that names NO decision entry. `decisionEntryId?: never` is
 * load-bearing and is not the same as omitting the field: an omitted field is
 * only caught by the excess-property check, which fires on a fresh object
 * literal and NOT on a spread (`{ ...closerParams, outcome: "error" }`) or on a
 * pre-typed variable. Both of those compile clean against a merely-absent
 * field and then write NULL, silently orphaning the outcome row. Declaring the
 * field forbidden makes all three shapes a compile error.
 */
export type AuditEntryParams = AuditEntryFields & { decisionEntryId?: never };

/**
 * Params for a row that CLOSES a decision entry. Writable only through
 * `closeDecisionEntryInTxn`, which requires the writer's basis — see there.
 */
export type ReferencingAuditEntryParams = AuditEntryFields & {
  /** The decision entry this row resolves. */
  decisionEntryId: string;
};

/** Whether a closer's writer saw the disposition it records, or deduced it. */
export type CloserBasis = "observed" | "inferred";

export interface AuditEntryResult {
  id: string;
  hash: string;
  epochId: string;
  sequenceNum: number;
}

/**
 * The epoch id for a wall-clock-derived entry, clamped so it never predates the
 * newest stored epoch. A clock regression across UTC midnight — a
 * fast-clock write sealing epoch D with a successor genesis, then an accurate
 * clock landing back on D-1 — would otherwise reopen a sealed epoch and fork the
 * cross-epoch hash link. `epoch_prev_hash` is deliberately excluded from the
 * entry hash, so once a genesis stamps it the link can't be repaired in an
 * append-only log; a verifier would then flag an honest chain as tampered.
 * Continuing the newest epoch instead keeps `(epoch_id, sequence_num)` aligned
 * with write order. ISO `YYYY-MM-DD` sorts chronologically, so the lexicographic
 * max is the later date. The `timestamp` column still records the real (possibly
 * regressed) wall-clock instant — only the chain-ordering epoch is clamped.
 */
function deriveMonotonicEpochId(sql: EngineSql): string {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    ...sql<{ max_epoch: string | null }>`SELECT MAX(epoch_id) AS max_epoch FROM audit_log`,
  ];
  const maxStored = rows[0]?.max_epoch ?? null;
  return maxStored !== null && maxStored > today ? maxStored : today;
}

/**
 * The indivisible read-prev + compute-hash + insert, shared verbatim by the
 * two exported writes so they cannot drift in what they hand
 * `computeEntryHash`. MUST run inside a caller-opened `transactionSync()` —
 * on its own it cannot guarantee the hash chain against a concurrent write.
 *
 * It guarantees a second thing: the text it hashes and the text it stores are
 * the same text. Every string is conditioned once into `text` below, and both
 * the hash input and the INSERT bind from that record. Skipping the
 * conditioning is not a cosmetic defect — see `wellFormed` for why an
 * unconditioned value permanently breaks the chain it is written into.
 */
function insertRow(
  sql: EngineSql,
  params: AuditEntryFields,
  decisionEntryId: string | null,
): AuditEntryResult {
  // An explicit epochId is a test/caller affordance and is honored as-is; only
  // the wall-clock-derived default is monotonic-clamped.
  const epochId = params.epochId ?? deriveMonotonicEpochId(sql);
  const timestamp = params.timestamp ?? new Date().toISOString();
  const id = crypto.randomUUID();
  const origin: AuditOrigin = params.origin ?? "human";
  const metadataJson = JSON.stringify(params.parametersMetadata);

  // Every string bound below is conditioned ONCE, here. The hash input and the
  // INSERT both read from this record and never from `params`, which is what
  // keeps the hashed text and the stored text the same text.
  //
  // The rule takes no exceptions. A closed union like `decision` cannot carry
  // caller text today, and routing it through costs nothing; what it buys is
  // that a field added to this record later cannot be the one that was
  // forgotten. `epochId` is conditioned before the read-prev query uses it, so
  // a conditioned row is never sought under an unconditioned key.
  //
  // `prevHash` and `epochPrevHash` are absent because they are not caller text:
  // both are read straight out of the `hash` column, or are the literal
  // sentinel, and are well-formed by construction.
  const text = {
    epochId: wellFormed(epochId),
    id: wellFormed(id),
    timestamp: wellFormed(timestamp),
    userId: wellFormed(params.userId),
    agentId: wellFormed(params.agentId),
    sessionId: wellFormed(params.sessionId),
    origin: wellFormed(origin),
    service: wellFormed(params.service),
    verb: wellFormed(params.verb),
    noun: wellFormed(params.noun),
    toolName: wellFormed(params.toolName),
    parametersMetadata: wellFormed(metadataJson),
    decision: wellFormed(params.decision),
    outcome: wellFormed(params.outcome),
    errorMessage: params.errorMessage === undefined ? null : wellFormed(params.errorMessage),
    decisionEntryId: decisionEntryId === null ? null : wellFormed(decisionEntryId),
  };

  // Get last entry in current epoch
  const lastInEpoch = [
    ...sql<Pick<AuditLogRow, "hash" | "sequence_num">>`SELECT hash, sequence_num FROM audit_log WHERE epoch_id = ${text.epochId} ORDER BY sequence_num DESC LIMIT 1`,
  ];

  let prevHash: string;
  let sequenceNum: number;
  let epochPrevHash: string | null = null;

  if (lastInEpoch.length > 0) {
    prevHash = lastInEpoch[0]!.hash;
    sequenceNum = lastInEpoch[0]!.sequence_num + 1;
  } else {
    // New epoch — link to previous epoch's final entry
    const lastOverall = [
      ...sql<Pick<AuditLogRow, "hash">>`SELECT hash FROM audit_log ORDER BY epoch_id DESC, sequence_num DESC LIMIT 1`,
    ];

    prevHash = GENESIS_SENTINEL;
    epochPrevHash = lastOverall.length > 0 ? lastOverall[0]!.hash : null;
    sequenceNum = 0;
  }

  const hash = computeEntryHash({
    ...text,
    sequenceNum,
    prevHash,
    latencyMs: params.latencyMs,
    costUsd: params.costUsd ?? null,
  });

  sql`
    INSERT INTO audit_log (
      id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
      timestamp, user_id, agent_id, session_id,
      tool_name, service, verb, noun,
      decision, parameters_metadata, parameters_content,
      outcome, error_message, decision_entry_id, latency_ms, cost_usd,
      origin
    ) VALUES (
      ${text.id}, ${text.epochId}, ${sequenceNum}, ${prevHash}, ${hash}, ${epochPrevHash},
      ${text.timestamp}, ${text.userId}, ${text.agentId}, ${text.sessionId},
      ${text.toolName}, ${text.service}, ${text.verb}, ${text.noun},
      ${text.decision}, ${text.parametersMetadata}, ${null},
      ${text.outcome}, ${text.errorMessage}, ${text.decisionEntryId}, ${params.latencyMs}, ${params.costUsd ?? null},
      ${text.origin}
    )
  `;

  // The conditioned identifiers, not the raw ones: a caller that queries by
  // what it was handed must find the row that was written.
  return { id: text.id, hash, epochId: text.epochId, sequenceNum };
}

/**
 * The non-referencing write: always inserts NULL in `decision_entry_id`, so
 * no caller of this function can close a decision entry. Txn-context-only,
 * per `insertRow`.
 */
export function insertAuditEntryInTxn(
  sql: EngineSql,
  params: AuditEntryParams,
): AuditEntryResult {
  return insertRow(sql, params, null);
}

/**
 * The ONLY function that can set `decision_entry_id`, and the one place the
 * asymmetric write rule lives. The rule sits HERE rather than a layer up in a
 * caller, because `insertRow` is module-private: there is no way to name a
 * decision entry without declaring a basis, and the compiler checks it. A new
 * sweep path cannot reach a rawer write, so it inherits the rule instead of
 * remembering it.
 *
 * An `observed` writer saw the disposition it records (or holds the only
 * durable record of it, e.g. the `dispatched` marker) and always writes: a
 * second closer on an observed basis is a correction, and the log keeps both.
 * An `inferred` writer is asserting a disposition it deduced (a sweep's
 * timeout/cancel), so it skips when a closer already exists — the truth is
 * already recorded, and the fabricated row would contradict it.
 *
 * Txn-context-only, per `insertRow`; the inferred branch's existence read is
 * meaningful only inside the transaction whose write it gates. Observed always
 * writes, so that overload returns the entry; only the inferred branch can
 * skip, so only it admits null. The basis is a required positional argument so
 * a new call site cannot omit it and default into the observed branch.
 */
export function closeDecisionEntryInTxn(
  sql: EngineSql,
  params: ReferencingAuditEntryParams,
  basis: "observed",
): AuditEntryResult;
export function closeDecisionEntryInTxn(
  sql: EngineSql,
  params: ReferencingAuditEntryParams,
  basis: CloserBasis,
): AuditEntryResult | null;
export function closeDecisionEntryInTxn(
  sql: EngineSql,
  params: ReferencingAuditEntryParams,
  basis: CloserBasis,
): AuditEntryResult | null {
  if (basis === "inferred" && hasCloserInTxn(sql, params.decisionEntryId)) {
    return null;
  }
  return insertRow(sql, params, params.decisionEntryId);
}

/**
 * Whether any row already closes `decisionEntryId` — the inferred write
 * branch's existence read, and `idx_decision_entry`'s first production
 * reader. Txn-context-only: meaningful only inside the transaction whose
 * write it gates.
 */
export function hasCloserInTxn(sql: EngineSql, decisionEntryId: string): boolean {
  const rows = [
    ...sql<{ one: number }>`SELECT 1 AS one FROM audit_log WHERE decision_entry_id = ${decisionEntryId} LIMIT 1`,
  ];
  return rows.length > 0;
}

/**
 * Identity fields of an entry by id — how the reaper and kill path recover a
 * held call's user/agent/session/scope from its `pending` decision entry.
 */
export function readAuditEntryIdentity(
  sql: EngineSql,
  entryId: string,
): Pick<
  AuditLogRow,
  "user_id" | "agent_id" | "session_id" | "tool_name" | "service" | "verb" | "noun" | "origin"
> | null {
  const rows = [
    ...sql<
      Pick<
        AuditLogRow,
        "user_id" | "agent_id" | "session_id" | "tool_name" | "service" | "verb" | "noun" | "origin"
      >
    >`
      SELECT user_id, agent_id, session_id, tool_name, service, verb, noun, origin
      FROM audit_log WHERE id = ${entryId} LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}

/** The columns the visual model snapshot ships per audit entry:
 * everything except `user_id` (the envelope names the user once),
 * `epoch_prev_hash` (epoch-boundary internals), and `parameters_content`
 * (content never rides the snapshot — metadata-only default). */
export type RecentAuditEntryRow = Omit<
  AuditLogRow,
  "user_id" | "epoch_prev_hash" | "parameters_content"
>;

/**
 * The newest `limit` audit entries, newest first — the visual model
 * snapshot's bounded window. Ordered by `(epoch_id, sequence_num)`, the
 * chain's own total order, not `timestamp` (which callers may override).
 */
export function selectRecentAuditEntries(
  sql: EngineSql,
  limit: number,
): RecentAuditEntryRow[] {
  return [
    ...sql<RecentAuditEntryRow>`
      SELECT id, epoch_id, sequence_num, prev_hash, hash, timestamp,
             agent_id, session_id, tool_name, service, verb, noun,
             decision, parameters_metadata, outcome, error_message,
             decision_entry_id, latency_ms, cost_usd, origin
      FROM audit_log
      ORDER BY epoch_id DESC, sequence_num DESC
      LIMIT ${limit}
    `,
  ];
}

/** The columns the audit read route ships per row: every
 * hashed column plus `hash` and `epoch_prev_hash` — the two hash-excluded
 * columns a verifier needs — verbatim and unprojected. Only
 * `parameters_content` stays off the wire: it sits outside the hash and the
 * metadata-only default keeps content off read surfaces. Deliberately a
 * different shape from `RecentAuditEntryRow`, the display projection above —
 * a projection cannot be verified. */
export type AuditChainRow = Omit<AuditLogRow, "parameters_content">;

/**
 * One page of the audit chain in its own total order `(epoch_id,
 * sequence_num)`, DESCENDING — newest first, walked from the high end of the
 * existing `idx_epoch` unique index. `before` is the keyset predicate from
 * the prior page's last row, the same row-value shape `listTasks` uses;
 * `sequence_num` has integer affinity, so its half is bound as a number.
 * The SQL projection never selecting `parameters_content` is the ONE gate
 * keeping content off this wire (respond() is log-and-pass, not a filter).
 */
export function selectAuditChainPage(
  sql: EngineSql,
  params: { limit: number; before?: { epochId: string; sequenceNum: number } },
): AuditChainRow[] {
  const { limit, before } = params;
  if (before) {
    return [
      ...sql<AuditChainRow>`
        SELECT id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
               timestamp, user_id, agent_id, session_id, tool_name, service,
               verb, noun, decision, parameters_metadata, outcome,
               error_message, decision_entry_id, latency_ms, cost_usd, origin
        FROM audit_log
        WHERE (epoch_id, sequence_num) < (${before.epochId}, ${before.sequenceNum})
        ORDER BY epoch_id DESC, sequence_num DESC
        LIMIT ${limit}
      `,
    ];
  }
  return [
    ...sql<AuditChainRow>`
      SELECT id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
             timestamp, user_id, agent_id, session_id, tool_name, service,
             verb, noun, decision, parameters_metadata, outcome,
             error_message, decision_entry_id, latency_ms, cost_usd, origin
      FROM audit_log
      ORDER BY epoch_id DESC, sequence_num DESC
      LIMIT ${limit}
    `,
  ];
}

/**
 * A session's `session.start` identity — how session.end recovers user/agent
 * (and the session's `origin`) when there is no held call to read them from.
 * The `origin` lets session.end match the start's origin instead of defaulting
 * to `human`, so a commission session's lifecycle stays symmetric in the chain.
 */
export function readSessionStartIdentity(
  sql: EngineSql,
  sessionId: string,
): Pick<AuditLogRow, "user_id" | "agent_id" | "origin"> | null {
  const rows = [
    ...sql<Pick<AuditLogRow, "user_id" | "agent_id" | "origin">>`
      SELECT user_id, agent_id, origin FROM audit_log
      WHERE session_id = ${sessionId} AND tool_name = 'session.start'
      LIMIT 1
    `,
  ];
  return rows[0] ?? null;
}
