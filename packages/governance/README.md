# @habenula-ai/governance

The Habenula governance kernel: two pure evaluators, one for permission and one
for spending.

## Install

Run this in your project directory, once per project:

```bash
npm i @habenula-ai/governance
```

`evaluatePolicy(entries, action) → decision` is a **hard invariant** — a pure
function with no side effects: no database calls, no network, no logging.
It maps a set of `(service, verb, noun)` policy entries and a
requested action to an allow / deny / hold decision, and it is the one place
that authorises a tool call. `evaluateSpend(input) → within | exceeds |
unavailable` holds the same discipline for the spending cap: totals and limits
go in as values, so an action that moves money is additionally priced against
the user's windows without the evaluator ever reading a ledger or a clock. Because it is pure it is exhaustively unit-testable
in isolation, which is why it lives in its own leaf package.

This package decides. It does not record. The audit log's hash chain, its
verifier, and the decision-closure check live in
[@habenula-ai/audit](../audit/README.md).

It is a leaf package with **no runtime dependencies**: no engine imports, no
Cloudflare bindings, no agents SDK, and no Node built-ins. The engine consumes
it as source (an exact-pinned workspace sibling, no build step) and owns
everything environmental — the policy entries come from the DO's SQLite, and the
spend totals are read there and passed in as values.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under
[AGPL v3](LICENSE).
