// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HabenulaEnv } from "./env";
import type { ProviderEnv } from "@habenula-ai/tools";

type AssertExtends<A extends B, B> = A;

/**
 * Compile-time drift guard: the engine's `HabenulaEnv` must satisfy
 * the structural `ProviderEnv` contract @habenula-ai/tools declares for its
 * OAuth provider strategies (the per-provider client id/secret slots).
 *
 * The engine already passes its full `env` to every `beginAuth` / `exchangeCode`
 * (src/index.ts) and refresh (`REFRESH_FNS[service](old, this.env)` in
 * UserAgent) call, so structural compatibility is enforced incidentally at each
 * call site. Naming it here localizes the failure to one place and matches the
 * `OAuthStateDriftGuard` in oauth/types.ts: if a strategy adds a client-secret
 * field to `ProviderEnv` that the engine's env lacks, or a var is renamed on
 * one side only, this fails to compile instead of surfacing at the call site.
 *
 * One direction only: the engine env is a superset (it also carries bindings,
 * the encryption key, and non-OAuth vars), so `ProviderEnv extends
 * HabenulaEnv` is intentionally not asserted.
 */
export type ProviderEnvDriftGuard = AssertExtends<HabenulaEnv, ProviderEnv>;
