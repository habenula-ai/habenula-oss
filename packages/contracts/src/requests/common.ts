// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The key every ill-formed-string refinement stamps into its issue `params`.
 * Construction and detection share it, so the two cannot drift — and detection
 * is structural, never a match on message text, so the message is free to be
 * reworded without breaking any route's 400 mapping.
 */
const ILL_FORMED_KEY = "illFormed";

/**
 * A request string that reaches a hashed audit column, refused rather than
 * silently rewritten when it is not well-formed UTF-16.
 *
 * An unpaired surrogate is a legal JSON string with no UTF-8 encoding, so a
 * writer cannot store the bytes it hashed. `wellFormed` in `@habenula-ai/audit`
 * conditions the value at the write path and keeps the chain verifiable, which
 * is the invariant-level rule and holds for every writer including the model.
 * This refinement is the other half, and it answers a different question: what
 * the engine tells a caller who sent one. Conditioning alone answers `200` and
 * records a value the caller did not send.
 *
 * For `userId` that is not cosmetic. Every unpaired surrogate encodes to the
 * same replacement bytes, so `"a\uD800b"` and `"a\uD801b"` condition to one
 * string and name one Durable Object — two spellings silently merged into one
 * subject, on a value that is both the routing key and a hashed column.
 * Refusing keeps the rule that distinct request strings name distinct subjects.
 * A caller who genuinely wants U+FFFD in an identifier can still spell it; what
 * is refused is only the form that cannot be spelled back.
 *
 * The query schemas need no such guard and get it for free. `URLSearchParams`
 * returns a scalar value string, so a percent-encoded surrogate arrives already
 * replaced by the URL decoder and can never fail this check — which is why the
 * throwing `parse*Query` helpers stay throwing.
 */
export function wellFormedString(field: string) {
  return z.string().refine((v) => v.isWellFormed(), {
    message: `${field} must not contain an unpaired surrogate`,
    params: { [ILL_FORMED_KEY]: true },
  });
}

/**
 * The ill-formed message from a parse failure that has one, else `null`. Every
 * route's 400 consults this first, so an ill-formed `userId` reports itself
 * rather than borrowing the message of whichever other field the route names by
 * default (`"service is required"` for a request whose `service` was fine).
 * Matching on the `params` marker, not `code: "custom"` alone, matters: other
 * refinements produce `custom` issues too (the settings at-least-one-limit
 * rule), and those must keep reporting their own messages.
 */
export function illFormedStringError(error: z.ZodError): string | null {
  return (
    error.issues.find(
      (issue) => issue.code === "custom" && issue.params?.[ILL_FORMED_KEY] === true,
    )?.message ?? null
  );
}

/**
 * Shared `userId` field. Every POST handler today reads
 * `(body.userId as string | undefined) ?? "demo-user"`, and `??` folds BOTH
 * `undefined` and an explicit `null` to `"demo-user"`. `.optional()` only
 * catches `undefined`, so an explicit `userId: null` would fail the string
 * check and 400 — a real accept-set regression. `.nullish()` admits null too,
 * but `.default()` fires only on `undefined` (null would parse through as
 * `null` and mis-route the DO). So the faithful form is nullish + a transform
 * that reproduces `?? "demo-user"` exactly, for undefined and null alike
 * (preserve behavior).
 *
 * It serves the query schemas below for the same reason: `URLSearchParams.get`
 * returns `string | null`, so a missing parameter arrives as `null` and has to
 * fold to the same default the body path folds it to.
 *
 * The string it admits is a well-formed one: `userId` is the DO routing key and
 * a hashed audit column, so an ill-formed spelling is refused at the boundary
 * rather than conditioned into a value the caller did not send. See
 * `wellFormedString` above for why that is the answer for this field.
 */
export const userIdField = wellFormedString("userId")
  .nullish()
  .transform((v) => v ?? "demo-user");

/**
 * The query shape of every route whose only parameter is `?userId=` — most of
 * the read surface, plus the connect entry (whose inputs are the `{service}`
 * path segment and this parameter, never a body).
 *
 * A query schema exists so a descriptor row can publish it: a route that reads
 * `?userId=` and publishes nothing says the same thing as a route that reads no
 * parameters at all, which is the drift this package's query schemas close.
 */
export const UserIdQuery = z.object({ userId: userIdField });
export type UserIdQuery = z.infer<typeof UserIdQuery>;

/** Parse a `?userId=`-only query string. */
export function parseUserIdQuery(params: URLSearchParams): UserIdQuery {
  return UserIdQuery.parse({ userId: params.get("userId") });
}

/**
 * The `?limit=` rule, written once for every paged read that has one.
 *
 * A missing, blank, or non-numeric `limit` parses to `undefined` so the DO
 * falls back to its own default. Blank is the case worth naming: `Number("")`
 * is 0, which is finite and would clamp to a one-row page, so `?limit=` with
 * no value has to read as absent rather than as "give me one row".
 */
export function limitParam(params: URLSearchParams): number | undefined {
  const raw = params.get("limit");
  const parsed = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
