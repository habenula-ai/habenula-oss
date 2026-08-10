# @habenula-ai/audit

## 1.0.0

### Major Changes

- 7a39633: First release. The audit-chain kernel: the entry hash, the canonical chain verifier, and the decision-closure check.

  **This package is MIT, and the rest of Habenula is AGPL-3.0-only.** That is deliberate. A log verified only by whoever wrote it proves very little, so the verifier has to be embeddable in a relying party's own codebase, under a licence that lets them do it. Anyone auditing a Habenula chain runs the same function that wrote it.

  - `hashEntry` — the SHA-256 entry hash over the canonical field set, computed synchronously so the write can sit inside the storage transaction that appends the row.
  - `verifyChainRange` — walks a range, recomputes every hash, and reports the first entry where the chain breaks rather than a bare pass or fail.
  - `checkDecisionClosure` — names each decision in a range as clean, conflicted, unresolved, or unchecked, so a decision closed two contradictory ways is a located finding.

  Zero runtime dependencies. The verifier and the closure check hold the same no-I/O discipline as the governance evaluators, guarded in CI. The published chain format and its test vectors ship with the engine's documentation.
