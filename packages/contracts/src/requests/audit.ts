// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { limitParam, userIdField } from "./common.js";

/**
 * `GET /api/audit` query parameters.
 *
 * Plain `z.object` like every request schema (accept-set posture; strictness
 * is a response-side decision). `limit` is clamped inside the DO; `cursor` is
 * the opaque keyset token from a prior page's `nextCursor`. The
 * blank-`limit`-is-absent rule lives in `limitParam`, shared with the task
 * queue's page.
 */
export const AuditListRequest = z.object({
  userId: userIdField,
  limit: z.number().optional(),
  cursor: z.string().nullish(),
});
export type AuditListRequest = z.infer<typeof AuditListRequest>;

/** Parse `GET /api/audit`'s query string. */
export function parseAuditListQuery(params: URLSearchParams): AuditListRequest {
  return AuditListRequest.parse({
    userId: params.get("userId"),
    limit: limitParam(params),
    cursor: params.get("cursor"),
  });
}
