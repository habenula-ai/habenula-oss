// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stated value, or undefined. A blank or whitespace-only assignment reads as
 * unset so it falls through to the next layer. `export HABENULA_X="$UNSET"` in a
 * wrapper script, or a Docker `env_file` line with nothing after the `=`, puts
 * an empty string in the environment — and treating that as a decision lets a
 * stray line shadow a good file value, or switch a security gate off.
 *
 * The same rule binds the config file, which parses `KEY=` to `""`: a blank
 * line there is a key the user has not set, not a key set to nothing.
 *
 * One function rather than a `?? ""` test at each site, because the sites that
 * forget it are the ones that fail quietly — a blank credential key that reads
 * as "already have one" skips generation and hands the empty string to the
 * daemon.
 */
export function stated(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
