// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { illFormedStringError, userIdField } from "./common.js";

/**
 * `POST /api/resolve` body. Three fields carry explicit failure messages today,
 * checked in this order: an ill-formed `userId` first, then `heldCallId`, then
 * `choice`. For the latter two, `resolveRequestError` maps a parse failure back
 * to the same message the hand-rolled guard produced, preserving that priority.
 */
// `approve_once` is the spend hold's affirmative answer:
// it dispatches the parked money-verb call exactly once and mints nothing.
// The engine rejects it on an ordinary hold, and rejects the grant-minting
// choices on a spend hold — the restriction is engine-side, never a UI's.
export const RESOLVE_CHOICES = [
  "deny",
  "tell_more",
  "task",
  "session",
  "approve_once",
] as const;

const HELD_CALL_ID_REQUIRED = "heldCallId is required";
const CHOICE_INVALID = `choice must be one of: ${RESOLVE_CHOICES.join(", ")}`;

export const ResolveRequest = z.object({
  userId: userIdField,
  heldCallId: z.string().min(1),
  choice: z.enum(RESOLVE_CHOICES),
});

/**
 * Preserve the hand-rolled guard's message and ordering: a missing/empty
 * `heldCallId` reports before an invalid `choice`, matching the two sequential
 * `if` checks the handler used before this schema. An ill-formed `userId`
 * reports ahead of both: when it is the only failing field, neither default
 * message would be true — and checking it first is the one rule every route
 * shares, rather than a per-route priority.
 */
export function resolveRequestError(error: z.ZodError): string {
  const illFormed = illFormedStringError(error);
  if (illFormed) return illFormed;
  const hasHeldCallIdIssue = error.issues.some(
    (issue) => issue.path[0] === "heldCallId",
  );
  return hasHeldCallIdIssue ? HELD_CALL_ID_REQUIRED : CHOICE_INVALID;
}
