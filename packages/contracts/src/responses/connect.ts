// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `POST /connect/{service}` — the single connect entry: an OAuth service
 * returns the provider `authorizeUrl` to open plus the `flow` handle the
 * client polls and cancels by; a credential-less service
 * reports `connected`. An unknown service name is a 400 `ErrorResponse`
 * with `error_code: "UNKNOWN_SERVICE"`.
 */
export const ConnectResponse = z.union([
  z.strictObject({ authorizeUrl: z.string(), flow: z.string() }),
  z.strictObject({ connected: z.string() }),
]);
export type ConnectResponse = z.infer<typeof ConnectResponse>;

/**
 * `GET /api/connect/status?userId&service&flow` — the per-flow status read
 * behind the connect wait loop. A coarse enum only: no
 * provider error prose, no verifier, no credential material.
 */
export const ConnectFlowStatusResponse = z.strictObject({
  status: z.enum(["pending", "connected", "denied", "expired"]),
});
export type ConnectFlowStatusResponse = z.infer<
  typeof ConnectFlowStatusResponse
>;

/**
 * `POST /api/connect/cancel` — drop a pending connect flow. Idempotent 200:
 * `cancelled` reports whether a pending row existed, an observability/test
 * signal no client branches on.
 */
export const ConnectCancelResponse = z.strictObject({
  cancelled: z.boolean(),
});
export type ConnectCancelResponse = z.infer<typeof ConnectCancelResponse>;
