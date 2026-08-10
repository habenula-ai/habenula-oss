# Install from npm

The eight packages in this repository publish to npm — seven under the
`@habenula-ai` scope, plus the unscoped front door `habenula`. Every published
version is built and published by [the `publish-npm.yml`
workflow](.github/workflows/publish-npm.yml) in this repository, with a
provenance attestation generated on the way. This page covers installing each
package and verifying what you installed.

All commands run in your own project directory. Node 22.22.1 or newer is
required; the `engines` field states the floor, and npm enforces it only when
your project sets `engine-strict`.

## The entry points

One command installs and runs the whole product:

```
npx habenula up
```

The unscoped `habenula` package is the front door. Its bin runs the CLI, and
it pins the CLI and the engine as exact dependencies, so one npm resolution
materializes everything and `up` starts the engine it came with — no second
download. Every CLI command works through it: `npx habenula` opens the
conversation, `npx habenula down` stops the engine it started.

The scoped packages remain the parts. Run the CLI alone — the lightweight
client for a machine that only talks to an engine running somewhere else:

```
npx @habenula-ai/cli
```

Run the engine daemon on your host (loopback only; state in `~/.habenula`):

```
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32) npx @habenula-ai/engine
```

The engine README's host-run section documents the environment the daemon
reads, where its state lives, and how to back it up.

## The packages

| Package | Install | What you get |
|---|---|---|
| `habenula` | `npm i habenula` | the front door: the `habenula` command plus the engine it runs, one resolution — its bin forwards to `@habenula-ai/cli` |
| `@habenula-ai/cli` | `npm i -D @habenula-ai/cli` | the `habenula` command (a self-contained bundle) |
| `@habenula-ai/engine` | `npm i @habenula-ai/engine` | the agent runtime: the `habenula-engine` daemon bin, the Worker bundle it hosts, and the importable module surface for Workers embedders |
| `@habenula-ai/contracts` | `npm i @habenula-ai/contracts` | the `/api/*` wire contract as Zod schemas; infer request/response types from it |
| `@habenula-ai/credentials` | `npm i @habenula-ai/credentials` | the credential vault: AES-256-GCM encryption at rest, the store seam, single-flight refresh |
| `@habenula-ai/governance` | `npm i @habenula-ai/governance` | the pure evaluators: one for permission, one for spending |
| `@habenula-ai/audit` | `npm i @habenula-ai/audit` | the audit-chain kernel: the hash that makes the log tamper-evident, the chain verifier, and the decision-closure check |
| `@habenula-ai/tools` | `npm i @habenula-ai/tools` | the service catalog, tool registry, and OAuth provider strategies |

Engine's importable module surface is bundler-mode: consume it through
wrangler or esbuild, the way every Workers project builds. The daemon bin, the
`habenula` forwarding bin, and the five leaf packages are plain
Node-resolvable.

## Verify provenance

Run this in a project that has the packages installed. It is worth repeating
after any install that changes versions:

```
npm audit signatures --json --include-attestations
```

The Sigstore bundles in the output carry the source repository and commit
each tarball was built from — for these packages, this repository and a
commit on its default branch. The bare `npm audit signatures` form reports
only presence and validity and prints no source reference, so use the flags
when you want the link back to source.

## Install hooks

All eight packages install and run under `npm i --ignore-scripts`.

The engine's dependency tree includes `workerd` (the Workers runtime). Its
platform binary arrives as an optional dependency that npm selects by
operating system and CPU, so skipping install scripts does not skip it; the
`postinstall` hook is an optimization, not the thing that makes the binary
reachable. Verify provenance either way — the attestation, not the absence of
hooks, is what ties the bytes to this source.
