//! SPDX-FileCopyrightText: 2026 Habenula, Inc.
//! SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";

export const GENESIS_SENTINEL = "GENESIS";

/**
 * Identifier of the hash format this module implements. Carried by dump-file
 * manifests and checked by verifiers; the published specification lives at
 * packages/engine/docs/architecture/audit-chain-format.md. Changing the
 * encoding changes the format, which requires a new epoch and a new
 * identifier.
 */
export const AUDIT_HASH_FORMAT = "fieldwise-sha256-v1";

const utf8 = new TextEncoder();

/**
 * Condition a string so the value that gets hashed and the value that gets
 * stored can never disagree. A writer applies this ONCE, to the value it feeds
 * both `computeEntryHash` and its own persistence.
 *
 * An unpaired UTF-16 surrogate is a legal JavaScript string and a legal JSON
 * string, and it has no UTF-8 encoding at all. Hash such a value in memory,
 * write it to a SQLite TEXT column, and the bytes that come back are not the
 * bytes that were hashed. The recomputed digest then never matches the stored
 * one, and the row is self-inconsistent on disk — unrepairable afterwards,
 * because the text that was hashed is gone. A verifier reports that as
 * tampering, which is the one verdict it must not give for a value a caller
 * merely typed.
 *
 * The two sides substitute differently, which is what makes them disagree.
 * Hashing already conditions its input: `computeEntryHash` converts to UTF-8,
 * and that conversion collapses each unpaired surrogate to a single U+FFFD —
 * exactly what this function does. The column does not agree, yielding one
 * U+FFFD per invalid byte (measured: `a\uD800b` stores as five code points,
 * not three). So the fix is not to condition the hash input, which changes no
 * digest; it is to condition the value the writer PERSISTS, so the stored text
 * is the text that was hashed. One conditioned value, used for both.
 *
 * This is a write-path rule, not a format rule. `AUDIT_HASH_FORMAT` is
 * unchanged and the published vectors do not move: every entry hashes to the
 * digest it always would have, and an independent verifier still reads the
 * stored text and re-hashes it verbatim. What changes is only which strings
 * can reach a hashed column.
 */
export function wellFormed(value: string): string {
  return value.toWellFormed();
}

/**
 * Length-prefix a field for the hash input: `<len>:<value>` where `len` is the
 * value's UTF-8 byte count. That is the same encoding `createHash().update()`
 * applies to the concatenated string below, so the *framing* is UTF-8-native: a
 * verifier in any language reproduces the field boundaries by measuring bytes,
 * with no JavaScript-specific length quirk to replicate.
 *
 * The framing is portable; the field values are not always. Numeric values
 * serialize via `String(Number)`, and a cross-language verifier must reproduce
 * that formatting, not only measure bytes. The serialization rules and the
 * float hazard are specified for re-implementers in
 * docs/architecture/audit-chain-format.md (engine docs), alongside its test
 * vectors; verify-chain.ts is the shipped verifier that recomputes these
 * hashes.
 *
 * Concatenating these frames is injective — given the concatenation you recover
 * the field sequence uniquely (read decimal digits to the first `:`, then take
 * exactly that many bytes). So no field value, however it is chosen, can shift a
 * boundary into a neighbour and collide with a different tuple. A
 * bare separator like `|` cannot promise this: `noun="a|b", tool="c"` and
 * `noun="a", tool="b|c"` join to the same string.
 */
export function frameField(value: string | number): string {
  const s = String(value);
  return `${utf8.encode(s).length}:${s}`;
}

/**
 * The 20 fields that join the entry hash, in a named shape so a verifier's
 * input type (verify-chain.ts's `ChainEntry`) grows with the hash input rather
 * than drifting from it. Field ORDER in the hash input is fixed by
 * computeEntryHash below, not by this interface.
 */
export interface EntryHashFields {
  epochId: string;
  sequenceNum: number;
  prevHash: string;
  id: string;
  timestamp: string;
  userId: string;
  agentId: string;
  sessionId: string;
  origin: string;
  service: string;
  verb: string;
  noun: string;
  toolName: string;
  parametersMetadata: string;
  decision: string;
  outcome: string;
  errorMessage: string | null;
  decisionEntryId: string | null;
  latencyMs: number;
  costUsd: number | null;
}

/**
 * Compute SHA-256 hash of an audit entry's fields.
 * Uses node:crypto (synchronous) so it can run inside transactionSync().
 * Each field is length-prefixed (see frameField) so field boundaries are
 * unambiguous even for LLM-controlled fields (noun, parametersMetadata) that
 * can contain the framing characters. Changing this encoding changes the hash
 * format, which per footguns.md requires a new epoch.
 *
 * Every persisted, semantically-meaningful column joins the hash so a stored
 * row cannot be edited without breaking the chain. Notably
 * `errorMessage` — the sole record of *why* a call was denied or failed, and
 * the only discriminator of a `session.end` reason (timeout/kill/quit/…) — and
 * the `userId`/`sessionId` attribution fields.
 *
 * Deliberately excluded from the hash, each for a reason:
 * - `hash` itself — it is the digest output.
 * - `epochPrevHash` — the cross-epoch link is verified separately by comparing
 *   a genesis entry's `epoch_prev_hash` against the prior epoch's final hash, so
 *   it is already tamper-evident. Keeping it out of the entry hash preserves the
 *   bounded, single-epoch GDPR mid-epoch recompute (see audit-log.md); folding
 *   it in would cascade a redaction forward across every later epoch.
 * - `parametersContent` — always null at launch (content capture is opt-in and
 *   deferred). It joins the hash when that feature lands, alongside its
 *   encryption and redaction design; adding it now would bake in a framing
 *   choice before the feature that gives it meaning exists.
 *
 * A null value frames identically to an empty string (`0:`); for these fields
 * both denote absence and carry no distinct meaning, and any change to a
 * meaningful value alters the frame and breaks the chain.
 */
export function computeEntryHash(fields: EntryHashFields): string {
  const data = [
    fields.epochId,
    fields.sequenceNum,
    fields.prevHash,
    fields.id,
    fields.timestamp,
    fields.userId,
    fields.agentId,
    fields.sessionId,
    fields.origin,
    fields.service,
    fields.verb,
    fields.noun,
    fields.toolName,
    fields.parametersMetadata,
    fields.decision,
    fields.outcome,
    fields.errorMessage ?? "",
    fields.decisionEntryId ?? "",
    fields.latencyMs,
    fields.costUsd ?? "",
  ]
    .map(frameField)
    .join("");

  return createHash("sha256").update(data).digest("hex");
}
