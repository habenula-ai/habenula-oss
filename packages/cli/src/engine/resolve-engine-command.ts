// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * How `up` finds an engine to spawn. Four steps, first hit wins:
 *
 *   1. HABENULA_ENGINE_CMD — an explicit command line, split on whitespace
 *      into an argv and never handed to a shell.
 *   2. HABENULA_ENGINE_BIN — one exact path to an engine entry file, run with
 *      the injected Node binary. The unscoped `habenula` package sets it to the
 *      engine inside its own install, which is the only way that engine can be
 *      named on every install shape: npm links a dependency's bin into
 *      node_modules/.bin for an npx or project-local install, but a global
 *      install links the top-level package's bin alone, so step 3 would find
 *      nothing and step 4 would re-fetch an engine already on disk. Not a
 *      command line: it holds a single path, so a path with a space in it
 *      survives, and Windows needs no shebang.
 *   3. `habenula-engine` on PATH — a global engine install.
 *   4. `npx --yes @habenula-ai/engine@<exact version>` — the npm on-ramp.
 *
 * The version in step 4 is inlined at build time (see build.mjs); a source run
 * (tsx, vitest, tsc) sees the define as undefined and falls back to a value
 * the gate below refuses — the honest answer for a contributor's clone, which
 * has no published engine to resolve.
 */
export const ENGINE_VERSION: string =
  typeof __HBN_ENGINE_VERSION__ === "undefined"
    ? "0.0.0-source"
    : __HBN_ENGINE_VERSION__;

export function resolveEngineCommand(
  env: Record<string, string | undefined>,
  /** The running Node binary, injected — this module may not read `process`. */
  nodePath: string,
): { argv: string[] } | { refusal: string } {
  const explicit = env.HABENULA_ENGINE_CMD?.trim();
  if (explicit !== undefined && explicit !== "") {
    return { argv: explicit.split(/\s+/) };
  }

  // A value that names no readable file moves the walk on rather than ending
  // it, the same discipline findOnPath keeps below: the setter is the umbrella
  // forwarder, not a person, so a stale value must not be able to refuse a
  // command an engine on PATH could still serve.
  const carried = env.HABENULA_ENGINE_BIN?.trim();
  if (carried !== undefined && carried !== "" && isFile(carried)) {
    return { argv: [nodePath, carried] };
  }

  const onPath = findOnPath(env.PATH);
  if (onPath !== null) return { argv: [onPath] };

  // The version gate covers step 4 only: steps 1 through 3 name a binary
  // somebody installed, and `up` runs what it is pointed at. The gate stops
  // `up` from FETCHING a placeholder from the registry and calling it an engine.
  if (ENGINE_VERSION.startsWith("0.0.0") || ENGINE_VERSION.includes("-bootstrap")) {
    return {
      refusal:
        `habenula up: no local engine was found, and the published engine this CLI pins (${ENGINE_VERSION}) ` +
        "is a placeholder rather than a release. Install an engine and put habenula-engine on your PATH, " +
        "or set HABENULA_ENGINE_CMD to a local build.",
    };
  }
  return { argv: ["npx", "--yes", `@habenula-ai/engine@${ENGINE_VERSION}`] };
}

/** A readable regular file — no exec bit needed; step 2 runs it with Node. */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk PATH for an executable `habenula-engine`. The test is the executable
 * bit (X_OK, what `which` itself tests) on a regular file — `existsSync` would
 * resolve a stray note, a partial download, or a directory of that name, and
 * `up` would spawn it and report a boot failure for a file that was never an
 * engine. A failed candidate moves the walk on rather than ending it.
 */
function findOnPath(pathValue: string | undefined): string | null {
  for (const entry of (pathValue ?? "").split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "habenula-engine");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
