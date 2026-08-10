// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * First accessors for the `user_settings` table (vestigial until
 * it became the durable home for spend limits). Limits live
 * here deliberately, never in `policy_entries` — entries there are
 * session-mortal, so a ceiling stored beside them would evaporate on session
 * timeout, a fail-open in the one direction that matters.
 */
import {
  DEFAULT_MONTHLY_LIMIT_CENTS,
  DEFAULT_SESSION_LIMIT_CENTS,
} from "@habenula-ai/governance";
import type { EngineSql } from "./types";

export const SPEND_LIMIT_MONTHLY_KEY = "spend_limit_monthly_cents";
export const SPEND_LIMIT_SESSION_KEY = "spend_limit_session_cents";

export interface SpendLimitsRead {
  sessionLimitCents: number;
  monthLimitCents: number;
  /** True when no stored key exists and the shipped default applies. */
  sessionIsDefault: boolean;
  monthIsDefault: boolean;
}

export function getSetting(sql: EngineSql, key: string): string | null {
  const rows = [
    ...sql<{ value: string }>`
      SELECT value FROM user_settings WHERE key = ${key} LIMIT 1
    `,
  ];
  return rows[0]?.value ?? null;
}

export function setSetting(sql: EngineSql, key: string, value: string): void {
  sql`
    INSERT INTO user_settings (key, value) VALUES (${key}, ${value})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `;
}

/**
 * A stored limit must be a non-negative integer count of cents; anything else
 * (absent, non-numeric, negative, fractional) reads as the shipped default.
 * Falling back is the fail-safe direction: the default is conservative and
 * ships enabled, so a corrupt value can never widen the ceiling to "none".
 */
function parseLimitCents(value: string | null): number | null {
  if (value === null) return null;
  // Strict decimal digits: `Number("")` is 0 and `Number("1e5")` is 100000,
  // neither of which reads as a stored cents count.
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/** Both spend limits, defaults applied for absent or malformed keys. */
export function readSpendLimitsCents(sql: EngineSql): SpendLimitsRead {
  const stored = new Map<string, string>();
  for (const row of sql<{ key: string; value: string }>`
    SELECT key, value FROM user_settings
    WHERE key IN (${SPEND_LIMIT_MONTHLY_KEY}, ${SPEND_LIMIT_SESSION_KEY})
  `) {
    stored.set(row.key, row.value);
  }
  const month = parseLimitCents(stored.get(SPEND_LIMIT_MONTHLY_KEY) ?? null);
  const session = parseLimitCents(stored.get(SPEND_LIMIT_SESSION_KEY) ?? null);
  return {
    monthLimitCents: month ?? DEFAULT_MONTHLY_LIMIT_CENTS,
    sessionLimitCents: session ?? DEFAULT_SESSION_LIMIT_CENTS,
    monthIsDefault: month === null,
    sessionIsDefault: session === null,
  };
}
