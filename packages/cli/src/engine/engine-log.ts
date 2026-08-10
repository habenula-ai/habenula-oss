// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { openSync, renameSync, unlinkSync } from "node:fs";

import type { EnginePaths } from "./paths";

/**
 * The engine log's three-generation rotation and the fresh descriptor the
 * spawn's stdio takes. Both are called only by the branch that spawns, in
 * that order: the branches that start nothing leave every generation
 * untouched, because a rename does not follow the descriptor a live daemon is
 * already writing to — rotating under a running engine would leave the file
 * the user is told to read as the one nothing writes to.
 *
 * Three generations because a crash loop is diagnosed from the first failure,
 * not the last: a daemon that fails, restarts, and fails again has already
 * overwritten a single log.
 */
export const LOG_GENERATIONS = 3;

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function unlinkIgnoringAbsent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

function renameIgnoringAbsent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

/** Shift each generation up one, newest first; what falls off the end is discarded. */
export function rotateEngineLog(paths: EnginePaths): void {
  const [gen1, gen2, gen3] = paths.rotatedLogPaths;
  unlinkIgnoringAbsent(gen3);
  renameIgnoringAbsent(gen2, gen3);
  renameIgnoringAbsent(gen1, gen2);
  renameIgnoringAbsent(paths.logPath, gen1);
}

/**
 * Open the fresh log for the spawn's stdio. The caller owns closing the
 * returned descriptor once spawn has returned (the child holds its own
 * duplicate from that moment) — on the throw path too, so a failed spawn does
 * not leave `up` holding a descriptor on a log it is about to report on.
 */
export function openEngineLog(paths: EnginePaths): number {
  return openSync(paths.logPath, "w", 0o600);
}
