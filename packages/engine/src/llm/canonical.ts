// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The canonical-shape version and the persisted held-turn envelope.
 *
 * The `llm/types.ts` shapes are the Habenula-owned canonical form every
 * provider adapter maps to and from. A held turn is persisted as
 * canonical-shaped state (`HeldTurnState`) and must survive a deploy, so the
 * stored blob carries this version: a future canonical change bumps
 * `CANONICAL_SHAPE_VERSION`, adds its upgrade step to `migrateHeldTurn`, and
 * resume already knows to look. The version lives inside the `turn_state`
 * JSON — the column stays TEXT, no SQLite migration.
 */

import type { HeldTurnState } from "./conversation";

/**
 * Version of the canonical LLM shape (`llm/types.ts` block set + the
 * `HeldTurnState` built from it). Bump on any change to the persisted shape,
 * and add the corresponding upgrade arm to `migrateHeldTurn`.
 */
export const CANONICAL_SHAPE_VERSION = 1;

/** The `held_tool_calls.turn_state` envelope written at every persist site. */
export interface PersistedHeldTurn {
  v: number;
  state: HeldTurnState;
}

export type ParsedTurnState =
  /** Readable state, already migrated to the current canonical version. */
  | { ok: true; state: HeldTurnState }
  /**
   * `unparseable`: not JSON, or JSON that is neither an envelope nor a bare
   * legacy `HeldTurnState` object — same handling as today's corrupt-row
   * guards (not_found / not renderable / false).
   *
   * `future_version`: a valid envelope stamped by NEWER code (e.g. after a
   * rollback). Fails safe — the hold is unresumable and must be denied +
   * audited rather than mis-parsed.
   */
  | { ok: false; reason: "unparseable" | "future_version" };

/** Serialize a held turn as the versioned envelope. */
export function wrapTurnState(state: HeldTurnState): string {
  const envelope: PersistedHeldTurn = { v: CANONICAL_SHAPE_VERSION, state };
  return JSON.stringify(envelope);
}

/**
 * Parse a persisted `turn_state` blob, whatever vintage wrote it.
 *
 * - `{ v, state }` envelope at the current version → the state, verbatim.
 * - A bare object with no `v` is a legacy row written before the envelope
 *   existed — read as v0 and run through `migrateHeldTurn`.
 * - `v > CANONICAL_SHAPE_VERSION` → `future_version` (fail safe, never
 *   mis-parse).
 *
 * Structural validity of the state itself (e.g. `heldCall` present) stays at
 * the call sites, which already guard it per their own semantics.
 */
export function parseTurnState(raw: string): ParsedTurnState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "unparseable" };
  }
  if (!("v" in parsed)) {
    // Legacy pre-envelope row: the bare HeldTurnState is version 0.
    return { ok: true, state: migrateHeldTurn(0, parsed as HeldTurnState) };
  }
  const envelope = parsed as { v: unknown; state?: unknown };
  // `v` must be a non-negative integer — a fractional, negative, or NaN stamp
  // is corruption, not a version. Screening it HERE keeps the no-throw
  // contract: every read site dropped its try/catch on the promise that
  // parseTurnState never throws, and a poison row reaching migrateHeldTurn's
  // fail-loud arm would wedge the chat guard and abort the reap transaction.
  if (
    typeof envelope.v !== "number" ||
    !Number.isInteger(envelope.v) ||
    envelope.v < 0 ||
    typeof envelope.state !== "object" ||
    envelope.state === null
  ) {
    return { ok: false, reason: "unparseable" };
  }
  if (envelope.v > CANONICAL_SHAPE_VERSION) {
    return { ok: false, reason: "future_version" };
  }
  return { ok: true, state: migrateHeldTurn(envelope.v, envelope.state as HeldTurnState) };
}

/**
 * Upgrade a held turn from the version that wrote it to the current canonical
 * version, as a stepwise cascade: each arm upgrades exactly one version and
 * falls into the next, so an old row chains through every later migration
 * automatically when `CANONICAL_SHAPE_VERSION` bumps — no arm is ever
 * re-pointed by hand. v0 → v1 is identity: the envelope was introduced
 * without changing the block set, so legacy state is already current-shaped
 * and the "migration" is the version stamp the next persist writes.
 */
export function migrateHeldTurn(
  fromVersion: number,
  state: HeldTurnState,
): HeldTurnState {
  // parseTurnState screens non-integer/negative/future stamps, so this throw
  // is a dev-time assertion against calling with a version no arm covers.
  if (
    !Number.isInteger(fromVersion) ||
    fromVersion < 0 ||
    fromVersion > CANONICAL_SHAPE_VERSION
  ) {
    throw new Error(`No migration path from turn_state version ${fromVersion}`);
  }
  const migrated = state;
  // v0 → v1: identity (block set unchanged by the envelope's introduction).
  // A future v1 → v2 arm chains here:
  //   if (fromVersion <= 1) migrated = upgradeV1toV2(migrated);
  return migrated;
}
