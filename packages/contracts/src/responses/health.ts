// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The fixed engine identifier — the single source of truth for the value.
 * The engine route imports this const; the CLI type-binds a local literal
 * against `HealthResponse["engine"]`. Neither package re-declares the string
 * independently, so the discriminant cannot drift across the three packages.
 */
export const ENGINE_ID = "habenula-engine";

/**
 * `GET /api/health` — the engine liveness probe. The
 * `status` and `engine` literals are the discriminant, asserted by value: a
 * vacuous `{}` — or a stray 200 from an unrelated server at a mistyped URL —
 * must fail the CLI's shape check rather than read as a reachable engine.
 *
 * Deliberately carries no build version. The route is unauthenticated and a
 * hosted deploy exposes it to the open internet, and the spec's security
 * posture is that it reveals only that *an engine is serving* — nothing
 * to fingerprint. A future version-skew check adds the field back behind auth
 * when a consumer actually gates on it; the CLI reads nothing beyond the
 * discriminant today.
 */
export const HealthResponse = z.strictObject({
  status: z.literal("ok"),
  engine: z.literal(ENGINE_ID),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
