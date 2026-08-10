# habenula

The Habenula front door on npm. `npx habenula <command>` runs the Habenula
CLI — the same `habenula` command `@habenula-ai/cli` ships. This package adds
no behavior of its own: its bin forwards every invocation to the CLI, and it
pins the CLI and the engine as exact dependencies, so one npm resolution
materializes the whole product.

## Quickstart

Start a local engine. Repeat any time:

```bash
npx habenula up
```

`up` finds the engine inside the same install — no second download. This works
the same way for `npx habenula`, a project-local install, and a global
`npm i -g habenula`: the bin names the engine it came with, so `up` never has
to look for one. A first run also generates the shared secrets into
`~/.habenula/config`. Back that
file up: without its encryption key, stored credentials cannot be read again.
`up` starts an engine and nothing more, so a conversation still needs a model
key; `up` says so when none is set.

Then talk to it. Repeat any time:

```bash
npx habenula
```

Every CLI command works the same way: `npx habenula status`,
`npx habenula log verify`, `npx habenula down`, and the rest. The
[CLI documentation](https://github.com/habenula-ai/habenula-oss/tree/main/packages/cli)
covers them.

## When to use the scoped CLI instead

`@habenula-ai/cli` is the lightweight client: it does not carry the engine,
so it is the smaller install for a machine that only talks to an engine
running somewhere else. This package trades that weight for one-command
setup — a cold `npx habenula` resolves the engine too, roughly 150 MB, even
for commands that never start one.

Two more properties follow from carrying the engine:

- **Install hooks are not required.** The engine's dependency tree includes
  `workerd` (the Workers runtime). Its platform binary arrives as an optional
  dependency that npm selects by operating system and CPU, and its
  `postinstall` is an optimization rather than the thing that makes the binary
  reachable. `npm i --ignore-scripts habenula` therefore installs and runs.
  Verify provenance either way — the attestation is what ties the bytes to
  this source.
- **musl-based hosts are not supported.** The engine ships no musl binary. The
  install still reports success on Alpine-class systems, because npm filters
  that binary on operating system and CPU and not on libc. The failure arrives
  later: `up` starts the engine, and the binary cannot run. The scoped CLI
  runs anywhere Node runs.

One sharp edge: a project that installs both `habenula` and
`@habenula-ai/cli` holds two `habenula` bins in one tree. That is benign —
both execute the same CLI code — but which one npm links first is not
defined, so prefer one package per project.

Part of the [Habenula](https://github.com/habenula-ai/habenula-oss) OSS
release. Licensed under [AGPL v3](LICENSE).
