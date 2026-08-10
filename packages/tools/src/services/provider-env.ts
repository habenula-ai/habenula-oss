// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OAuthProviderStrategy, ProviderEnv } from "./types.js";

/**
 * The provider's declared `requiredEnv` keys that this environment does not
 * supply, in declaration order. Empty means the provider is configured.
 *
 * A key that is present but blank counts as missing. `GOOGLE_CLIENT_ID=` with
 * no value is an easy `.env` slip, and a blank client id is rejected by the
 * authorization server exactly like an absent one — the same reasoning that
 * makes the engine's redirect-base resolution fall through an empty var.
 *
 * Lives beside the strategy interface rather than in the engine, so the package
 * that declares `requiredEnv` also owns what satisfying it means. Callers shape
 * the outcome: the engine turns a non-empty list into a refusal at the connect
 * entry, naming the vars it got back.
 */
export function missingProviderEnv(
  strategy: OAuthProviderStrategy,
  env: ProviderEnv,
): (keyof ProviderEnv)[] {
  // Read through an index signature: `env` types every slot as a required
  // `string`, so the absence this function exists to detect is invisible to
  // TypeScript at the property access.
  const vars = env as unknown as Record<string, string | undefined>;
  return strategy.requiredEnv.filter((key) => !vars[key]?.trim());
}
