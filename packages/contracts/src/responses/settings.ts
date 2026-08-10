// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `GET /api/settings` and the `POST /api/settings` echo.
 * Both spend limits with their defaults-applied flags, plus the current
 * window sums so one read renders `habenula cap` in full. Amounts are integer
 * cents; `sessionSpentCents` is 0 when no session is active. `isDefault`
 * marks a limit no stored key backs — the shipped default in force.
 */
export const SettingsResponse = z.strictObject({
  monthLimitCents: z.number().int().nonnegative(),
  sessionLimitCents: z.number().int().nonnegative(),
  monthIsDefault: z.boolean(),
  sessionIsDefault: z.boolean(),
  monthSpentCents: z.number().int().nonnegative(),
  sessionSpentCents: z.number().int().nonnegative(),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;
