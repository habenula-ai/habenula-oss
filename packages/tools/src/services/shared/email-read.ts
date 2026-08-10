// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shared read-body truncation contract: every mail service's read tool
 * returns a body bounded the same way, so identical governed reads behave
 * identically across services (the cross-service posture
 * EMAIL_LIST_MAX_RESULTS_CEILING sets for list/search).
 */

/**
 * Ceiling on the body characters a read returns. The body flows into the LLM
 * context and the provider APIs have no server-side bound — a pathological
 * megabyte HTML body must not blow the context (or the token budget) on one
 * read. `maxResults` bounds list/search the same way; this is read's bound.
 */
export const EMAIL_READ_BODY_MAX_CHARS = 25_000;

/**
 * Truncate a read body to the shared ceiling. A body at or under the ceiling
 * passes through untouched; an oversized one is cut at the ceiling and marked.
 */
export function truncateEmailBody(body: string): string {
  if (body.length <= EMAIL_READ_BODY_MAX_CHARS) {
    return body;
  }
  let kept = body.slice(0, EMAIL_READ_BODY_MAX_CHARS);
  // A cut landing mid-surrogate-pair (an astral character, e.g. emoji) would
  // leave a lone high surrogate at the boundary; drop it.
  const lastCode = kept.charCodeAt(kept.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    kept = kept.slice(0, -1);
  }
  // The marker tells the model the cut happened, so it can say so instead of
  // presenting a silently amputated message as complete.
  return `${kept}\n[... body truncated: ${String(body.length - kept.length)} of ${String(body.length)} characters omitted]`;
}
