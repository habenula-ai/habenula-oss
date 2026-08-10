# Changesets

Versioning for Habenula is run by [Changesets](https://github.com/changesets/changesets)
**in the upstream monorepo**, not here. This mirror carries only the outputs:
bumped `package.json` versions and per-package `CHANGELOG.md` files, landing
with each release snapshot.

This directory exists so the packed tree is a valid Changesets workspace
(tooling that inspects the repo finds a coherent config). Releases are decided and versioned upstream;
this repository's publish workflow only executes a release already cut.
