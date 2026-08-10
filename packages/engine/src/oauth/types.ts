// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { OAuthStateData as ProviderOAuthStateData } from "@habenula-ai/tools";
import type { OAuthStateRow } from "../data/schemas/oauth-state";

/**
 * The stored state payload — every generated `oauth_state` column except the
 * `state_key` lookup key. Derived from the DDL-generated row schema so this
 * and the data-helper layer can never drift apart.
 */
export type OAuthStateData = Omit<OAuthStateRow, "state_key">;

type AssertExtends<A extends B, B> = A;

/**
 * Compile-time drift guard: the DDL-derived shape above and the structurally
 * declared provider contract in @habenula-ai/tools must stay the same type.
 * Change either without the other and one arm fails to compile.
 */
export type OAuthStateDriftGuard = [
  AssertExtends<OAuthStateData, ProviderOAuthStateData>,
  AssertExtends<ProviderOAuthStateData, OAuthStateData>,
];
