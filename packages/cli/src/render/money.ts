// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one money formatter for every CLI surface (amounts
 * are integer minor units on the wire, dollars only in user-facing copy).
 * Shared so the confirmation prompt and `habenula cap` can never disagree
 * about how a spending figure reads.
 *
 * Thousands are grouped: `$12500.00` is misread by a factor of ten exactly
 * where that matters most. Values are engine-computed integers — trusted
 * chrome, never agent-authored — so no sanitization is needed here.
 */
export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${whole.toLocaleString("en-US")}.${remainder}`;
}
