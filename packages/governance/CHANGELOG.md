# @habenula-ai/governance

## 1.0.0

### Major Changes

- 7a39633: First release. The governance kernel — the two pure evaluators the engine's decisions rest on.

  - `evaluatePolicy(entries, action)` — the permission decision. Takes the policy entries and the action, returns allow, deny, or hold. No database call, no network call, no logging inside the function.
  - `evaluateSpend` — the spending decision, held to the same discipline, with the shipped defaults of $50 a month and $20 a session in integer cents.

  Purity is the point, and it is enforced rather than trusted: a CI guard fails the build if either evaluator grows a side effect. Both are exhaustively testable from a table of inputs, which is what lets anyone reading the code confirm the rules for themselves.

  Zero runtime dependencies, and no Node built-ins either — the package is banned from importing them, so it runs unchanged wherever the engine does.
