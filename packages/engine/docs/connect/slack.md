# Connecting Slack

Habenula connects to Slack through a Slack app that **you** create in a workspace you control. One app authorizes the whole Slack *provider*. Consent happens in your browser: Habenula runs an OAuth 2.0 flow, exchanges the authorization code server-side, and stores the resulting tokens AES-256-GCM-encrypted in your per-user Durable Object. The LLM and CLI never see a raw token.

The tricky part is not the Slack app itself; it is that Slack's OAuth redirect must be a public HTTPS URL, so a local engine needs an HTTPS tunnel in front of it. This guide walks through the local-engine setup, which is the harder case. Follow the steps in order — a couple of them depend on earlier ones.

Companion docs:

- [`_index.md`](_index.md) — every integration side by side: who registers what, the redirect rules, and the full environment-variable inventory.
- [`../architecture/oauth-credentials.md`](../architecture/oauth-credentials.md) — credential storage, encryption, and refresh.

## Prerequisites

- The engine builds and runs locally (see [`../guides/development/getting-started.md`](../guides/development/getting-started.md)).
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) installed: `brew install cloudflared`.
- A Slack workspace where you can create an app.

## Why a tunnel — and why `OAUTH_REDIRECT_BASE_URL_SLACK`

Slack only redirects to **exact, pre-registered HTTPS URLs** and makes no localhost exception, so you need a tunnel that gives your local engine a public HTTPS address.

The engine builds its OAuth redirect from a base origin, resolved most-specific-first: a per-provider `OAUTH_REDIRECT_BASE_URL_SLACK`, then the global `OAUTH_REDIRECT_BASE_URL`, then the incoming request URL. A redirect derived from a plain `http://localhost` request comes out `http://…`, which Slack rejects with `redirect_uri did not match`. **Set `OAUTH_REDIRECT_BASE_URL_SLACK` to your tunnel's HTTPS origin** and the engine emits that stable redirect regardless of how the request arrives. This lets the tunnel forward plain HTTP to localhost — no self-signed certificate, no scheme gymnastics.

Use the **Slack-scoped** var, not the global `OAUTH_REDIRECT_BASE_URL`, so the override touches Slack only. Google allows `http://localhost`, so Gmail keeps connecting locally with no tunnel; the global var would move Google's redirect onto the tunnel too and force a needless Google console re-registration.

## 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**. Name the app and pick your workspace.

**OAuth & Permissions → User Token Scopes.** These are *user* scopes, not bot scopes — the engine requests no bot identity. Add all eleven (the full launch tool surface — the canonical set is `SLACK_USER_SCOPES` in `packages/tools/src/services/slack/slack.ts`):

| Scope | Grants |
|-------|--------|
| `channels:read` | list public channels |
| `groups:read` | list private channels |
| `channels:history` | read public channel messages |
| `groups:history` | read private channel messages |
| `chat:write` | send, reply to, and edit messages |
| `search:read` | search the workspace |
| `reactions:write` | add emoji reactions |
| `users:read` | list workspace users, resolve `@handles` |
| `im:write` | open a 1:1 direct message |
| `im:history` | read direct-message history |
| `files:write` | upload files |

Slack grants the set all-or-nothing. If you connected under an earlier, narrower set, the newer tools fail their scope precondition and route you to reconnect — re-run the connect flow to re-consent to the full set.

**Do NOT opt into PKCE.** Under Advanced token security you will see *Proof Key for Code Exchange (PKCE)* with its own opt-in. Leave it off — the engine's Slack flow deliberately sends no `code_challenge`, and opting in makes Slack expect a `code_verifier` the flow never sends, producing a hard `invalid_grant` at token exchange.

**Token rotation is mandatory.** The engine hard-fails the token exchange if Slack returns a non-rotating (non-expiring) token, so you must opt into rotation. Two caveats:

- You cannot enable it yet — Slack blocks the rotation opt-in until at least one redirect URL is registered. That happens in the next step.
- It is a **one-way door**: once rotation is on, Slack does not let you turn it back off.

## 2. Start the tunnel and register the redirect

Front your local engine's port with a tunnel. A quick tunnel allocates a public HTTPS URL immediately — the local engine need not be running yet:

```
cloudflared tunnel --url http://localhost:8787   # point at the origin npx habenula up reported
# → prints https://<random>.trycloudflare.com
```

Then, in the Slack app:

1. **OAuth & Permissions → Redirect URLs** — add `https://<random>.trycloudflare.com/callback/slack`, the exact string with no trailing slash. Then click **Save URLs**. That separate save button is easy to miss: typing in the box alone does not persist, and Slack matches the redirect byte for byte.
2. **Advanced token security** — the "a redirect URL is required" warning has now cleared. Click **Opt In** on token rotation.

## 3. Configure credentials and the redirect base

From **Basic Information → App Credentials**, copy the **Client ID** and **Client Secret**. Before you run the append below, swap your real values into the placeholders, and use the **same tunnel origin** you registered above. Then, from the repository root, append the credentials — plus the loopback override and the redirect base — to `packages/engine/.dev.vars`:

```
cat >> packages/engine/.dev.vars <<'EOF'
SLACK_CLIENT_ID=<your client id>
SLACK_CLIENT_SECRET=<your client secret>
LOCALHOST_ONLY=false
OAUTH_REDIRECT_BASE_URL_SLACK=https://<random>.trycloudflare.com
EOF
```

Notes:

- `wrangler.toml` holds non-secret config only, so `.dev.vars` is the sole local source for these entries. `src/env.ts` (`HabenulaEnv`) already types them. `.dev.vars.example` carries all four as commented-out lines, so you can uncomment them there instead of appending.
- `LOCALHOST_ONLY=false` lets the engine accept the callback arriving via the tunnel host. Without it, the loopback guard returns `403 local requests only` for any non-loopback `Host`.
- `OAUTH_REDIRECT_BASE_URL_SLACK` must be the tunnel **origin** only (scheme + host), no path — the engine appends `/callback/slack` itself. It must match the origin you registered in Slack byte for byte. (The global `OAUTH_REDIRECT_BASE_URL` works too but applies to every provider, including Google.)
- They must land in the **file** — `wrangler dev` reads `.dev.vars` (overlaid on `wrangler.toml`), not your shell environment.
- Run the append once; running it twice writes duplicate keys.

Now start (or restart) the engine — `.dev.vars` is read only at startup:

```
cd packages/engine
npx wrangler dev
```

On startup, wrangler's binding list should show `env.SLACK_CLIENT_ID ("<your id>")`, `env.LOCALHOST_ONLY ("false")`, and `env.OAUTH_REDIRECT_BASE_URL_SLACK ("https://<random>.trycloudflare.com")`. If any name is missing from that list, the file was not picked up.

Before you touch a browser, confirm the redirect. Post to the connect endpoint. Check that the `redirect_uri` in the returned `authorizeUrl` matches your registered URL:

```
curl -s -X POST "http://localhost:8787/connect/slack?userId=cli-user"   # use the origin npx habenula up reported
```

## 4. Connect via the CLI

Run the `habenula` CLI with `npx habenula`, from anywhere inside the clone — the root `npm ci` builds and links it. If you are editing the CLI source, run it from source instead (`npx tsx src/index.ts …` from `packages/cli`): the built command is stale until rebuilt. The CLI reads the engine URL from `HABENULA_API_URL` (default `http://localhost:8787`). The default is fine — the redirect base is what steers the callback, so the CLI can talk to the engine over localhost while Slack redirects the browser through the tunnel:

```
npx habenula connect slack
```

This opens your browser to Slack's consent screen. Click **Allow**; the CLI polls and prints `Connected: slack` once the callback lands. Verify:

```
npx habenula status
```

Connecting establishes the OAuth credential — it is **not** a permission grant. The first time an agent calls a Slack tool, the governance pipeline holds the call and prompts you (**Deny** / **Tell me more** / **For this task** / **For this session**). That confirmation is where scope is granted.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `redirect_uri did not match any configured URIs` | The saved redirect does not match byte for byte. Confirm the URL registered in Slack equals the passed URI exactly (https, no trailing slash), that `OAUTH_REDIRECT_BASE_URL_SLACK` is the same origin, and that you clicked **Save URLs**. |
| Passed URI is `http://localhost…` | `OAUTH_REDIRECT_BASE_URL_SLACK` is unset (or the engine was not restarted after editing `.dev.vars`). Check the binding list on startup. |
| Passed URI has the wrong host | `OAUTH_REDIRECT_BASE_URL_SLACK` still points at a previous tunnel. Quick-tunnel URLs change on every restart — re-set it (see below). |
| `Invalid client_id parameter` | `.dev.vars` has no `SLACK_CLIENT_ID`, so the engine sent the literal `client_id=undefined`. Check the binding list on startup. |
| `403 local requests only` | `LOCALHOST_ONLY=false` is not in `.dev.vars` (or the engine was not restarted). |
| `command not found: habenula` | Use `npx habenula` from inside the clone (root `npm ci` builds and links it), or `npx tsx src/index.ts` from `packages/cli`. |
| Token exchange fails mentioning `expires_in` | Token rotation is not enabled on the Slack app. |

**Quick-tunnel URLs are ephemeral.** A `trycloudflare.com` URL is regenerated every time `cloudflared` restarts, so each session you must re-register the redirect in Slack and re-set `OAUTH_REDIRECT_BASE_URL_SLACK`. For a setup you configure **once**, use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/): its hostname is stable. Register the redirect and set `OAUTH_REDIRECT_BASE_URL_SLACK` a single time, and reuse them across every session.
