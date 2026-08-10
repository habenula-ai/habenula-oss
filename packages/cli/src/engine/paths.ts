// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { stated } from "./stated";

/**
 * Where the CLI's half of the local engine lives on disk: the persist root,
 * the shared config file, the run record, and the engine log with its rotated
 * generations. This is the single place the `~/.habenula` default is written
 * down on the CLI side; the daemon's loopback entry carries the same fallback,
 * and `up` still passes HABENULA_PERSIST_ROOT to the child explicitly so the
 * two defaults can never quietly diverge.
 *
 * Modules in this directory may not read `process` (the eslint block on
 * src/engine/** enforces it), so the environment arrives as an argument. That
 * is a safety property, not tidiness: a test that fell back to the real
 * environment would resolve the developer's live ~/.habenula and rotate their
 * engine state.
 */
export interface EnginePaths {
  /** The persist root — the directory the store, config, record, and log share. */
  root: string;
  /** The shared config file (HABENULA_CONFIG overrides; otherwise `<root>/config`). */
  configPath: string;
  /** The run record, `<root>/engine.json` — who started the daemon. */
  recordPath: string;
  /** The daemon's current log, `<root>/engine.log`. */
  logPath: string;
  /** The three rotated generations, newest first: `.log.1`, `.log.2`, `.log.3`. */
  rotatedLogPaths: [string, string, string];
}

export function resolveEnginePaths(
  env: Record<string, string | undefined>,
): EnginePaths {
  // A blank assignment is unset, not a stated root. `HABENULA_PERSIST_ROOT=`
  // from a script or a Docker env_file would otherwise make join("", "config")
  // collapse to the relative `config`, so the CLI would read whatever ./config
  // happens to be in the current directory and `up` would scatter the run
  // record and engine log there. A relative root does the same thing quietly,
  // so it is refused outright rather than resolved against the cwd — this
  // module may not read `process`, so there is no cwd here to resolve against.
  const root = stated(env.HABENULA_PERSIST_ROOT) ?? join(homedir(), ".habenula");
  if (!isAbsolute(root)) {
    throw new Error(
      `HABENULA_PERSIST_ROOT must be an absolute path — got \`${root}\`, which would put the config, run record, and engine log wherever the command was run from.`,
    );
  }
  const logPath = join(root, "engine.log");
  const namedConfig = stated(env.HABENULA_CONFIG);
  return {
    root,
    // The config follows a moved root unless it is named outright. A blank
    // assignment is unset here too, or the path would be "" — an ENOENT that
    // readConfigFile reads as "no config file", which is the silent-absence
    // answer this layer must never give. A *relative* named config is honoured,
    // unlike a relative root: this names one file the user picked, rather than a
    // directory the CLI writes several files into.
    configPath: namedConfig ?? join(root, "config"),
    recordPath: join(root, "engine.json"),
    logPath,
    rotatedLogPaths: [`${logPath}.1`, `${logPath}.2`, `${logPath}.3`],
  };
}

/**
 * Create the persist root at 0700 when it does not exist. An existing
 * directory's mode is left alone — changing the permissions on a directory the
 * user already has is not this command's business; every file written under it
 * carries its own 0600 instead of leaning on the directory.
 */
export function ensureRoot(paths: EnginePaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
}
