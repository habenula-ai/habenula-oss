// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { illFormedStringError, userIdField } from "./common.js";

/**
 * The highest settable cap, in cents ($1M) — the same ceiling the CLI's
 * dollars parser enforces, so every write path has one accept-set. The bound
 * keeps "there is always a real ceiling" true (a near-MAX_SAFE_INTEGER cap is
 * functionally no cap, and pushes the spend check's arithmetic toward the
 * precision edge).
 */
export const MAX_LIMIT_CENTS = 100_000_000;

/**
 * A stored spend limit is a non-negative integer count of cents
 * (amounts are integer minor units — never floats),
 * bounded above by MAX_LIMIT_CENTS.
 */
const limitCentsField = z.number().int().nonnegative().max(MAX_LIMIT_CENTS);

/**
 * `POST /api/settings` body. Sets one or both spend limits; a field omitted
 * leaves that limit as it stands. An empty update is rejected at the contract
 * so the route never performs a write that changes nothing.
 */
export const SettingsUpdateRequest = z
  .object({
    userId: userIdField,
    monthLimitCents: limitCentsField.optional(),
    sessionLimitCents: limitCentsField.optional(),
  })
  .refine(
    (b) => b.monthLimitCents !== undefined || b.sessionLimitCents !== undefined,
    { message: "at least one of monthLimitCents or sessionLimitCents is required" },
  );

/**
 * Field-accurate 400s, matching the neighboring routes' convention: a userId
 * type failure names userId; everything else is a limits-shape failure. The
 * ill-formed case is checked first, because it is also a `userId` issue and
 * "must be a string" would not describe it — the value was a string.
 */
export function settingsUpdateRequestError(error: z.ZodError): string {
  const illFormed = illFormedStringError(error);
  if (illFormed) return illFormed;
  const hasUserIdIssue = error.issues.some((issue) => issue.path[0] === "userId");
  return hasUserIdIssue
    ? "userId must be a string"
    : `monthLimitCents/sessionLimitCents must be non-negative integer cents (max ${MAX_LIMIT_CENTS}), and at least one is required`;
}
