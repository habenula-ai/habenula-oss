# @habenula-ai/audit

The Habenula audit-chain kernel: the hash that makes the audit log
tamper-evident, the verifier that checks it, and the closure check that reads
whether a held decision was answered.

## Install

Run this in your project directory, once per project:

```bash
npm i @habenula-ai/audit
```

`computeEntryHash` and `GENESIS_SENTINEL` build the SHA-256 hash chain. The
engine's Durable Object calls `computeEntryHash` inside a `transactionSync()`,
so each entry's hash covers the previous one atomically.

`verifyChainRange(entries, options) → verdict` is the canonical verifier. It is
a pure function from a range of entries to a located verdict: it recomputes
every hash and reports the oldest broken link it found, or reports the range as
intact. It performs no I/O, makes no network calls, and logs nothing.
`habenula log verify` runs this function over rows pulled from the engine, or
over an exported dump file. The engine returns rows, never a verdict, so the
party that wrote the log is not the party that judges it.

`checkDecisionClosure(entries, options) → verdict` reads the log's *content*
rather than its integrity. It reports a decision that carries two or more
closing answers as conflicted. That is a finding about what the log says, and
it is distinct from a broken chain.

The same function verifies and writes. The engine and the CLI are built from
one source tree, so "recompute with the function that wrote it" is a build
fact rather than a promise.

It is a leaf package with **no runtime dependencies**: no engine imports, no
Cloudflare bindings, no agents SDK. The engine consumes it as source (an
exact-pinned workspace sibling, no build step) and owns everything
environmental — the rows are persisted in the Durable Object's SQLite, and
retention and archival are the engine's job.

`hash.ts` imports `node:crypto` for `createHash`. This is deliberate: the hash
must be computed *synchronously* inside the Durable Object transaction, and Web
Crypto's `crypto.subtle.digest` is async. `nodejs_compat` is enabled for this
reason.

The chain format is documented, with test vectors, in
[audit-chain-format.md](../engine/docs/architecture/audit-chain-format.md). A
third party can write an independent verifier against that document without
taking a dependency on this package.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under the
[MIT License](LICENSE) — permissive, unlike the AGPL v3 that covers the rest of
the release. Verification is only worth something when the party checking a log
is independent of the party that wrote it, so this package is licensed to let an
auditor, a researcher, or a SIEM embed it in a codebase of their own.

The permissive license changes how you may *use* this code, not how the project
takes changes. Contributions here follow the same model as the rest of the
release, described in the repository's contributing guide.
