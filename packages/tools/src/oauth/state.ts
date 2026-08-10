// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers for the OAuth `state` parameter format, `${userId}:${randomPart}`.
 * Provider-agnostic, like pkce.ts: the connect entry packs the state, and the
 * callback and the mock's consent page unpack it to find the user's DO.
 */

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseOAuthState(
  fullState: string | null,
): { userId: string; randomPart: string } | null {
  if (!fullState) return null;
  const colonIdx = fullState.indexOf(":");
  if (colonIdx <= 0) return null;
  return {
    userId: fullState.slice(0, colonIdx),
    randomPart: fullState.slice(colonIdx + 1),
  };
}
