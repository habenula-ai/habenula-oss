# Connecting GitHub

Habenula connects to GitHub through a GitHub App that **you** create under your own account or organization. One App authorizes the whole GitHub *provider*. Consent happens in your browser: Habenula runs the App's user-to-server web flow, exchanges the authorization code server-side, and stores the resulting tokens AES-256-GCM-encrypted in your per-user Durable Object. The LLM and CLI never see a raw token.

Unlike Slack, GitHub accepts a `http://localhost` OAuth callback, so **no tunnel is needed** and `LOCALHOST_ONLY` can stay `true`. The part that trips people up is different here: a GitHub App has two separate acts — **authorization** and **installation**. `npx habenula connect github` does only the first. Repositories stay invisible until you also install the App and select repositories. This guide walks through the local-engine setup, end to end, so an agent can list your repositories. Follow the steps in order.

Companion docs:

- [`_index.md`](_index.md) — every integration side by side: who registers what, the redirect rules, and the full environment-variable inventory.
- [`../architecture/oauth-credentials.md`](../architecture/oauth-credentials.md) — credential storage, encryption, and refresh.

## Prerequisites

- The engine builds and runs locally (see [`../guides/development/getting-started.md`](../guides/development/getting-started.md)).
- A GitHub account, and access to whichever account or organization owns the repositories you want to list.

## Why a GitHub App — and why authorize ≠ install

The `github` service uses a **GitHub App user-to-server web flow**, not a classic OAuth App. That choice buys a fine-grained, read-only, 8-hour credential that fits the engine's existing token harness with no changes (see [`../architecture/oauth-credentials.md`](../architecture/oauth-credentials.md)). The cost is a heavier connect UX, and it splits into two independent acts:

- **Authorization** (OAuth) — the user consents and the engine receives a user access token (`ghu_`, 8h) plus a rotating refresh token (`ghr_`). This is what `connect github` performs.
- **Installation** — the App is installed on an account or organization and granted access to specific repositories.

A user token's reach is the **intersection** of what the user can access and what the App is installed on. If you authorize but never install, that intersection is empty: `github_list` (which calls `GET /user/repos`) returns nothing even though the connection succeeded. Both acts are required, and they are done in different places — the CLI for authorization, github.com for installation.

## 1. Create the GitHub App

Go to [github.com/settings/apps](https://github.com/settings/apps) → **New GitHub App**.

- **GitHub App name** — anything unique.
- **Homepage URL** — required but cosmetic (never used in the flow). Any valid URL is fine.
- **Callback URL** — `http://localhost:8787/callback/github`, exactly, no trailing slash, on the origin `npx habenula up` reported. This is the one field that must match; the engine's callback route is `/callback/github`.
- **Expire user authorization tokens** — **must be enabled** (checked). This is the setting that makes GitHub issue the expiring `ghu_` token plus the rotating `ghr_` refresh token the engine depends on. With it off, GitHub returns a non-expiring token with no refresh token. The exchange then hard-fails by design rather than storing a credential it can't refresh. This is the most common cause of a connect that reaches GitHub's consent screen but never lands.
- **Webhook → Active** — **uncheck** it. The engine uses no webhooks, and leaving it active makes GitHub demand a webhook URL.
- **Repository permissions → Metadata** — set to **Read-only**. That is all `github_list` needs. (Add `Contents: Read` / `Issues: Read` later as new tools require them.)
- **Where can this GitHub App be installed?** — if the repositories live under your personal account, choose **Only on this account**. If you need to install on an organization, choose **Any account** (see step 4). You can change this later.

Do not configure any OAuth scopes — a GitHub App's reach comes from its permissions and the repositories selected at install, not from classic scopes. The web flow needs only the App's Client ID and Client Secret; the App's private key is **not** used.

Create the App. Then, under **Client secrets**, click **Generate a new client secret** and copy it. Copy the **Client ID** too.

> **Client ID format.** A modern GitHub App Client ID looks like `Iv23liXXXXXXXXXXXXXX` — it already carries its own prefix. There is no separate `Iv1.` to prepend. Store the value exactly as GitHub shows it; a stray `Iv1.` in front produces `client_id` for an app that doesn't exist and GitHub answers the authorize request with a 404.

## 2. Configure credentials

`.dev.vars.example` carries both GitHub lines commented out, so you can uncomment them there. Or, from the repository root, append them to `packages/engine/.dev.vars`, swapping in your real values:

```
cat >> packages/engine/.dev.vars <<'EOF'
GITHUB_CLIENT_ID=<your client id>
GITHUB_CLIENT_SECRET=<your client secret>
EOF
```

Notes:

- `wrangler.toml` holds non-secret config only, so `.dev.vars` is the sole local source for both names. `src/env.ts` (`HabenulaEnv`) already types them.
- No `OAUTH_REDIRECT_BASE_URL_*` and no `LOCALHOST_ONLY=false` are needed — GitHub allows the plain `http://localhost:8787/callback/github` redirect, so the loopback default stands.
- They must land in the **file** — `wrangler dev` reads `.dev.vars` (overlaid on `wrangler.toml`), not your shell environment.
- The quoted `'EOF'` stops the shell from expanding a secret that contains `$` or backticks. Run the append once; running it twice writes duplicate keys.

Start (or restart) the engine — `.dev.vars` is read only at startup:

```
cd packages/engine
npx wrangler dev
```

On startup, wrangler's binding list should show `env.GITHUB_CLIENT_ID ("Iv23li…")`. If the name is missing from that list, the file was not picked up.

## 3. Connect via the CLI (authorization)

Run the `habenula` CLI with `npx habenula`, from anywhere inside the clone — the root `npm ci` builds and links it. If you are editing the CLI source, run it from source instead (`npx tsx src/index.ts …` from `packages/cli`): the built command is stale until rebuilt. The CLI reads the engine URL from `HABENULA_API_URL` (default `http://localhost:8787`) and the user id from `HABENULA_USER_ID` (default `cli-user`):

```
npx habenula connect github
```

This opens your browser to GitHub's consent screen. Approve it; the CLI polls and prints `Connected: github` once the callback lands. Success is that line in the **terminal** — not merely the browser page. Verify:

```
npx habenula status
```

`github` should appear under **Connected services**. Connecting establishes the OAuth credential — it is **not** a permission grant, and it does **not** by itself grant repository access (that is step 4).

## 4. Install the App and select repositories

This is the half that makes repositories visible. Open the App's **Install App** page — App settings → **Install App** in the left sidebar. Install the App where your repositories live.

**Repositories under your personal account.** Install on your own account. Then choose **All repositories** (simplest), or choose **Only select repositories** and pick them. If the repository picker shows *"No repositories found,"* that account genuinely has no repositories — your code is probably under an organization instead (below).

**Repositories under an organization.** The App must be installed on the **org**, not your personal account. Two conditions apply:

- The App must be installable on the org. If step 1 left it **Only on this account**, the org will not appear as an install target — change **Where can this GitHub App be installed?** to **Any account** in the App's settings first.
- Installing on an org requires **org-owner** rights. If you are only a member, the Install button reads **Request** instead, and an org owner must approve before the App gets any access. (You do not need to own the individual repositories — org membership plus an owner-approved install is enough to list them.)

Whichever target, finish by selecting the repositories (or All repositories) and saving.

## 5. Verify and list repositories

Confirm the credential is stored under the same user id the CLI uses:

```
curl -s "http://localhost:8787/api/services?userId=cli-user" | python3 -m json.tool
```

`github` should be listed. Then start a conversation — run from anywhere inside the clone:

```
npx habenula
```

Ask the agent to list your repositories. The first `github_list` call is **held by the governance pipeline** and prompts you (**Deny** / **Tell me more** / **For this task** / **For this session**). Choose one of the grants. The call executes and returns the intersection of your access, the installed repositories, and the App's read-only permission.

If the list comes back empty right after installing, re-run `npx habenula connect github` to refresh the token, then try again.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| GitHub's authorize URL 404s | The `client_id` is wrong — most often a stray `Iv1.` prefixed onto a `Iv23li…` Client ID. Store the value exactly as GitHub shows it and restart the engine. |
| Consent screen appears but connect never completes; CLI times out | *Expire user authorization tokens* is not enabled on the App, so the exchange rejects the non-rotating token. Enable it in the App settings and reconnect. The `wrangler dev` log names the missing field (`missing refresh_token` / `missing expires_in`). |
| `env.GITHUB_CLIENT_ID` is absent from the startup binding list | `.dev.vars` has no value for it, or the engine was not restarted after editing the file. The authorize URL then carries the literal `client_id=undefined`, which GitHub answers with a 404. |
| `Connected` but `github_list` returns no repositories | The App is authorized but not **installed** on an account/org that has repositories, or no repositories were selected. Complete step 4; re-run `connect github` if still empty. |
| Repository picker shows "No repositories found" | The install target (usually your personal account) has no repositories. Your code is under an org — install there instead. |
| The org is not offered on the Install App page | The App is scoped **Only on this account**. Set **Where can this GitHub App be installed?** to **Any account**. |
| Install button reads **Request**, not **Install** | You are not an owner of that org. An org owner must approve the installation. |
| `github` missing from `:disconnect` autocomplete | Cosmetic CLI staleness — the menu is captured once at REPL startup. Type `:disconnect github` in full, or restart the REPL. The connection is real; `:status` confirms it. |
| `command not found: habenula` | Use `npx habenula` from inside the clone (root `npm ci` builds and links it), or `npx tsx src/index.ts` from `packages/cli`. |
