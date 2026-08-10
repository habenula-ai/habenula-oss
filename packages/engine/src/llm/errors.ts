// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A retryable upstream LLM failure — the selected provider was unreachable,
 * overloaded (`529`), rate-limited (`429`), timed out, or returned a `5xx`.
 * The API error boundary (`index.ts`) maps this to a structured `503`
 * "the assistant is temporarily unavailable — please try again", distinct from
 * an unexpected internal `500`, so a transient outage mid-turn reads as
 * retryable rather than as a bug.
 *
 * Engine-owned (no vendor SDK type) so the boundary can classify on it without
 * importing any SDK: each adapter knows its own provider's failure shape and
 * wraps it into this.
 */
export class UpstreamLLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamLLMError";
  }
}

/** The user-facing message every adapter's retryable wrap carries. */
export const UPSTREAM_UNAVAILABLE_MESSAGE =
  "The assistant is temporarily unavailable";

/**
 * The upstream answered, and its answer was unusable: tool-call arguments that
 * are not valid JSON, arguments that are valid JSON but not an object, a body
 * carrying no message at all, a `200` whose body is not JSON.
 *
 * Distinct from `UpstreamLLMError`, and the seam between them is *how* the
 * upstream failed, not how severe it was. A status-level failure (unreachable,
 * `429`, `5xx`) is time-dependent, so "temporarily unavailable, try again" is
 * true. A content-level failure is not. Retrying can still land, because a
 * model is stochastic and the next sample may be valid JSON. But waiting is
 * not what fixes it, and an endpoint that returns HTML repeats forever. So the
 * message points at the other side of the wire: for a self-hoster the fix is
 * their runtime, not patience.
 *
 * Neither is a `500`. Both mean something on the other side of the wire
 * misbehaved, and the engine's `500` rate is the signal for the engine's own
 * bugs — a deployment behind a chatty local model must not page on someone
 * else's malformed JSON. This matters most for exactly the audience the
 * provider-agnostic backend exists to serve.
 */
export class UpstreamResponseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamResponseError";
  }
}

/** The user-facing message every adapter's unusable-response wrap carries. */
export const UPSTREAM_INVALID_RESPONSE_MESSAGE =
  "The assistant returned a response Habenula could not use";

/**
 * The shared retryable-status contract, encoded once so the adapters
 * cannot drift: no HTTP status at all (connection failure / timeout), `408`,
 * `429`, or any `5xx` is a retryable upstream condition. Any other status is
 * a malformed request — our bug — and propagates unwrapped.
 */
export function isRetryableLLMStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}
