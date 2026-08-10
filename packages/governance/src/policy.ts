// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export interface PolicyAction {
  /**
   * The accountable agent making the request. Carried through to the audit
   * log, but NOT yet consumed by evaluatePolicy: in the current unified
   * model, policy_entries has no `agent` column, so matching is per-USER
   * (service/verb/noun), not per-AGENT. Per-agent isolation is
   * deferred to later work, which owns the grant model and will reintroduce
   * agent scoping. Until then, a grant made for
   * one agent is effective for every agent in the same user's DO.
   */
  agent: string;
  service: string;
  verb: string;
  noun: string;
  toolName: string;
  params: Record<string, unknown>;
}

export interface PolicyEntry {
  id: string;
  source: "session" | "task" | "standing";
  sessionId?: string;
  service: string;
  verb: string;
  noun: string;
  decision: "allow" | "deny";
  priority: number;
  createdAt: string;
  expiresAt?: string;
}

export interface PolicyDecision {
  // `pending` (confirmation flow) is a pipeline/audit decision, not
  // a stored permission row: PolicyEntry.decision stays allow|deny. This
  // widens the type only — evaluatePolicy does not return `pending` yet.
  decision: "allow" | "deny" | "pending";
  source: string;
  entryId?: string;
}

// The GET /api/policy wire shape formerly declared here (PolicyResult /
// PolicyEntryResult) lives in @habenula-ai/contracts as PolicyResponse /
// PolicyEntry — the handler binds to the contract directly.

export const WILDCARD_DENY_ID = "default-deny";
