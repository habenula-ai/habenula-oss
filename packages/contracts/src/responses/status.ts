// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { ActiveSessionView } from "./session.js";

/**
 * `GET /api/status` — the aggregate governed-session view the rich CLI status
 * and the reactive confirmation prompt read.
 * Returns session + active grants + every pending held call as a
 * single atomic snapshot from one DO invocation, so the three are never
 * observed in inconsistent states across separate round-trips.
 */

/**
 * One active grant, as `GET /api/status` reports it. Filtered to
 * `source IN ('session','task')` — the `standing` default-deny floor is not a
 * grant and is never rendered here. The `noun` is the raw grant-key noun: it
 * is unvalidated on the read path, so the CLI byte-
 * sanitizes it before display and flags it when sanitization altered its bytes.
 */
export const GrantView = z.strictObject({
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  source: z.enum(["session", "task"]),
  expiresAt: z.string().nullable(),
});
export type GrantView = z.infer<typeof GrantView>;

/**
 * One pending held call as a render-ready record: its derived
 * `(service, verb, noun)` and the actual tool parameters, so the user can see
 * exactly what they are approving. The record is credential-free (Hard
 * Invariant #1) — `params` are tool arguments, never a token.
 *
 * `params` is a deliberately open record (arbitrary tool arguments), so
 * strictness holds on the envelope but not inside `params`. The `noun` is
 * unvalidated on the read path — the CLI
 * sanitizes it at render.
 *
 * `origin` / `goal` come from the `run_id → commission_runs` join: a
 * held call linked to a commission run carries `origin: "mcp_commission"` and
 * the run's `goal`. Both are absent on a CLI-direct hold (no `run_id`). `goal`
 * is external-agent-authored text — the CLI sanitizes it at render like the
 * noun. `origin` is a closed enum, so a client can trust its shape.
 */
export const HeldCallRecord = z.strictObject({
  heldCallId: z.string(),
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  params: z.record(z.string(), z.unknown()),
  origin: z.enum(["mcp_commission"]).optional(),
  // Bounded to mirror the ingest cap (`COMMISSION_GOAL_MAX_CHARS = 4000`), so the
  // one external-agent-authored field on this envelope is self-defending at the
  // contract, not only at render (the CLI additionally truncates at display).
  goal: z.string().max(4000).optional(),
  // Present on a spend hold: the priced amount, why the
  // call is held, and each breached window with its limit and running total.
  // Amounts are integer cents, engine-computed — trusted chrome at render.
  // `amountCents` is null when the call could not be priced (`unpriced`).
  spend: z
    .strictObject({
      amountCents: z.number().int().nullable(),
      /**
       * A short human-readable description of what is being bought, so the
       * confirmation names the order and not only its price. Engine-derived
       * from the service's own bound quote (never raw model text), bounded to
       * keep the envelope small. Absent when the service supplies none.
       */
      summary: z.string().max(120).optional(),
      reason: z.enum(["over_limit", "unpriced", "totals_unavailable"]),
      breaches: z.array(
        z.strictObject({
          window: z.enum(["session", "month"]),
          limitCents: z.number().int(),
          spentCents: z.number().int(),
        }),
      ),
    })
    .optional(),
});
export type HeldCallRecord = z.infer<typeof HeldCallRecord>;

/**
 * The audit chain's tail entry — the newest row's `hash` and `prevHash`, or
 * null for an empty log. Metadata only: two hashes,
 * no parameters, no content. `prevHash` is non-nullable — the chain's first
 * entry carries the GENESIS sentinel, never NULL. This is the ungated read
 * the self-host persistence proof pairs with `/api/services`: an unchanged
 * tail across a restart proves preservation, and a later entry whose
 * `prevHash` equals the pre-restart tail proves extension. It carries no row
 * count by design — an unfiltered COUNT(*) is O(rows) on this frequently
 * polled surface, and the hashes already prove what a count cannot.
 */
export const AuditTail = z
  .strictObject({ hash: z.string(), prevHash: z.string() })
  .nullable();
export type AuditTail = z.infer<typeof AuditTail>;

/**
 * `GET /api/status` — session (reusing the `ActiveSessionView`, computed
 * with the same server-side expiry math), active grants, every pending held
 * call, and the audit-chain tail, in one atomic snapshot. `held` lists every
 * parked call genuinely awaiting a decision, oldest first — the first entry
 * is the next one to answer. The engine parks at most one confirmation per
 * task, but several tasks can each own one, so the list can hold several. A
 * parked row that is not yet renderable (empty `turn_state`) is omitted;
 * `auditTail` is null only while the audit log is empty.
 */
export const StatusResponse = z.strictObject({
  session: ActiveSessionView.nullable(),
  grants: z.array(GrantView),
  held: z.array(HeldCallRecord),
  auditTail: AuditTail,
});
export type StatusResponse = z.infer<typeof StatusResponse>;
