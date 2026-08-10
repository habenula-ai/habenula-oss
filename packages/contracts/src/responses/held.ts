// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The parked-call handle a client passes back to `POST /api/resolve`. One
 * shared definition: `ChatResponse.held` and `ExecuteToolResponse.held` carry
 * the same wire concept, and a shared schema keeps the two endpoints from
 * drifting apart if the reference ever gains a field.
 */
export const HeldRef = z.strictObject({
  heldCallId: z.string(),
});
export type HeldRef = z.infer<typeof HeldRef>;
