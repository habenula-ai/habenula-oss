// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { parseEnvFile, serializeEnvFile } from "./env-file";

/**
 * The config file's filesystem seam: read, exclusive first create, and the
 * absent-keys-only merge. Every write lands at 0600 — the file holds secrets
 * and never leans on the directory's mode.
 */

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/**
 * Read and parse the config file. Returns null only for a file that does not
 * exist; every other error propagates, because an unreadable config is not an
 * absent one — it may hold the only copy of a credential key, and guessing
 * "absent" here is the dangerous direction. A malformed line throws
 * ConfigFileError (see env-file.ts).
 */
export function readConfigFile(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return null;
    throw err;
  }
  return parseEnvFile(text, path);
}

/**
 * Create the config file exclusively (`wx`, 0600). Returns whether this caller
 * won the create; on EEXIST the caller re-reads the file that now exists and
 * continues from those values rather than overwriting them.
 */
export function createConfigFile(
  path: string,
  vars: Record<string, string>,
): boolean {
  try {
    writeFileSync(path, serializeEnvFile(vars), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
}

/**
 * Add to an existing config file only the keys it does not already hold. A key
 * already present is never overwritten — that is what keeps a hand-edited
 * value from being clobbered by a later start — and the existing text is kept
 * verbatim (comments included), with the new keys appended.
 *
 * The rewrite goes through a temporary name and a rename, so a concurrent
 * reader sees the old file or the new one and never a truncated one. The temp
 * suffix is random rather than a pid because this module may not touch
 * `process`; a random suffix collides no more than a pid does and needs no
 * process identity. A no-op merge writes nothing.
 *
 * The rename lands on the *resolved* path, and keeps the file's own mode. A
 * rename replaces an inode, so writing over the link would silently turn a
 * symlinked config into a regular file — and a user who linked this path at the
 * `.env` their container already reads (the shared-config story) would get two
 * files that drift apart from then on, with no error at either end. Resolving
 * first also keeps the temp file a sibling of the real target, so the rename
 * stays same-filesystem and atomic.
 */
export function mergeAbsentKeys(
  path: string,
  vars: Record<string, string>,
): void {
  const target = realpathSync(path);
  const mode = statSync(target).mode & 0o777;
  const text = readFileSync(target, "utf8");
  const present = parseEnvFile(text, path);
  const absent: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    // hasOwn, not `in`: `in` reads an inherited Object.prototype name
    // (`constructor`, `toString`) as already present, so the merge would report
    // success having written nothing and lost the value.
    if (!Object.hasOwn(present, key)) absent[key] = value;
  }
  if (Object.keys(absent).length === 0) return;

  const base = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
  const tmpPath = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmpPath, base + serializeEnvFile(absent), {
    flag: "wx",
    // The file's own mode, not a fresh 0600: an operator who widened it to 0640
    // for a docker group keeps that, and a file this CLI created is already
    // 0600. Matches ensureRoot, which leaves an existing directory's mode alone.
    mode,
  });
  renameSync(tmpPath, target);
}
