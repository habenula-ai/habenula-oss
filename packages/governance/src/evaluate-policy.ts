// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PolicyAction, PolicyEntry, PolicyDecision } from "./policy.js";

function entryMatch(entry: PolicyEntry, action: PolicyAction): boolean {
  // Wildcard hardening: `*` is honored only for a deny
  // entry. An allow entry carrying `*` in any position can never match — the
  // only legitimate `*/*/*` row is the `default-deny` floor. This closes the
  // "permanent allow" surface removed in this phase: even if a wildcard-allow
  // row were somehow minted, the evaluator refuses to honor it. Deny keeps
  // wildcard matching so the floor (and any future broad deny) still applies.
  const allowsWildcard = entry.decision === "deny";
  if (entry.service === "*") {
    if (!allowsWildcard) return false;
  } else if (entry.service !== action.service) {
    return false;
  }
  if (entry.verb === "*") {
    if (!allowsWildcard) return false;
  } else if (entry.verb !== action.verb) {
    return false;
  }
  if (entry.noun === "*") {
    if (!allowsWildcard) return false;
  } else if (entry.noun.toLowerCase() !== action.noun.toLowerCase()) {
    return false;
  }
  return true;
}

/**
 * Evaluate a policy decision for one action against an **already-filtered** entry
 * set. Pure function (Hard Invariant #2): it matches only on service/verb/noun
 * (plus the wildcard/priority rules here) and ranks by priority.
 *
 * It deliberately does **not** read `entry.sessionId` or `entry.expiresAt` —
 * session scoping and expiry are **caller preconditions**, not evaluated here.
 * The engine enforces them in the SQL that assembles the entry set
 * (`selectActivePolicyEntries`), so only the active session's unexpired grants
 * ever reach this function. Pass an unfiltered set and a foreign or expired
 * `allow` WILL be honored — the pure evaluator has no notion of "now" or
 * "current session". OSS consumers must apply that filter before calling.
 */
export function evaluatePolicy(
  entries: PolicyEntry[],
  action: PolicyAction,
): PolicyDecision {
  const matched = entries.filter((e) => entryMatch(e, action));

  // Fail closed on a corrupt policy set. If any MATCHED entry carries a
  // non-finite priority (null, undefined, NaN — or any non-number), the
  // priority ordering the deny-floor guarantee depends on is undefined for this
  // action, so we deny outright rather than rank corrupt input. This is
  // symmetric by construction: a malformed allow cannot win, and a malformed
  // deny cannot be silently demoted below a finite allow. Coercing a malformed
  // priority to -Infinity would cover only the first — it sinks a malformed
  // deny beneath finite allows, itself a fail-OPEN.
  //
  // Malformed priorities cannot be stored (DB `NOT NULL` + `CHECK`), so this is
  // unreachable through the write path. But `evaluatePolicy` is the OSS-
  // published pure function (Hard Invariant #2): its contract is to fail closed
  // on ANY input, on every DO regardless of age, independent of how entries
  // were assembled. `source: "malformed"` is distinct from "implicit"/floor, so
  // the caller hard-denies (never offers a confirmation) and the audit log
  // records the corruption.
  if (matched.some((e) => !Number.isFinite(e.priority))) {
    return { decision: "deny", source: "malformed" };
  }

  const sorted = matched.sort((a, b) => {
    // Primary key: higher priority wins (an explicit higher-priority allow
    // still overrides a lower-priority deny, and vice versa). Every priority
    // here is finite — the short-circuit above rejected the rest — so the
    // subtraction can never yield NaN.
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Tie-break: on EQUAL priority, deny wins — fail-closed. Without
    // this the stable sort would hand an equal-priority allow/deny conflict to
    // whichever entry the caller happened to list first, so the same inputs in
    // a different order could flip the decision. Unreachable on `main` today
    // (the only priorities in play are 0/deny-floor and 10/allow-grant), but
    // the OSS-published evaluator is a pure function (Hard Invariant #2) whose
    // contract must be defined before a deny-grant or per-agent model lands.
    const denyRank = (e: PolicyEntry): number => (e.decision === "deny" ? 0 : 1);
    return denyRank(a) - denyRank(b);
  });

  const match = sorted[0];
  if (!match) {
    return { decision: "deny", source: "implicit" };
  }
  return {
    decision: match.decision,
    source: match.source,
    entryId: match.id,
  };
}
