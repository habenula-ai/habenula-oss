// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { ChatResponse } from "./chat.js";

/**
 * `POST /api/resolve` — resolving a held tool call. Only the shapes the
 * handler ships as a *result*: `info` (tell_more — the call stays parked) and
 * `resumed` (the conversation continued; `result` is a full chat turn). The
 * internal variants never reach the wire as results — the handler maps
 * `not_found` to a 404 and `invalid_choice` (a choice that does not apply to
 * the hold's kind) to a 400 `ErrorResponse`.
 */
export const ResolveResponse = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("info"),
    metadata: z.strictObject({
      service: z.string(),
      verb: z.string(),
      noun: z.string(),
      description: z.string(),
    }),
  }),
  z.strictObject({
    status: z.literal("resumed"),
    result: ChatResponse,
  }),
]);
export type ResolveResponse = z.infer<typeof ResolveResponse>;
