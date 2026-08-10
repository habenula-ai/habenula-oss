# @habenula-ai/cli

The `habenula` command — the terminal client for a Habenula engine. It carries
the interactive conversation REPL, the local engine lifecycle (`up` and
`down`), and the governance controls a user runs day-to-day: `status`,
`connect`/`disconnect`, `task`, `log` / `log dump` / `log verify`, `cap`,
`kill`, and `quit`.

## Install

Run the CLI without installing it. Repeat any time:

```bash
npx @habenula-ai/cli
```

Or add it to a project, once per project:

```bash
npm i -D @habenula-ai/cli
```

The CLI is a thin client. All governed state lives in the engine — locally the CLI
keeps its connection config (`~/.habenula/config`), plus a run record and logs
for any engine it starts itself. It speaks the
`/api/*` wire contract (`@habenula-ai/contracts`, a type-only dependency erased
at build) and renders what the engine returns. The code of one sibling package
from the monorepo does ship inside the bundle: the audit-chain verifier from
`@habenula-ai/audit`, so audit hashes are recomputed with the same function the
engine used to write them. It
holds no service credentials and makes no governance decisions — those are the engine's
job.

It runs on Node. `just cli-build` bundles `src/` to `dist/index.js` with a
`#!/usr/bin/env node` shebang via esbuild; during development,
`just cli-dev <args>` runs the TypeScript source directly through tsx.

Point it at an engine with `HABENULA_API_URL` (the default is the local
engine's recorded port — `http://localhost:8787` unless a port was set).

`habenula up` starts a local engine when none is running, waits for it to
serve, and reports the URL. A first run also generates the shared secrets into
`~/.habenula/config`, the file every later command reads. Back that file up.
Without its encryption key, stored credentials cannot be read again. `up`
starts an engine and nothing more, so a conversation still needs a model key;
`up` says so when none is set. It finds the engine through
`HABENULA_ENGINE_CMD`, an engine path in `HABENULA_ENGINE_BIN` (the unscoped
`habenula` package sets this to the engine inside its own install), a
`habenula-engine` on `PATH`, or npx at the exact engine version this CLI was
built with. It does not add an engine to your project and
does not manage a container.

`habenula up --visual-model` starts that engine with the engine's read-only
visual model page served, and reports the page URL alongside the engine URL.
The engine reads the setting at start, so the flag reaches an engine by
starting one: against an engine that is already serving, `up` reports the page
when that engine has it, and says how to restart when it does not. The flag
beats a `VISUAL_MODEL` line in `~/.habenula/config`, and is not written there —
pass it on each run that wants the page. The page is unauthenticated on
loopback like the rest of the local engine.

`habenula down` stops the engine this CLI started, and only after proving the
recorded process is that engine. Neither command is a governance boundary: the
session keeps aging on its own clock, and grants survive a restart inside that
window. Use `quit` or `kill` for governance.

Reading the audit log means the terminal. The CLI is the only surface that
reads the whole chain. No end-user app or web dashboard ships yet, and the
engine's opt-in visual model page shows only its newest few entries.
`habenula log` shows the newest page of entries. Query filters are not
shipped, so reach older entries with `habenula log dump` and a search tool.
`habenula log verify` recomputes every hash locally, against the live engine
or a dump file.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under
[AGPL v3](LICENSE). The shipped bundle inlines `@habenula-ai/audit`, which is
MIT; [NOTICE](NOTICE) reproduces its terms.
