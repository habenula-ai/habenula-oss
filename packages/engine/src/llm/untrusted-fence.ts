// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host-side untrusted-output fence.
 *
 * Output returned by downstream tool service providers is attacker-reachable
 * content (an email body, a webpage, a compromised provider's response). It
 * must enter the LLM context labeled as external data, never as instructions.
 * `fenceUntrusted` wraps such content in a delimited envelope; the system
 * prompt (see HABENULA_SYSTEM_PROMPT) tells the model the convention.
 *
 * The nonce IS the security property. A fixed delimiter is trivially forged:
 * injected content simply emits the closing tag and "resumes" as trusted
 * instructions — a boundary that isn't one is worse than none. A fresh
 * `crypto.randomUUID()` nonce per call is unpredictable to the content being
 * wrapped, so it cannot terminate its own envelope: a region opened with
 * nonce N ends only at the closing marker carrying the same N, and an
 * embedded close/open pair with any other nonce is still data. This is
 * labeling, not scanning — governance remains the actual
 * backstop against unpermitted actions.
 *
 * Known residual, accepted: the convention constrains markers *inside* an
 * open region, but content that reaches the model outside any region (the
 * goal, chat text) could emit an opening marker and start a fake fenced
 * span. The asymmetry is fail-safe — forging an OPEN can only get trusted
 * text treated as untrusted data (a downgrade), never the reverse, because
 * escaping a real region still requires the unpredictable nonce.
 */
/**
 * The marker prefixes are the single source of the convention: the system
 * prompt interpolates THESE constants into its description, so the emitted
 * markers and the convention the model is taught cannot drift apart.
 */
export const UNTRUSTED_OPEN_PREFIX = "<<habenula-untrusted-output ";
export const UNTRUSTED_CLOSE_PREFIX = "<<end-habenula-untrusted-output ";

export function fenceUntrusted(content: string): string {
  const nonce = crypto.randomUUID();
  return `${UNTRUSTED_OPEN_PREFIX}${nonce}>>\n${content}\n${UNTRUSTED_CLOSE_PREFIX}${nonce}>>`;
}
