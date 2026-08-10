// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shipped default limits. The cap ships enabled: an absent settings key reads as
 * these, so there is no window in which a money verb exists without a ceiling.
 * $50/month matches the Level 3 example published in governance.md
 * (`monthly_limit_usd: 50`); $20/session is a deliberate fraction so the
 * breach path is reachable in a two-order demo without configuration.
 */
export const DEFAULT_MONTHLY_LIMIT_CENTS = 5000;
export const DEFAULT_SESSION_LIMIT_CENTS = 2000;

/** The two spending windows. Both are queries over one ledger, never counters. */
export type SpendWindow = "session" | "month";

export interface SpendLimits {
  sessionLimitCents: number;
  monthLimitCents: number;
}

/**
 * Running totals summed by the caller from the spend ledger. `null` means the
 * caller could not read the ledger — a distinct input, because folding it into
 * "within" is a fail-open and folding it into "exceeds" bricks the agent on a
 * storage fault.
 */
export interface SpendTotals {
  sessionSpentCents: number;
  monthSpentCents: number;
}

export interface SpendCheckInput {
  /** The bound quote's total for the call being checked, in integer cents. */
  amountCents: number;
  limits: SpendLimits;
  totals: SpendTotals | null;
}

export interface SpendBreach {
  window: SpendWindow;
  limitCents: number;
  spentCents: number;
}

export type SpendCheckResult =
  | { result: "within" }
  | { result: "exceeds"; breaches: SpendBreach[] }
  | { result: "unavailable" };

/**
 * Evaluate one quoted amount against both spending windows. Pure function,
 * held to the same discipline as `evaluatePolicy` (Hard Invariant #2's block
 * shape, widened to this file in eslint.config.mjs): no I/O, no Date — the
 * month boundary is the caller's to compute when it assembles `totals`.
 *
 * It deliberately does not read the ledger, the clock, or the settings store.
 * Totals and limits arrive as values; whether they are fresh is a caller
 * precondition (limits are read at each check, never cached — a lowered cap
 * must bind the next call).
 *
 * Fail-closed on malformed input: any amount, limit, or total that is not a
 * non-negative SAFE INTEGER makes the comparison undefined — fractional cents
 * violate the integer-minor-units invariant, and past 2^53 the
 * `spent + amount` addition itself loses precision — so the result is
 * "unavailable", which the engine resolves to a hold that asks the user,
 * never a silent allow and never a hard deny. This mirrors evaluatePolicy's
 * malformed-priority posture: corrupt input is never ranked.
 */
export function evaluateSpend(input: SpendCheckInput): SpendCheckResult {
  const { amountCents, limits, totals } = input;

  if (totals === null) {
    return { result: "unavailable" };
  }

  const values = [
    amountCents,
    limits.sessionLimitCents,
    limits.monthLimitCents,
    totals.sessionSpentCents,
    totals.monthSpentCents,
  ];
  if (values.some((v) => !Number.isSafeInteger(v) || v < 0)) {
    return { result: "unavailable" };
  }

  const breaches: SpendBreach[] = [];
  if (totals.sessionSpentCents + amountCents > limits.sessionLimitCents) {
    breaches.push({
      window: "session",
      limitCents: limits.sessionLimitCents,
      spentCents: totals.sessionSpentCents,
    });
  }
  if (totals.monthSpentCents + amountCents > limits.monthLimitCents) {
    breaches.push({
      window: "month",
      limitCents: limits.monthLimitCents,
      spentCents: totals.monthSpentCents,
    });
  }

  if (breaches.length > 0) {
    return { result: "exceeds", breaches };
  }
  return { result: "within" };
}
