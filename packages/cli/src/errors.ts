// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, EngineUnavailableError } from "./api-client";

/**
 * The canonical engine-unavailable guidance: one
 * rendering for every surface — one-shot exit, REPL offline transition. The
 * `reject` variant names the engine as not reachable and says how to start
 * one; the `deadline` variant says it is not responding and may be starting
 * or busy — never that it is down, because a slow-but-alive engine trips its
 * deadline too.
 */
export function unavailableGuidance(
  apiUrl: string,
  kind: "reject" | "deadline",
): string {
  if (kind === "deadline") {
    return `error: engine not responding at ${apiUrl} — it may be starting up or busy; try again shortly.`;
  }
  return `error: engine not reachable at ${apiUrl} — start it with \`habenula up\`, or point HABENULA_API_URL at a running engine.`;
}

/**
 * The REPL's recovery announcement, keyed to the kind that drove the offline
 * transition: a deadline-driven offline may never have been a disconnect, so
 * its recovery must not narrate one.
 */
export function recoveryLine(kind: "reject" | "deadline"): string {
  return kind === "deadline" ? "Engine responding again." : "Engine connected.";
}

/**
 * The CLI's canonical error string (no trailing newline). An
 * `EngineUnavailableError` renders the availability guidance; `ApiError`
 * carries its HTTP status (`error (404): ...`); other errors render their
 * message. Single source of truth for the format — `printError` writes it via
 * `console.error`, and the top-level `wrap` in index.ts writes it to
 * `process.stderr` for the throw-to-exit path (which owns the exit code;
 * this owns only the string).
 */
export function formatError(err: unknown): string {
  if (err instanceof EngineUnavailableError) {
    return unavailableGuidance(err.apiUrl, err.kind);
  }
  if (err instanceof ApiError) {
    return `error (${err.status}): ${err.message}`;
  }
  if (err instanceof Error) {
    return `error: ${err.message}`;
  }
  return `error: ${String(err)}`;
}

/**
 * Print an error to stderr in the canonical format. Shared by the REPL loop
 * and the command runners so every surfaced error reads the same.
 */
export function printError(err: unknown): void {
  console.error(formatError(err));
}
