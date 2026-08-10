// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The uniform error envelope every /api/* endpoint emits on its error path —
 * one shared shape, not one per endpoint. `error_code`
 * is the machine-readable code callers branch on when present (e.g.
 * `UNKNOWN_SERVICE`); the human-readable `error` message is free to change
 * without breaking them.
 *
 * Selection is by return kind, not HTTP status: an endpoint whose non-2xx
 * body is a real result (the session-start 409 refusal) validates against its
 * result schema, never this envelope.
 */
export const ErrorResponse = z.strictObject({
  error: z.string(),
  error_code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
