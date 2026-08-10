// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { json } from "./http";

/**
 * Contract-bound response: the producer-side guard for every /api/* return.
 * The `z.infer<S>` parameter type is the
 * compile-time constraint — a handler emitting a shape the schema doesn't
 * describe fails tsc at the call site. The safeParse is boundary validation:
 * log-and-pass only, because it runs after the handler's side effect has
 * applied, so rejecting would convert an applied action into an error. The
 * body ships unchanged either way — `data` itself, never the parse output.
 *
 * Non-contract responses (the OPTIONS preflight, browser-facing OAuth
 * callback paths) stay on the plain `json()` helper.
 */
export function respond<S extends z.ZodType>(
  schema: S,
  data: z.infer<S>,
  status = 200,
): Response {
  const result = schema.safeParse(data);
  if (!result.success) {
    // eslint-disable-next-line no-console -- log-and-pass boundary telemetry: engine-bug signal only, never rejects.
    console.error("response contract violation", {
      status,
      issues: result.error.issues,
    });
  }
  return json(data, status);
}
