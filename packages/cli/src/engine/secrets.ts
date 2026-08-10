// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SlotClaim } from "./run-record";
import { stated } from "./stated";

/**
 * First-run secret generation and the guards that keep it from destroying
 * existing state. A store and the key that wrote it are bound: a generated
 * second key makes every credential in that store permanently unreadable, so
 * every guard here refuses rather than guesses.
 */

/** 32 random bytes as hex — the 64-hex-character format the engine's own credential guard requires. */
export function generateCredentialKey(): string {
  return randomBytes(32).toString("hex");
}

/** 16 random bytes as hex — the drive-token size the runbook already uses. */
export function generateDriveToken(): string {
  return randomBytes(16).toString("hex");
}

export interface GenerationInputs {
  env: Record<string, string | undefined>;
  fileVars: Record<string, string> | null;
  /** The persist root (guard 3 inspects `<root>/do`). */
  root: string;
  /** The config path, named in the guard 4 refusal. */
  configPath: string;
  /**
   * The working directory's `.env`, parsed once by runUp and passed here —
   * this module may not read `process`, so it has no cwd to resolve the file
   * against. `null` when the file is absent OR malformed: it is not our file,
   * and refusing on it would block a start for a syntax error in a file `up`
   * does not own.
   */
  cwdEnvVars: Record<string, string> | null;
}

export interface GeneratedSecrets {
  credentialKey?: string;
  driveToken?: string;
}

/**
 * Evaluate the generation guards and return either a refusal or the secrets
 * to generate (only the ones absent from both the environment and the config
 * file — a secret with a source is never re-generated and never persisted).
 *
 * `claim` is never read. It is required so that guard 0 — generation happens
 * only on the branch that spawns, only after the run slot is claimed — is a
 * type error to skip: `claimRunSlot` is the only constructor of a SlotClaim,
 * so no branch that starts nothing can reach this function.
 */
export function checkGenerationGuards(
  claim: SlotClaim,
  inputs: GenerationInputs,
): { refusal: string } | { values: GeneratedSecrets } {
  void claim;
  const { env, fileVars, root, configPath, cwdEnvVars } = inputs;

  const values: GeneratedSecrets = {};

  // Guards 1 and 2: the key has a source — nothing to generate, nothing to
  // check. A source is a STATED value: a blank export or a bare `KEY=` line
  // read as "already have one" would skip generation and hand the empty string
  // to the daemon, which is this file guessing in the one direction it must not.
  const keyInEnv = stated(env.CREDENTIAL_ENCRYPTION_KEY) !== undefined;
  const keyInFile = stated(fileVars?.CREDENTIAL_ENCRYPTION_KEY) !== undefined;
  if (!keyInEnv && !keyInFile) {
    // Guard 3: a persist root with state and no recorded key is a refusal —
    // the daemon persists DO SQLite under <root>/do, so that directory is the
    // signal that a store exists which some key already wrote.
    if (existsSync(join(root, "do"))) {
      return {
        refusal:
          `habenula up: ${root} holds engine state, and no encryption key is recorded for it. ` +
          `Set CREDENTIAL_ENCRYPTION_KEY to the key that wrote it, or move ${root} aside to start fresh.`,
      };
    }
    // Guard 4: a working-directory .env carrying the key is the
    // self-host-runbook user; generating would quietly mint a second key.
    if (stated(cwdEnvVars?.CREDENTIAL_ENCRYPTION_KEY) !== undefined) {
      return {
        refusal:
          `habenula up: ./.env declares CREDENTIAL_ENCRYPTION_KEY and ${configPath} does not. ` +
          "Generating a second key would make credentials stored under the first unreadable. " +
          `Export it, or copy it into ${configPath}.`,
      };
    }
    values.credentialKey = generateCredentialKey();
  }

  // The drive token generates whenever it is absent from both sources —
  // guard 4 covers the credential key only, because a mismatched token costs
  // a 401 and nothing else.
  const tokenInEnv = stated(env.INTERNAL_MCP_TOKEN) !== undefined;
  const tokenInFile = stated(fileVars?.INTERNAL_MCP_TOKEN) !== undefined;
  if (!tokenInEnv && !tokenInFile) {
    values.driveToken = generateDriveToken();
  }

  return { values };
}
