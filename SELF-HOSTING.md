# Self-Host Locally: Run the Engine from a Container

This runbook starts from a clean machine and ends with a running, persistent Habenula engine on your own hardware. The engine runs inside a Docker container. It listens only on your machine's loopback interface. Its state — the audit chain, policy grants, connected services, encrypted credentials — lives on a Docker volume. The volume survives when the container stops, is destroyed, or is replaced by an upgrade.

The engine runs on Cloudflare's Workers runtime (workerd), embedded through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare). Both are open source, and everything runs on your machine: no Cloudflare account, no login, no telemetry. That runtime is a hard dependency today — self-hosting depends on Cloudflare's open-source code, never on Cloudflare's services.

> **Security boundary — read this first.** The engine ships with **no authentication**. That is safe here only because nothing is network-reachable: the shipped Compose file publishes the port to `127.0.0.1` only. Do not publish the port to a network. Do not edit the `ports:` line. Do not run `docker run -p` by hand. Do not put a reverse proxy in front of the engine. Any of those exposes an unauthenticated engine that holds credentials at rest — and the complete governed history with it. The audit read route hands any caller who can reach the port every recorded action — every service touched, every noun acted on, every denial, with timestamps — not just a bounded status snapshot. This stays unsupported and unsafe until engine authentication ships. Details: [SECURITY.md](packages/engine/SECURITY.md).

**What this runbook covers.** Each goal links to its section:

- [Get the code and create your secrets](#1-get-the-code-and-create-your-secrets) — one time.
- [Start the engine](#2-start-the-engine) — one container with persistent state.
- [Set up the CLI](#3-set-up-the-cli) — one time, plus a per-terminal token export.
- [Drive the governance loop](#4-drive-the-governance-loop-from-the-cli) — connect a service, ask the agent to act, approve the held call.
- [Stop the session](#5-stop-the-session), [operate the container](#operate-the-container), and [back up your data](#your-data-where-it-lives-how-to-back-it-up).
- [Validate the whole path](#validate-the-whole-path) with the same checks CI runs.

**How to read this runbook.** All commands run on your host machine, in a terminal, **from the repository root** — the `habenula-oss` directory that step 1 creates. You never need to change directory after step 1. Steps 1–3 are one-time setup. Step 4 is the loop you will use every day.

## What you need

- **Docker with Compose v2** — Docker Desktop, OrbStack, or a Linux Docker engine.
- **[mise](https://mise.jdx.dev)** — it installs the pinned Node, npm, and `just` versions the CLI needs.
- **`openssl`** — to generate the two secrets in step 1.
- **A model for step 4's conversation** — an Anthropic API key, or any OpenAI-compatible backend (a local Ollama works). Step 4 also has a model-free alternative.

## 1. Get the code and create your secrets

Do this once. Start from any directory:

```bash
git clone https://github.com/habenula-ai/habenula-oss.git
cd habenula-oss
[ -f .env ] || cat > .env <<EOF
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
INTERNAL_MCP_TOKEN=$(openssl rand -hex 16)
EOF
```

This generates two secrets and writes them into `.env`. The `[ -f … ] ||` guard makes the command safe to re-run: it never touches an existing `.env`. That protection matters — a replaced `CREDENTIAL_ENCRYPTION_KEY` makes every credential the engine already stored permanently unreadable. Create `.env` once and keep it.

Each secret has one job:

- `CREDENTIAL_ENCRYPTION_KEY` encrypts OAuth credentials at rest (AES-256-GCM). The engine refuses to start on a missing, malformed, or placeholder key. It fails closed, so real credentials are never encrypted under a publicly known value.
- `INTERNAL_MCP_TOKEN` authenticates the CLI to the engine's trusted drive interface (`/internal/mcp`). The engine rejects drive requests that do not carry it.

> **Never commit `.env`.** It holds real secrets. The container reads it at start time; it is never baked into the image.

`packages/engine/.env.example` documents every further option: the published port, OAuth provider apps, model backends. Append any line you need to your root `.env`. The root `.env` configures the container path only — the `wrangler dev` development loop reads `.dev.vars` instead (see `.dev.vars.example`).

**Connecting a real service later?** Each provider needs its OAuth client credentials in `.env`. Example for Google — run from the repository root:

```bash
cat >> .env <<EOF
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
EOF
docker compose up -d
```

Without these values, the engine refuses the connect and names the variables to set. The mock connector in step 4 needs no provider credentials. To register a provider app, start at [connect/_index.md](packages/engine/docs/connect/_index.md).

## 2. Start the engine

Run from the repository root:

```bash
docker compose up -d --build
```

The first build takes a few minutes: it pulls the base image and installs dependencies. After that, the engine itself starts in seconds, and every later `up` reuses the built image. Confirm the engine is alive:

```bash
curl http://127.0.0.1:8787/api/health
# {"status":"ok","engine":"habenula-engine"}
```

The engine is now an always-on local service. The Compose file sets `restart: unless-stopped`, so the engine comes back with Docker after a reboot. You do not need to start it again unless you stop it yourself.

**If port 8787 is taken on your machine**, pick another port and restart. Run from the repository root:

```bash
echo "HABENULA_PORT=8788" >> .env
docker compose up -d
```

Then give the CLI the new address: run `export HABENULA_API_URL=http://localhost:8788` in every terminal where you use it.

A different port is a different origin to an OAuth provider. If you already registered redirect URIs on `http://localhost:8787`, register the new port as well before you connect a real service. See [connect/_index.md](packages/engine/docs/connect/_index.md#redirect-rules).

## 3. Set up the CLI

The `habenula` CLI runs on your host, not in the container. Install its toolchain once. Run from the repository root (`habenula-oss`):

```bash
mise install
npm ci
```

The first `mise install` in a new directory asks you to trust the repository's tool configuration — confirm it. `npm ci` also builds the `habenula` command and links it into the repository, so `npx habenula` works for every later step.

The CLI authenticates to the engine with the token from step 1. Export it in **every terminal** where you use the CLI — the export lives only as long as that terminal. Run from the repository root:

```bash
export HABENULA_INTERNAL_MCP_TOKEN=$(grep '^INTERNAL_MCP_TOKEN=' .env | tail -1 | cut -d= -f2)
```

The `tail -1` matters: if `.env` ever carries the same key twice (appends do this), the engine uses the last line, so the export must read the same one.

Now check the engine's status. Run from the repository root:

```bash
npx habenula status
```

You see the status view: no session, no grants, no connected services yet. Two CLI verbs need the token (`status` and the conversation — both drive `/internal/mcp`); `kill` and `quit` are plain API calls and work without it.

## 4. Drive the governance loop from the CLI

The built-in `mock_email` connector exercises the real machinery — OAuth state, credential encryption, permission holds, the audit hash chain — with canned data and no external calls. It is the fastest way to watch governance work on your own engine.

### 4a. Connect the mock service

Do this once. Run from the repository root:

```bash
npx habenula connect mock_email
```

Your browser opens a consent page. Click **Approve**. The engine mints a mock credential, encrypts it, and stores it — the same path a real Google or Slack connect takes.

### 4b. Configure a model

Do this once. The conversation needs a model behind it. Pick one option.

**Option A — Anthropic (the default provider).** Add your API key. Run from the repository root:

```bash
echo "ANTHROPIC_API_KEY=<your-anthropic-api-key>" >> .env
```

The model defaults to `claude-sonnet-4-6`. To pick another Claude model, also append `LLM_MODEL=<model-id>`.

**Option B — any OpenAI-compatible backend** (a local Ollama, llama.cpp, or vLLM, or a hosted gateway). Instead of an Anthropic key, run from the repository root:

```bash
cat >> .env <<EOF
LLM_PROVIDER=openai-compatible
LLM_ENDPOINT=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.3
EOF
```

`LLM_ENDPOINT` is a base URL; the engine appends `/chat/completions`. If the backend needs a key, also append `LLM_API_KEY=<key>` — local runtimes usually do not. Note the endpoint host: `localhost` inside the container is the container itself, so a runtime on your machine is `host.docker.internal`. That name is built in on Docker Desktop and OrbStack; on a Linux Docker engine, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the Compose service.

Governance is independent of the model: the same permission holds apply whatever answers.

### 4c. Talk to the agent

Apply the new `.env` values. Run from the repository root:

```bash
docker compose up -d
```

This recreates the container with the new environment. Your state survives — it lives on the volume.

Start the conversation. Run from the repository root (token exported, step 3):

```bash
npx habenula
```

Ask for something governed:

```
Send an email to you@example.com saying hello from my self-hosted engine.
```

The agent picks the mock send tool, and the call **holds** — no grant exists yet. Permissions are built by resolving holds, not by upfront configuration. The conversation prompts you:

```
1. Deny — don't run this; nothing is granted.
2. Tell me more — show what this tool does (no decision yet).
3. Allow — for this task.
4. Allow — for this session (~89m left).
```

Press **4**, then **Enter**. The engine writes the decision to the audit log, executes the send, and the session now carries a `(mock_email, send)` grant scoped to that exact recipient. Type `:status` in the conversation to see it, or run `npx habenula status` in another terminal (token exported there too).

To leave the conversation, type `:exit` — the session stays alive, and a later launch re-attaches. To end the session instead, type `:quit`.

### No model? Drive the same loop over the API (development only)

> **This path is for development and exploration, not operation.** By design, the only intended client of the tool API is the agent itself — internally contextualized and configured — and you govern its actions through the conversation. Driving the API by hand bypasses that design. Use it to inspect the governance machinery without a model, never to operate the product.

The direct-execute route ships **off**. It answers 404 until you opt in. It is a debugging surface, never an intended feature. To opt in, add one line to `.env` in the repository root:

```
DEBUG_MODE=true
```

Then restart the engine so it reads the new value (repeat after every `.env` change): `docker compose up -d`. Only the exact value `true` opens the route. Remove the line and restart again when you are done.

The governance loop itself needs no LLM, so you can skip 4b and 4c entirely. Ask the engine to act directly. Run from the repository root:

```bash
curl -s -X POST http://127.0.0.1:8787/api/tools/execute \
  -H 'content-type: application/json' \
  -d '{"userId":"cli-user","toolName":"mock_email_send","params":{"to":["you@example.com"],"subject":"hello","body":"from my self-hosted engine"}}'
```

The response is `"decision":"pending"` with a `heldCallId` — the same hold you would see in the conversation. Grant it for this session. Paste your `heldCallId` and run from the repository root:

```bash
curl -s -X POST http://127.0.0.1:8787/api/resolve \
  -H 'content-type: application/json' \
  -d '{"userId":"cli-user","heldCallId":"<your-heldCallId>","choice":"session"}'
```

The engine writes the decision to the audit log and executes the call. `npx habenula status` shows the session grant.

## 5. Stop the session

When you are done, either verb ends the session. They are alternatives, not a sequence. Run from the repository root (no token needed):

```bash
npx habenula quit   # ends the session normally, frees the slot
npx habenula kill   # emergency stop: clears all grants to the deny floor (also ends the session)
```

Kill acts on governance state only. Connected services and their stored credentials survive it, so you resume later without re-running OAuth.

## Your data: where it lives, how to back it up

All engine state is Durable Object SQLite files on the named volume `engine-data`. Docker lists it with the project prefix: `habenula_engine-data`. The container's writable layer holds nothing that matters. You can destroy and recreate the container freely; the audit chain continues on its pre-restart tail. That exact property is what the validation harness asserts (below).

To back up, copy the volume. First stop the engine, then write the archive. Run from the repository root (the archive lands there):

```bash
docker compose stop
docker run --rm -v habenula_engine-data:/data -v "$PWD":/backup \
  busybox tar czf /backup/habenula-data.tgz -C /data .
```

To restore, stop the engine again. Then run from the repository root (with the archive there):

```bash
docker run --rm -v habenula_engine-data:/data -v "$PWD":/backup \
  busybox tar xzf /backup/habenula-data.tgz -C /data
```

Protecting the volume and the archive at rest — disk encryption, file permissions — is your responsibility. Your credentials rest on your disk, encrypted under your key.

## Operate the container

All of these run from the repository root:

```bash
docker compose stop      # pause the engine; state and container survive
docker compose start     # resume
docker compose down      # destroy the container; the volume (your state) survives
docker compose down -v   # full reset — deletes ALL engine state
```

To update to a new engine version, run from the repository root:

```bash
git pull
docker compose up -d --build
```

Your state survives an update — the volume outlives the image.

### Watch the governed state

The engine can draw its own governed state as a live graph — the session, your
grants, a held call waiting on you, connected services, and the audit chain. It
re-reads the state every second, so you can watch governance work while you
drive the CLI. The page is off by default.

To turn it on, add one line to `.env` and recreate the container. Run from the
repository root:

```bash
echo "VISUAL_MODEL=true" >> .env
docker compose up -d
```

Then open `http://127.0.0.1:8787/dev/model` in a browser. Use your own port if
you set `HABENULA_PORT`.

The engine reads this setting at start, so the `up` above is required — editing
`.env` alone changes nothing. The page and its snapshot API are unauthenticated
on loopback, like the rest of the local engine. When you are not using the
page, leave the flag off. For what the graph shows and how to drive it, see
[guides/development/visual-model.md](packages/engine/docs/guides/development/visual-model.md).

### If the engine stops answering

The engine watches its own runtime. The runtime is the process that serves your requests. If the runtime dies, the engine stops answering on its port. The engine detects this within 45 seconds and exits. Docker then restarts it, because the Compose file sets `restart: unless-stopped`. Your state survives the restart: it lives on the volume, not in the container.

You do not need to do anything. To see whether this happened, run this command from the repository root:

```bash
docker compose logs engine | grep "runtime unresponsive"
```

One line per occurrence is normal. If the engine restarts again and again, read the full log for the cause — a container that runs out of memory is the common one:

```bash
docker compose logs engine
```

## The `npx` path — not yet shipped

The same engine process also runs directly on your host: `npx @habenula-ai/engine`. It binds `127.0.0.1` and has no input that could widen the bind, and it keeps its state under `~/.habenula` instead of a Docker volume. The engine README's host-run section covers the environment it reads; this runbook covers the container path only.

## Validate the whole path

The repository ships the exact end-to-end validation CI runs. It builds the image, drives the governance loop, destroys and recreates the container, and asserts the state survived: the connected service is present, the audit tail hash is unchanged, and the next governed action's `prevHash` links onto it. It also kills the runtime inside a healthy container and asserts the engine restarts itself.

The harness writes its own throwaway `.env`, so it refuses to run while yours exists. It uses its own Compose project (`habenula-validate`) and port (8799), so it never touches your running engine or its volume. Run from the repository root:

```bash
mv .env .env.mine   # if you created a .env in step 1; otherwise skip this line
node packages/engine/scripts/validate-selfhost.mjs
mv .env.mine .env
```

## A note for contributors: the Miniflare pin

The container hosts the engine under [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare), which embeds the same workerd runtime the test suite runs. The on-disk persist layout under `/data` is Miniflare's and is not contract-stable across major versions. `miniflare` is pinned exactly for this reason. Any bump must re-verify the persist path, the SIGTERM/exit behavior, and always-on fitness before landing. See the [footguns entry](packages/engine/docs/footguns.md#the-daemons-persist-layout-is-miniflares-not-a-stable-contract).
