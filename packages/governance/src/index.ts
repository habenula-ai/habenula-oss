// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of @habenula-ai/governance. The engine imports from this
// barrel; integration tests that drive the Durable Object import the same
// symbols and exercise them against real state. The `./*` subpath export lets
// a test reach a single module directly when it needs to.

// The pure policy evaluator (Hard Invariant #2).
export { evaluatePolicy } from "./evaluate-policy.js";
export type { PolicyAction, PolicyEntry, PolicyDecision } from "./policy.js";
export { WILDCARD_DENY_ID } from "./policy.js";

// The pure spend evaluator. Same discipline as
// evaluatePolicy: totals and limits are read in the engine and passed in as
// values — this function touches no ledger, clock, or settings store.
export {
  evaluateSpend,
  DEFAULT_MONTHLY_LIMIT_CENTS,
  DEFAULT_SESSION_LIMIT_CENTS,
} from "./evaluate-spend.js";
export type {
  SpendWindow,
  SpendLimits,
  SpendTotals,
  SpendCheckInput,
  SpendBreach,
  SpendCheckResult,
} from "./evaluate-spend.js";

// The audit hash chain, its verifier, and the decision-closure check live in
// @habenula-ai/audit. They are chain math over the log the engine writes, not
// decisions about what an agent may do, and they carry the one node:crypto
// dependency this package is free of.
