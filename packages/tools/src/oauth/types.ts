// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The OAuth state payload a provider strategy receives at `exchangeCode`. The
 * engine stores it on the per-user DO's `oauth_state` row; the shape here is
 * the provider-facing contract, declared structurally so this package stays
 * free of the engine's data layer. The engine's `oauth/types.ts` carries a
 * compile-time drift guard asserting its DDL-generated row shape and this
 * contract stay mutually assignable.
 *
 * `created_at` and `expires_at` are ISO-8601 UTC strings
 * (`Date.toISOString()`, e.g. `2026-07-29T17:00:00.000Z`).
 */
export interface OAuthStateData {
  code_verifier: string;
  code_challenge: string;
  service: string;
  auth_code: string | null;
  created_at: string;
  expires_at: string;
  status: "denied" | null;
}
