# Contributing to Habenula

Thanks for your interest in Habenula. Two things to know up front about how
this repository works:

## This is a release mirror

`habenula-oss` is the public snapshot of the Habenula monorepo's open-source
surface. Every release is a single synthetic commit from our release pipeline,
and the next snapshot overwrites this repository's working tree. **Pull
requests here are therefore never merged** — that is a property of how the
mirror is built, not a judgment on your work.

You can still contribute:

- **Bugs, feature requests, and questions** — open an
  [issue](https://github.com/habenula-ai/habenula-oss/issues). Issues are
  actively triaged; an accepted change lands upstream and ships in a later
  release.
- **Code** — open a pull request. A pull request is the clearest way to
  propose a code change here: easy to review, easy to test locally. It is a
  **proposal, not a merge.** If a maintainer accepts it, the change is applied
  upstream and ships in a later release, and the pull request is closed with a
  note. You are credited for an accepted change — see
  [How you are credited](#how-you-are-credited) below.
- **Security vulnerabilities** — do **not** open an issue or pull request;
  email **security@habenula.ai** (see [SECURITY.md](SECURITY.md)).

**Contributor License Agreement.** Before the project can use your
contribution, you must sign the [Contributor License Agreement](CLA.md). When
you open a pull request, the CLA bot adds a one-time signing step. You sign
once; after that, the CLA check passes on your future pull requests. The check
confirms only that the CLA is signed — it does not mean a change is accepted.
Every contribution is reviewed on its own.

How contributions work may evolve as the project matures.

## How you are credited

Your code is not merged on this repository. An accepted change is integrated in
the upstream monorepo and ships from there, in a later release.

Credit does not depend on that. At the release that carries your change, a
commit **authored by you** is added to `main` here. That commit adds one line to
[CONTRIBUTORS.md](CONTRIBUTORS.md) naming you, what you contributed, and your
proposal. It contains nothing else. Because you are its author, it counts toward
your GitHub contributions like any other commit you write.

Your change is also credited by name in the release notes of the package it
ships in.

Two things to know about what becomes public:

- Your handle and the author email on your proposal's commits both become part
  of this repository's permanent public history.
- GitHub attributes a commit by its author email. If the email on your commits
  is not linked to your GitHub account, the commit does not appear on your
  profile. Check the email on your commits before you propose a change.

A contribution with no commits behind it — a threat-model review, or a bug
report filed as an issue — is recorded in `CONTRIBUTORS.md` the same way. There
is no commit of yours to attribute, so it earns an entry rather than a profile
contribution.

## Working with the code

Self-hosting and local development are first-class:

```bash
mise install        # pinned node + just (.mise.toml)
npm ci              # one workspace install, exact-pinned dependencies
just pre-commit     # lint + typecheck + test for all eight packages
just dev            # local engine + interactive CLI
```

Conventions the codebase holds itself to (and that pull requests should follow):

- **Exact dependency pins** — no `^`/`~` ranges anywhere;
  `scripts/check-pinned-deps.cjs` enforces this in every package's lint.
- **Runtime-bound tests run in the real Workers runtime** via
  `@cloudflare/vitest-pool-workers` — never mock KV, Durable Objects,
  SQLite, or R2. The two plain-Node packages test on Node: the CLI with
  vitest, the `habenula` forwarder with `node --test`.
- **Governance evaluation stays pure** — `evaluatePolicy` has no side
  effects; `scripts/check-governance-purity.cjs` guards it.
- **Docs live with the code** — `packages/engine/docs/` is the
  documentation tree; [INDEX.md](packages/engine/docs/INDEX.md) is the map.
  The development workflow (branch naming, commit conventions, review
  loop) is documented in
  [guides/development/contributing.md](packages/engine/docs/guides/development/contributing.md).

## Code of conduct

Participation in the project is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).
