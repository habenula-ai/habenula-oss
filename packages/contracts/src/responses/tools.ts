// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { HeldRef } from "./held.js";

/**
 * `POST /api/tools/execute` — a debug-gated surface, served only when the
 * engine runs with `DEBUG_MODE=true` (fail-closed; otherwise 404). The
 * shape is a deliberate narrowed projection of the engine's
 * internal `ExecuteToolResult`, not a mirror. The wire
 * carries the governance decision, the governed `(service, verb, noun)`, the
 * execution result, and the held-call id; the internal audit/governance fields
 * (`auditEntry`, `matchedEntryId`, `matchedSource`, `pendingAuditEntryId`)
 * never ship. The handler does the projection in explicit mapping code; the
 * engine's runtime contract test is the load-bearing guard for it.
 */
export const ExecuteToolResponse = z.strictObject({
  decision: z.enum(["allow", "deny", "pending"]),
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  /** Present only when the call executed (decision `allow`). `data` is the tool's opaque payload. */
  execution: z
    .strictObject({
      success: z.boolean(),
      data: z.unknown().optional(),
      error: z.string().optional(),
    })
    .optional(),
  /** Present only on decision `deny`. */
  denyReason: z
    .enum(["not_connected", "needs_authorization", "policy"])
    .optional(),
  /** Present only on decision `pending` — the parked call awaiting the user. */
  held: HeldRef.optional(),
});
export type ExecuteToolResponse = z.infer<typeof ExecuteToolResponse>;
