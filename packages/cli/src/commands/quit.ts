// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient } from "../api-client";

/**
 * End the active session (`POST /api/session/quit`) — the explicit
 * counterpart to the 90-minute timeout. Session-scoped
 * grants expire with the session and the slot frees for a fresh start;
 * connections and credentials are untouched (that's `kill`'s domain, and
 * even kill preserves them). Available top-level so a user can free a stuck
 * slot from another terminal without entering the REPL — useful under the
 * attach-on-refusal launch model. Mirrors `kill.ts`.
 */
export async function runQuit(client: ApiClient): Promise<number> {
  const { ended } = await client.quit();
  if (ended) {
    console.log("Session ended — grants expired, slot freed for a new session.");
  } else {
    console.log("No active session to end.");
  }
  return 0;
}
