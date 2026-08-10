//! SPDX-FileCopyrightText: 2026 Habenula, Inc.
//! SPDX-License-Identifier: MIT

// Public surface of @habenula-ai/audit. The engine imports the hash primitives
// from this barrel to write chain rows; the CLI imports the verifier and the
// closure check by subpath, which keeps workers-typed modules out of its
// typecheck program. The `./*` subpath export serves both, and lets a test
// reach a single module directly when it needs to.

// Append-only audit hash-chain primitives (SHA-256, computed synchronously
// inside the DO's transactionSync — see hash.ts).
export {
  AUDIT_HASH_FORMAT,
  GENESIS_SENTINEL,
  computeEntryHash,
  frameField,
  wellFormed,
} from "./hash.js";
export type { EntryHashFields } from "./hash.js";

// The canonical chain verifier core — pure, holding the same no-I/O discipline
// as evaluatePolicy in @habenula-ai/governance (see verify-chain.ts).
export { verifyChainRange } from "./verify-chain.js";
export type {
  ChainEntry,
  ChainVerdict,
  ChainBreak,
  BreakKind,
  LowerEdge,
  UpperEdge,
} from "./verify-chain.js";

// The decision-closure check — pure, like the verifier core beside it.
export { LIFECYCLE_TOOLS, checkDecisionClosure, owesCloser } from "./decision-closure.js";
export type {
  CloserAgreement,
  CloserRef,
  ClosureCarry,
  ClosureStatus,
  ClosureVerdict,
  DecisionClosure,
  OpenKind,
} from "./decision-closure.js";
