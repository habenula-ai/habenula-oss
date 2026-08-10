// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `GET /api/audit` — one page of the audit chain, in the chain's own total
 * order (`epochId` then `sequenceNum`), newest first, for client-side
 * verification.
 *
 * `AuditChainEntry` is the wire shape of one row: the 20 hashed fields plus
 * the two hash-excluded columns a verifier needs (`hash`, `epochPrevHash`),
 * camelCase, VERBATIM — values as stored, no projection. It is deliberately
 * distinct from `AuditEntryRecord`, the visual-model snapshot's display
 * projection, which drops `userId` and `epochPrevHash`: a projection cannot
 * be verified, so the two shapes are not merged.
 *
 * Two rules keep the shape verifiable:
 * - `parametersMetadata` travels as the stored STRING. It holds JSON text,
 *   and that exact text is what joined the hash — a shape that parsed it
 *   would hand the verifier a value it has to re-serialize, and a
 *   re-serialization is not guaranteed to be the same bytes.
 * - Null and `""` are distinct on the wire and must stay distinct through any
 *   dump and reload, so every nullable field says so — for two different
 *   reasons. The three nullable HASH INPUTS (`errorMessage`,
 *   `decisionEntryId`, `costUsd`) coerce null to `""` before framing, so the
 *   two frame identically inside the hash — but a round-trip that coerced one
 *   into the other, or null into the string "null", would recompute to a
 *   different digest and report a false chain break. `epochPrevHash` is NOT a
 *   hash input (computeEntryHash deliberately excludes it); it feeds the
 *   separate cross-epoch link check, where null is positional — genesis of a
 *   log's first epoch — so corrupting it forges or severs an epoch link
 *   rather than breaking a frame.
 *
 * `decision`/`outcome`/`origin` are plain strings rather than the display
 * enums: a verifier recomputes over whatever vocabulary the writer stored,
 * and the row must reach it verbatim.
 */
export const AuditChainEntry = z.strictObject({
  epochId: z.string(),
  sequenceNum: z.number(),
  prevHash: z.string(),
  id: z.string(),
  timestamp: z.string(),
  userId: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  origin: z.string(),
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  toolName: z.string(),
  parametersMetadata: z.string(),
  decision: z.string(),
  outcome: z.string(),
  errorMessage: z.string().nullable(),
  decisionEntryId: z.string().nullable(),
  latencyMs: z.number(),
  costUsd: z.number().nullable(),
  hash: z.string(),
  epochPrevHash: z.string().nullable(),
});
export type AuditChainEntry = z.infer<typeof AuditChainEntry>;

/**
 * The page envelope: `entries` newest first, and `nextCursor` as the opaque
 * keyset token for the next-older page (pass back as `?cursor=`), null when
 * this page reaches the chain's oldest retained row.
 */
export const AuditListResponse = z.strictObject({
  entries: z.array(AuditChainEntry),
  nextCursor: z.string().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;
