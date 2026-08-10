# Visual Model — live view of the engine's internals

A dev-only page served by the engine that draws the coordinator DO's governed
state as an interactive graph and re-reads it every second. Use it to watch
the data model move while you drive the CLI or an MCP commission: the session
appears, a held call parks in yellow, a grant lands when you approve, the
audit chain grows, a kill sweeps everything back to the deny floor.

## For your agent

Point a coding agent at this file — "read
`packages/engine/docs/guides/development/visual-model.md` and help me watch the
model" — and it will find the rest here.

```
You are helping a developer observe the engine's governed state on the dev
visual model page. Also read packages/engine/src/dev-model/page.ts (what the
page draws) and readModelSnapshot in packages/engine/src/agent/user-agent.ts
(what the snapshot contains).

Establish which engine path the developer is on before anything else — a host
run (habenula up, settings in ~/.habenula/config), the container (docker
compose, settings in .env at the clone root, CLI as npx habenula), or wrangler
dev (settings in packages/engine/.dev.vars, CLI as just cli-dev). Every
instruction below differs between them, so ask rather than assume.

Then confirm the surface is reachable: the page turned on for that path, the
engine restarted since, and which port it actually bound. On a host run that is
one command, habenula up --visual-model, and up prints the page URL. On the
other two it is VISUAL_MODEL=true in that path's file plus a restart. Confirm
too that HABENULA_INTERNAL_MCP_TOKEN is exported in the terminal they will
drive the CLI from — the container and wrangler dev paths need it, it is
per-terminal, and it is the most common first failure. A host run writes both
halves into ~/.habenula/config, so that export is not required there. If the
page 404s, if the CLI is rejected on its caller token, or if every route 503s,
use the table in "When it does not work" rather than diagnosing from scratch.

Then walk the steps in "Making the model move" one at a time, and say what
should appear on the canvas before each one so the developer knows what to look
for. Pause between steps. The page re-reads every second, so a state they pass
through quickly is a state they will miss.

This page is read-only observability. Nothing here changes governed state — the
only mutations are the CLI actions the developer runs themselves.
```

## Running it

The surface ships off by default. Turn it on. Restart the engine. Then open
the page. All three engine paths support it — which files and commands you use
depends on which one you run:

| | Host run (`habenula up`) | Container (the shipped self-host path) | `wrangler dev` (monorepo development) |
|---|---|---|---|
| Turn it on | pass `--visual-model` to `habenula up` | `VISUAL_MODEL=true` in `.env` at the clone root | `VISUAL_MODEL=true` in `packages/engine/.dev.vars` |
| Start the engine | `habenula up --visual-model` | `docker compose up -d` | `just engine-dev` |
| Drive the CLI | `habenula …` | `npx habenula …` | `just cli-dev …` |
| Host port | 8787, or the next free port `up` finds | 8787, or `HABENULA_PORT` if you set it | 8787, or the next free port wrangler picks |

The engine reads the flag at start. After you add the line, restart the
engine. On the container path that means `docker compose up -d`, which
recreates the container. On the host-run path, turning the page on and starting
the engine are one command, and `up` prints the page URL when the engine is
ready. Because the setting is read at start, `--visual-model` cannot turn the
page on in an engine that is already serving: `up` reports the page when that
engine already has it, and tells you to cycle `habenula down` / `habenula up
--visual-model` when it does not. The flag is not recorded in
`~/.habenula/config`, so pass it on each run that wants the page.

The monorepo also has a one-command `just dev`, which starts the engine and
hands you the CLI in one terminal. Use the two-terminal pair above for this
page instead: `just dev` stops the engine when you leave the REPL, and you want
the engine up while you read the graph.

Then open the page. On a host run, open the URL `up` printed. On the other two
paths, build it yourself — and if your port differs, use it in the URL:

```
open "http://127.0.0.1:8787/dev/model?userId=cli-user"
```

`userId` picks the DO to observe. It defaults to `cli-user`, the CLI's own
default, so the page watches the same DO your CLI session drives. The default
is **not** the engine's fallback (`demo-user`): omit the param and you still
watch the CLI's DO, not an empty one.

For the container path in full — creating `.env`, the CLI token export, where
state lives — see [SELF-HOSTING.md](../../../../../SELF-HOSTING.md).

## Making the model move

An idle DO draws an almost empty graph. Drive the CLI to populate it, with the
page open beside your terminal.

Below, **`<cli>`** stands for whichever invocation your path uses: `habenula` on
a host run, `npx habenula` on the container path, `just cli-dev` in the
monorepo.

A host run needs no token export: `habenula up` wrote both halves into
`~/.habenula/config`, and every command reads that file. Skip to the next step.

The other two paths need the CLI's caller token exported first. The
conversation and `status` drive `/internal/mcp`, which fails closed — without
the token every request returns 401. The value is the engine's own
`INTERNAL_MCP_TOKEN`, read from the file your path uses. Run the line for your
path from the repository root. Repeat it in every terminal where you use the
CLI: the export lives only as long as that terminal.

```
# container
export HABENULA_INTERNAL_MCP_TOKEN=$(grep '^INTERNAL_MCP_TOKEN=' .env | tail -1 | cut -d= -f2)

# wrangler dev
export HABENULA_INTERNAL_MCP_TOKEN=$(grep '^INTERNAL_MCP_TOKEN=' packages/engine/.dev.vars | tail -1 | cut -d= -f2)
```

Confirm the CLI reaches the engine. Run from the repository root:

```
<cli> status
```

Then work down the table, pausing after each step to watch the canvas:

| Run this | Watch for |
|---|---|
| `<cli> connect mock_email` | A `mock_email 🔑` node appears under connected services. The key marks a stored credential, presence only |
| `<cli>` with no arguments, then ask the agent to send an email | The session node appears. The tool call parks as a held call in **yellow**, the audit lane gains a `pending` entry, and the wire path pulses from **Human · CLI** |
| Answer the confirmation with **For this session** | A grant node lands in **green**, the held node clears, and the audit entry's outcome resolves |
| Commission the same goal from an external MCP client (see below — no CLI verb drives this) | The hold reappears, joined to its run by `run_id`, and the pulse now originates from **MCP client** — provenance, visibly |
| `:kill` in the REPL, or `<cli> kill` | Every grant sweeps away and the graph returns to the standing deny floor |

Pause between steps. The page re-reads once a second, so a state you pass
through quickly is a state you will miss — the held call in particular exists
only until you answer the confirmation.

The commission step is the one row with no command to copy. `/mcp` is the
external-facing surface, so it takes an outside MCP client rather than the CLI.
Point one at `http://127.0.0.1:8787/mcp`. If your port differs, use it in the
URL. [inbound-mcp.md](../../architecture/inbound-mcp.md) describes what that
surface accepts. If you have no client to hand, skip the step — every other row
works without it, and you will simply not see the provenance change.

## When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `/dev/model` returns 404 | `VISUAL_MODEL` is unset, or set to any value other than exactly `true` | On a host run, start the engine with `habenula up --visual-model`. On the other two, set it in the file your path reads — `.env` for the container, `packages/engine/.dev.vars` for `wrangler dev` — then restart the engine. The gate is fail-closed, so unset is off and a near-miss value like `1` is also off |
| `/dev/model` still 404s after you set the flag | The engine reads its bindings at start, and yours is still running on the old ones | Restart it: `habenula down` then `habenula up --visual-model` on a host run, `docker compose up -d` for the container, or restart `just engine-dev`. Editing the file alone changes nothing, and neither does adding `--visual-model` to an `up` that finds an engine already serving |
| Every route returns 503 except `GET /api/health` | The engine refused to boot because `CREDENTIAL_ENCRYPTION_KEY` is missing, malformed, or the documented dev placeholder | Generate a real key into the file your path reads (`.env` or `packages/engine/.dev.vars`); both example files give the command. Health stays 200 by design, so "health is green but everything else 503s" is this guard, not an outage |
| The CLI reports that the internal interface rejected the caller token | `HABENULA_INTERNAL_MCP_TOKEN` is unset in this terminal, or does not match the engine's `INTERNAL_MCP_TOKEN` | Export it from the file your path reads, as in § Making the model move. This bites the container and `wrangler dev` alike, not just the container; a host run reads `~/.habenula/config` and needs no export. `/internal/mcp` fails closed, so an unset token 401s every request — and the export lives only as long as the terminal |
| Nothing is listening on port 8787 | On `wrangler dev`, wrangler binds the next free port when 8787 is taken. On the container, Compose does not move — `docker compose up` fails outright on a port conflict | For `wrangler dev`, read the actual port from the terminal and use it in the URL. For the container, set `HABENULA_PORT` in `.env` and bring it back up |
| The canvas loads but is empty | You are watching a different DO than the CLI is driving | `userId` selects the DO. Omit it to get `cli-user`, the CLI's default. A mistyped `userId` observes an empty DO rather than erroring, which looks identical to a broken page |
| The graph loads but never changes | Nothing has driven the DO yet, or the poll is failing | Drive a step from § Making the model move. If it still does not move, check the browser console for a failing `GET /api/dev/model` |

## What's on the canvas

Two dotted **compute-environment bands** sit behind the graph: **client** (your
machine — the CLI and MCP surfaces) and **server** (the per-user Cloudflare
Durable Object — the engine, governed state, and audit chain). Each band is a
compound parent whose bounding box is derived from its children, so the
boundary tracks the nodes as you drag them; the wires visibly cross the
client→server line. Click a band for its one-line description.

- **Left (client band)** — the two surfaces (Human · CLI, MCP client). The
  parallel edges into the engine are the wire hops, one per route; **click one
  to see that route's contract** — its query string, its request body, and its
  response (JSON Schema, rendered live from `packages/contracts` via
  `GET /api/dev/contracts`). A `null` side means the route takes no input that
  way, not that the contract is unpublished.
- **Center** — the engine and the governed core: the active session, the
  pending held call, and the active policy surface (the standing deny floor
  included, in gray — default-deny is a visible record here, not an absence).
- **Right** — commission runs, connected services (🔑 marks a stored
  credential — presence only), and the recent audit chain, newest first.
- **Dotted edges are the real joins**: `held → session`, `commission → held`
  (`run_id`), `audit entry → policy entry` (`decided by`). Click any node or
  join for the sanitized record in the side panel.

Color reports state and never nudges: pending yellow,
allow green, deny red, expired/floor gray. New or changed records flash; a new
audit entry pulses the wire path from its origin surface (`human` vs
`mcp_commission`). The most recent call then stays lit — a steady highlight on
the entry and its wire path — until the next call lands, when the highlight
moves rather than fading, so the latest activity is always visible at a glance.

## The gate and the action flow

The engine node is the **governance gate**. A caption under it names the check
pipeline (permission · spend · rate · audit → allow / hold / deny). The edges
fanning out from it are labeled governance-flow steps: **checks policy**,
**executes** (to a connected service), **records** (to the audit chain), and
**holds** (to a parked held call, shown while one exists). Commission runs stay
a faint inbound `goals` line, not a gate step.

Below the state map, an **action flow** strip draws the governance pipeline as
a fixed DAG: a trunk (request → classify → gate → audit) fans into the three
gate outcomes (**deny · hold · allow**), with hold → confirm → grant rejoining
execute. It is driven by the same one-second snapshot as the state map — each
tick, the path the most recent call took lights up (allow green / hold yellow /
deny red) and the rest dims. Before any real call, the DAG rests fully dim. A
live held call shows as the hold outcome regardless of the newest audit entry,
and session-lifecycle rows are skipped when picking the entry that decides the
lit path. Click a stage for its one-line description in the side panel. The
panel's resting state is the legend-and-hint home view; clicking a record swaps
in its detail view, and clicking empty canvas returns home.

## Surfaces and gating

| Route | What | Gate |
|-------|------|------|
| `GET /dev/model` | The page (self-contained HTML, vendored cytoscape inlined) | `VISUAL_MODEL === "true"`, else 404 |
| `GET /api/dev/model?userId=…` | `GovernanceSnapshotResponse` — one atomic DO read | same |
| `GET /api/dev/contracts` | `ContractDescriptorsResponse` — every contract-bound route's query, request, and response as JSON Schema | same |

The gate is fail-closed (unset ≠ enabled) and sits on top of the
`LOCALHOST_ONLY` loopback guard. A hosted deploy leaves `VISUAL_MODEL` unset.

## Trust and sanitization

The snapshot is sanitized **by construction**: the contract has no field for
credential ciphertext (`connected_services` surfaces `hasCredential` only),
`oauth_state` and `user_settings` appear as row counts alone, and audit
parameters are the stored metadata summary. Externally-authored values
(nouns, commission goals, held-call params) ship verbatim and are rendered by
the page as text only, flagged ⚠ in the detail panel — the same trust rule
the CLI applies.

The snapshot contract is deliberately product-neutral: records carry their
real foreign keys and no layout vocabulary, so a future hosted governance
view can consume the same schema.

## Extending it

- New table or record type → extend `GovernanceSnapshotResponse`
  (`packages/contracts/src/responses/governance-snapshot.ts`),
  `readModelSnapshot()` (`src/agent/user-agent.ts`), and `buildDesired()` in
  `src/dev-model/page.ts`.
- New contract-bound route → add a row to `ROUTE_CONTRACTS` in
  `src/dev-model/contract-descriptors.ts` so its edge detail resolves.
- Upgrading the vendored renderer → `src/dev-model/vendor/README.md`.
