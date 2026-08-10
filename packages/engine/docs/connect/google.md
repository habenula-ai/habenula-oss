# Connecting Google

Habenula connects to Google services through a single Google OAuth client that **you** register in the Google Cloud Console. One client authorizes the whole Google *provider*: Gmail and Google Calendar today, and any further Google service (Drive) reuses this same client rather than registering its own. So this setup is done once, not per service. Consent happens in your browser: Habenula runs a raw-`fetch` OAuth 2.0 + PKCE flow (no `googleapis` SDK), exchanges the authorization code server-side, and stores the resulting tokens AES-256-GCM-encrypted in your per-user Durable Object. The LLM and CLI never see a raw token.

The provider-level pieces — the Cloud project, consent screen, OAuth client, and `/callback/google` redirect URI — are shared by every Google service. A service adds only its own API (step 2) and scopes (step 3). This guide walks through **Gmail** as the worked example.

Companion docs:

- [`_index.md`](_index.md) — every integration side by side: who registers what, the redirect rules, and the full environment-variable inventory.
- [`SELF-HOSTING.md`](../../../../SELF-HOSTING.md) — running the shipped self-host container; [`_index.md`](_index.md#environment-variable-inventory) lists every variable and which are secrets.
- [`../architecture/integrations/gmail.md`](../architecture/integrations/gmail.md) — the Gmail tool surface, scope rationale, and the needs-authorization gate.
- [`../architecture/oauth-credentials.md`](../architecture/oauth-credentials.md) — credential storage, encryption, and refresh.

---

## What you're setting up

Three values connect Google Cloud to Habenula. You create the first two in the Cloud Console and generate the third yourself.

| Variable | Source | Destination |
|----------|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client | `.dev.vars` (local) / `.env` (container) |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client | `.dev.vars` (local) / `.env` (container) |
| `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -hex 32` | `.dev.vars` (local) / `.env` (container) |

The **refresh token** is not something you configure. Habenula requests it during consent (`access_type=offline`) and stores it encrypted for you.

---

## Prerequisites

- A Google account. It also becomes a **test user** on your OAuth app.
- Access to the [Google Cloud Console](https://console.cloud.google.com). No billing is required for test mode.
- Habenula running locally — start the engine with `npx habenula up`, which reports the origin it serves on (`http://localhost:8787` unless that port was busy).

---

## Steps

### 1. Create a Google Cloud project

Open the [Cloud Console](https://console.cloud.google.com). Use the project picker in the top bar and choose **New Project** (e.g. `Habenula Dev`). Make sure it is the selected project before you continue.

### 2. Enable the APIs

Go to **APIs & Services → Library** and enable the API for each Google service you'll connect — these are the APIs your tokens will call once the service is connected:

- **Gmail API** — for `npx habenula connect gmail`
- **Google Calendar API** — for `npx habenula connect google_calendar`

Enablement is separate from consent. Connecting a service (step 7) succeeds even when its API is disabled, so a missed enable surfaces only later — as a `403: … API has not been used in project … or it is disabled` error on the first tool call. When you add another Google service, come back and enable its API first.

### 3. Configure the OAuth consent screen

Under **APIs & Services → OAuth consent screen**, choose user type **External**. Fill in the app name, support email, and developer contact. Add the scopes Habenula requests for each service you'll connect. Gmail's three:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.modify
```

Google Calendar's two:

```
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

Leave the publishing status on **Testing**. Add your Google account under **Test users** — only test users can complete consent while the app is in Testing.

> **These are Google *restricted* and *sensitive* scopes.** In Testing you're capped at 100 test users and refresh tokens expire after 7 days — fine for launch and local development. Publishing to general availability later requires Google verification (brand review, demo video, and an annual CASA security assessment).

### 4. Create the OAuth client

Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**. Set the application type to **Web application**. Give it a name. Under **Authorized redirect URIs**, add the callback Habenula listens on (`callbackPath` in `services/google/provider.ts`):

```
# local dev — use the origin habenula up reported
http://localhost:8787/callback/google
```

For local dev, register the origin `npx habenula up` reported. If it named a different origin than `http://localhost:8787`, register that origin's `/callback/google` — the redirect matches byte for byte.

Habenula derives the redirect URI as `/callback/google` against a base origin, resolved most-specific-first: `OAUTH_REDIRECT_BASE_URL_GOOGLE`, then the global `OAUTH_REDIRECT_BASE_URL`, then the incoming request origin.

- Google rejects any mismatch (RFC 6749 §4.1.3). Scheme, host, port, and path must match byte for byte.
- The per-provider var keys off the OAuth **provider** id (`google`), not the connect name you type (`gmail`). `OAUTH_REDIRECT_BASE_URL_GMAIL` is silently ignored.
- Local Gmail connect needs no override — Google allows `http://localhost`. Set a base only when the engine sits behind a tunnel or proxy whose public origin differs from the request it receives.
- The global var also moves other providers' redirects. If you set it to tunnel Slack, register the matching `…/callback/google` here too, or scope that override to `OAUTH_REDIRECT_BASE_URL_SLACK` instead.
- No **Authorized JavaScript origins** are needed; the code exchange is server-side.

### 5. Copy the client ID and secret

After creating the client, Google shows the **Client ID** and **Client secret**. Copy both. You can reopen them anytime from the **Credentials** list.

### 6. Add the credentials to Habenula

**Local development.** Put all three values in `packages/engine/.dev.vars`. `wrangler.toml` holds non-secret config only, so this gitignored file is the sole local source for all three:

```
CREDENTIAL_ENCRYPTION_KEY=<64-char hex>
GOOGLE_CLIENT_ID=<your client id>
GOOGLE_CLIENT_SECRET=<your client secret>
```

Generate the encryption key (once, shared across providers) with:

```bash
openssl rand -hex 32
```

`.dev.vars.example` carries `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as commented-out lines. Uncomment them and paste your values; without them, the live Gmail path does not run.

**Other run paths.** The shipping self-host is the container in [`SELF-HOSTING.md`](../../../../SELF-HOSTING.md), which reads the same three values from the `.env` file beside `compose.yaml` (full inventory in [`_index.md`](_index.md#environment-variable-inventory)). A deployment to your own Cloudflare account is a planned path, not part of this release. When that path ships, these values move to Wrangler secrets.

### 7. Connect Gmail

Start the engine with `npx habenula up`. Then run, from anywhere inside the clone:

```bash
npx habenula connect gmail
```

Your browser opens to Google's consent screen. Sign in with your test-user account. Grant the three scopes. On approval, Google redirects to `/callback/google`; the engine exchanges the code with PKCE, encrypts the tokens, and stores them in your Durable Object. The CLI polls and prints success.

You never re-enter the client ID or secret — consent happens entirely in the browser, and the CLI never handles raw tokens. The poll times out after 5 minutes, and `Ctrl-C` cancels cleanly.

Other Google services on this client connect the same way — `npx habenula connect google_calendar` opens the same consent flow for the Calendar scopes. No new client, secret, or redirect URI; the service just needs its API enabled (step 2) and its scopes on the consent screen (step 3).

---

## Scopes reference

The deliberate least-privilege set for the Gmail tool surface. `gmail.compose` is covered by `gmail.modify`, so it is never requested; the full-access `https://mail.google.com/` scope is never requested. See [`../architecture/integrations/gmail.md`](../architecture/integrations/gmail.md#oauth-scopes-and-the-capability-check) for the capability→scope map.

| Scope | Grants | Requested |
|-------|--------|-----------|
| `gmail.readonly` | Read and search messages, threads, and labels | yes |
| `gmail.send` | Send new mail and replies | yes |
| `gmail.modify` | Manage the mailbox — labels, drafts, archive, read/unread, trash (not permanent delete) | yes |

`gmail.modify` is a near-master scope. It backs Tier 3 — the highest of the Gmail tool surface's three rising-consequence tiers, defined in [`../architecture/integrations/gmail.md`](../architecture/integrations/gmail.md). At that tier the blast-radius bound rests on governance (noun binding + confirmation holds), not on scope narrowness.

Google Calendar's requested scope set and rationale live in [`../architecture/integrations/google-calendar.md`](../architecture/integrations/google-calendar.md#oauth-scopes-and-the-capability-check).

## Redirect URI reference

| Environment | Authorized redirect URI |
|-------------|-------------------------|
| Local dev | `http://localhost:8787/callback/google` (use the origin `npx habenula up` reported) |
| Cloudflare deployment (planned) | Your Worker origin + `/callback/google` |

---

## Verify

Run from anywhere inside the clone:

```bash
npx habenula status
```

Gmail should show as **connected**. An agent can then use the Gmail tools in a conversation, subject to the governance pipeline and your permission grants.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `redirect_uri_mismatch` | The registered URI doesn't match the engine's origin exactly. The origin is the one `npx habenula up` reported, not an assumed `http://localhost:8787`. Recheck scheme, host, port, and path in **Credentials**. |
| `access_denied` / "not a test user" | Add your Google account under **OAuth consent screen → Test users**. |
| "Google hasn't verified this app" | Expected in Testing. Click **Advanced → continue** — you're the developer and a listed test user. |
| Refresh token stops working after ~7 days | A Testing-mode limit for restricted scopes. Re-run `npx habenula connect gmail`. |
| Engine returns 403 behind a tunnel or proxy | The loopback guard rejected a non-loopback `Host`. `LOCALHOST_ONLY="false"` lifts the guard, but the engine ships with no authentication — loopback is the trust boundary, and anything that can reach the port can drive an engine holding credentials at rest. Lift the guard only for a private tunnel, and restore the default when you are done. |
| An agent hits `needs_authorization` on a Gmail tool | The credential lacks that capability's scope (e.g. connected before `gmail.modify` was added). Re-run `npx habenula connect gmail` — re-connecting requests Gmail's full scope set, which Google returns. |
| A tool call fails with `403: … API has not been used in project … or it is disabled` | The service's API isn't enabled in your Cloud project — consent succeeds without it, so the miss surfaces only on the first tool call. Enable the API (step 2; the error message links the exact page), wait a few minutes for propagation, and retry. |
