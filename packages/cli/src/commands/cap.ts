// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient } from "../api-client";
import { dollars } from "../render/money";

export interface CapOptions {
  /** New monthly limit in cents (already parsed from dollars at the option). */
  monthlyCents?: number;
  /** New session limit in cents. */
  sessionCents?: number;
}

/**
 * `habenula cap` — show both spending limits (marking shipped defaults) and
 * the current window sums; with `--monthly`/`--session`, set them first
 * (dollars in at the flag, integer cents on the wire).
 */
export async function runCap(
  client: ApiClient,
  opts: CapOptions = {},
): Promise<number> {
  const wantsWrite =
    opts.monthlyCents !== undefined || opts.sessionCents !== undefined;
  const settings = wantsWrite
    ? await client.setSpendLimits({
        ...(opts.monthlyCents !== undefined
          ? { monthLimitCents: opts.monthlyCents }
          : {}),
        ...(opts.sessionCents !== undefined
          ? { sessionLimitCents: opts.sessionCents }
          : {}),
      })
    : await client.getSettings();

  if (wantsWrite) {
    console.log("Spending caps updated.");
  }
  const mark = (isDefault: boolean): string => (isDefault ? " (default)" : "");
  console.log("Spending caps (spending is counted when an order is placed):");
  console.log(
    `  monthly  ${dollars(settings.monthLimitCents)}${mark(settings.monthIsDefault)} — spent ${dollars(settings.monthSpentCents)} this month`,
  );
  console.log(
    `  session  ${dollars(settings.sessionLimitCents)}${mark(settings.sessionIsDefault)} — spent ${dollars(settings.sessionSpentCents)} this session`,
  );
  return 0;
}
