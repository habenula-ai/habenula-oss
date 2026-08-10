// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `GET /api/dev/contracts` — the wire contract, described: one entry per
 * contract-bound route with its query, request, and response schema rendered as
 * JSON Schema. Dev-only (same `VISUAL_MODEL` gate as the visual
 * model page, whose edge-detail panel is the consumer). The schema blobs are
 * genuinely opaque here — they are *produced from* the Zod schemas at
 * runtime, so pinning their internal shape would just restate zod's
 * `toJSONSchema` output.
 *
 * `query` and `request` describe the two ways a route takes input, and they are
 * separate fields rather than one field plus a "where does it live" marker.
 * `request` keeps meaning exactly one thing — a body — so a reader that has
 * never heard of `query` loses the query schema instead of misreading it as a
 * body it should POST.
 */
export const RouteContractDescriptor = z.strictObject({
  route: z.string(),
  method: z.string(),
  /**
   * JSON Schema of the query string (input side); null when the route reads no
   * query parameters. Nullable rather than optional on purpose: every row
   * states this, so "reads no parameters" cannot be confused with "this table
   * does not say".
   */
  query: z.record(z.string(), z.unknown()).nullable(),
  /** JSON Schema of the request body (input side); null when there is no body. */
  request: z.record(z.string(), z.unknown()).nullable(),
  /** JSON Schema of the response body. */
  response: z.record(z.string(), z.unknown()),
});
export type RouteContractDescriptor = z.infer<typeof RouteContractDescriptor>;

export const ContractDescriptorsResponse = z.strictObject({
  routes: z.array(RouteContractDescriptor),
});
export type ContractDescriptorsResponse = z.infer<
  typeof ContractDescriptorsResponse
>;
