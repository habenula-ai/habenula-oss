// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { ActiveSessionView } from "./session.js";
import { HeldCallRecord } from "./status.js";
import { PolicyEntry } from "./policy.js";

/**
 * `GET /api/dev/model` — one atomic, sanitized snapshot of a user's governed
 * state: session, policy entries, every pending held call, commission runs,
 * connected services, and the recent audit chain.
 *
 * Product-neutral by design: the dev visual-model page is the first consumer,
 * a hosted customer-facing governance view is the explicitly-seen second.
 * Records ship with their real foreign keys
 * (`sessionId`, `runId`, `decisionEntryId`) and no graph/layout vocabulary —
 * each consumer derives its own edges.
 *
 * Sanitization is by construction: credential material and `oauth_state`
 * secrets have no field to occupy (those two tables appear in `tableCounts`
 * only), audit parameters are the metadata summary, and externally-authored
 * text (`goal`, nouns) remains untrusted — consumers sanitize at render.
 */

/**
 * One policy entry from the evaluator's ACTIVE set (unconsumed, unexpired),
 * standing deny-floor included — unlike `GrantView` (which filters to
 * grants), the snapshot shows the whole live policy surface so default-deny
 * is visible. A consumed task grant simply leaves the set — its record lives
 * on in the audit chain. Extends the `GET /api/policy` entry with its
 * session join.
 */
export const PolicyEntryRecord = PolicyEntry.extend({
  sessionId: z.string().nullable(),
});
export type PolicyEntryRecord = z.infer<typeof PolicyEntryRecord>;

/**
 * One pending held call with its joins exposed: the session it parks under,
 * when it was held, and the commission run that produced it (`runId`, null on
 * a CLI-direct hold). Params/noun/goal trust semantics are inherited from
 * `HeldCallRecord`.
 */
export const HeldCallDetailRecord = HeldCallRecord.extend({
  sessionId: z.string(),
  heldAt: z.string(),
  runId: z.string().nullable(),
});
export type HeldCallDetailRecord = z.infer<typeof HeldCallDetailRecord>;

/**
 * One commission run. `origin` is `mcp_commission` for an external-agent
 * commission or `human` for a user-initiated task.
 * `goal` is caller-authored (bounded to the 4000-char ingest cap; sanitize at
 * render); `data` is the client's verbatim slot map, serialized as stored.
 * The task-queue columns (`label`, `status_detail`, `awaited_slot_keys`) are
 * not surfaced on this snapshot shape yet.
 */
export const CommissionRunRecord = z.strictObject({
  id: z.string(),
  origin: z.enum(["mcp_commission", "human"]),
  goal: z.string().max(4000),
  data: z.string().nullable(),
  status: z.enum([
    "running",
    "awaiting_confirmation",
    "completed",
    "failed",
    "denied",
    "expired",
    "needs_input",
    "cancelled",
  ]),
  sessionId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommissionRunRecord = z.infer<typeof CommissionRunRecord>;

/**
 * One connected service. `hasCredential` is the only credential-adjacent fact
 * that exists on this wire shape — the encrypted credential itself has no
 * field to leak into (Hard Invariant #1).
 */
export const ConnectedServiceRecord = z.strictObject({
  service: z.string(),
  connectedAt: z.string(),
  hasCredential: z.boolean(),
});
export type ConnectedServiceRecord = z.infer<typeof ConnectedServiceRecord>;

/**
 * One audit entry, metadata-only: `parametersMetadata` is the stored summary
 * string; parameter content never rides this shape. `hash`/`prevHash` are
 * included so a consumer can render the chain. `decisionEntryId` joins the
 * entry to the policy entry that decided it.
 */
export const AuditEntryRecord = z.strictObject({
  id: z.string(),
  epochId: z.string(),
  sequenceNum: z.number(),
  timestamp: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  decision: z.enum(["allow", "deny", "pending"]),
  outcome: z.enum(["success", "error", "timeout"]),
  origin: z.enum(["human", "mcp_commission"]),
  parametersMetadata: z.string(),
  errorMessage: z.string().nullable(),
  decisionEntryId: z.string().nullable(),
  latencyMs: z.number(),
  costUsd: z.number().nullable(),
  hash: z.string(),
  prevHash: z.string(),
});
export type AuditEntryRecord = z.infer<typeof AuditEntryRecord>;

/**
 * Row counts for every coordinator-DO table, `oauth_state` and
 * `user_settings` included — those two appear here and nowhere else on the
 * snapshot. The one deliberately engine-flavored corner of the shape;
 * consumers that don't care ignore it.
 */
export const TableCounts = z.strictObject({
  auditLog: z.number(),
  connectedServices: z.number(),
  userSettings: z.number(),
  oauthState: z.number(),
  policyEntries: z.number(),
  heldToolCalls: z.number(),
  commissionRuns: z.number(),
  sessionState: z.number(),
  spendLedger: z.number(),
});
export type TableCounts = z.infer<typeof TableCounts>;

/**
 * The snapshot envelope. `audit` and `commissions` are `{ recent, total }`
 * (bounded windows, newest first) so pagination or cursoring can arrive
 * additively later; `generatedAt` is the DO's clock at read time. The whole
 * envelope is produced in a single DO invocation with no intervening await,
 * so every field observes the same instant.
 */
export const GovernanceSnapshotResponse = z.strictObject({
  userId: z.string(),
  generatedAt: z.string(),
  session: ActiveSessionView.nullable(),
  policyEntries: z.array(PolicyEntryRecord),
  // Every pending held call, oldest first — mirrors `StatusResponse.held`.
  held: z.array(HeldCallDetailRecord),
  commissions: z.strictObject({
    recent: z.array(CommissionRunRecord),
    total: z.number(),
  }),
  connectedServices: z.array(ConnectedServiceRecord),
  audit: z.strictObject({
    recent: z.array(AuditEntryRecord),
    total: z.number(),
  }),
  tableCounts: TableCounts,
});
export type GovernanceSnapshotResponse = z.infer<
  typeof GovernanceSnapshotResponse
>;
