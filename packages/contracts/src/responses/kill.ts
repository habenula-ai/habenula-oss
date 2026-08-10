// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `POST /api/kill`. Deny-all on governance state only: connected services and
 * their credentials survive a kill, so `killed` is the entire
 * body — there is no `disconnected` field.
 */
export const KillResponse = z.strictObject({
  killed: z.literal(true),
});
export type KillResponse = z.infer<typeof KillResponse>;
