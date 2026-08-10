// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** One effective policy entry as `GET /api/policy` reports it. */
export const PolicyEntry = z.strictObject({
  id: z.string(),
  source: z.string(),
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  decision: z.enum(["allow", "deny"]),
  priority: z.number(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type PolicyEntry = z.infer<typeof PolicyEntry>;

/**
 * `GET /api/policy`. Read-only: the standing-allow mutate path
 * (POST /api/policy) was removed — grants are minted through
 * the confirmation flow.
 */
export const PolicyResponse = z.strictObject({
  effectiveDecision: z.enum(["allow", "deny"]),
  entries: z.array(PolicyEntry),
});
export type PolicyResponse = z.infer<typeof PolicyResponse>;
