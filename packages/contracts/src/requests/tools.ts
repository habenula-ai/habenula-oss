// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField, wellFormedString } from "./common.js";

/**
 * `POST /api/tools/execute` body. A debug-gated surface: the engine serves
 * the route only when it runs with `DEBUG_MODE=true` (fail-closed;
 * otherwise 404). A debugging surface, never an intended feature — test
 * harnesses are its caller, and the agent's own conversation is how tools
 * run in the product.
 *
 * `toolName` is the only field with an explicit
 * failure message today (`"toolName is required"`), and the only one besides
 * `userId` that must be a well-formed string: it is written to a hashed audit
 * column, so a spelling the engine cannot record faithfully is refused instead
 * of substituted. `params` mirrors the
 * current `(body.params as Record<string, unknown>) ?? {}`: `??` folds both
 * `undefined` and an explicit `null` to `{}`, so — same reasoning as
 * `userIdField` — it is nullish + a transform, not `.optional().default()`
 * (which would reject `params: null`).
 */
export const ToolExecuteRequest = z.object({
  userId: userIdField,
  toolName: wellFormedString("toolName").min(1),
  params: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform((v) => v ?? {}),
});
