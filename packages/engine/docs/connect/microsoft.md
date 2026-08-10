# Connecting Microsoft

Habenula connects to Microsoft services through a single Entra ID app registration that **you** create in the Microsoft Entra admin center (or Azure portal). One registration authorizes the whole Microsoft *provider*: Outlook Mail today, and any further Microsoft service (Outlook Calendar, Teams, OneDrive) reuses this same registration rather than creating its own. So this setup is done once, not per service. Consent happens in your browser: Habenula runs a raw-`fetch` OAuth 2.0 + PKCE flow (no MSAL or Graph SDK), exchanges the authorization code server-side, and stores the resulting tokens AES-256-GCM-encrypted in your per-user Durable Object. The LLM and CLI never see a raw token.

The provider-level pieces — the app registration, the `/callback/microsoft` redirect URI, and the client secret — are shared by every Microsoft service. A service adds only its own Graph permissions (step 3). This guide walks through **Outlook Mail** as the worked example.

Companion docs:

- [`_index.md`](_index.md) — every integration side by side: who registers what, the redirect rules, and the full environment-variable inventory.
- [`SELF-HOSTING.md`](../../../../SELF-HOSTING.md) — running the shipped self-host container; [`_index.md`](_index.md#environment-variable-inventory) lists every variable and which are secrets.
- [`../architecture/integrations/outlook-mail.md`](../architecture/integrations/outlook-mail.md) — the Outlook Mail tool surface, scope rationale, and Graph quirks.
- [`../architecture/oauth-credentials.md`](../architecture/oauth-credentials.md) — credential storage, encryption, and refresh.

---

## What you're setting up

Three values connect Entra ID to Habenula. You create the first two in the Entra admin center and generate the third yourself (if you already generated one for another provider, skip it).

| Variable | Source | Destination |
|----------|--------|-------------|
| `MICROSOFT_CLIENT_ID` | Entra app registration (Application/client ID) | `.dev.vars` (local) / `.env` (container) |
| `MICROSOFT_CLIENT_SECRET` | Entra app registration (client secret value) | `.dev.vars` (local) / `.env` (container) |
| `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -hex 32` | `.dev.vars` (local) / `.env` (container) |

The **refresh token** is not something you configure. Habenula requests it during consent (`offline_access` scope) and stores it encrypted for you. Microsoft rotates it on every refresh; Habenula persists the rotated token automatically.

---

## Prerequisites

- A Microsoft account — work/school (Entra tenant) or personal. Habenula authorizes against the `common` endpoint, so both kinds can connect.
- Access to the [Microsoft Entra admin center](https://entra.microsoft.com) (any tenant you can register apps in; a free Azure account works).
- Habenula running locally — start the engine with `npx habenula up`, which reports the origin it serves on (`http://localhost:8787` unless that port was busy).

---

## Steps

### 1. Register the application

In the [Entra admin center](https://entra.microsoft.com), go to **Identity → Applications → App registrations → New registration**:

- **Name** — e.g. `Habenula Dev`.
- **Supported account types** — **"Accounts in any organizational directory and personal Microsoft accounts"**. This is the registration-side counterpart of Habenula's `common` tenant endpoint; a narrower choice (single tenant, or `organizations`) would reject the accounts the endpoint invites.
- **Redirect URI** — platform **Web**, value `http://localhost:8787/callback/microsoft`, using the origin `npx habenula up` reported.

After registering, copy the **Application (client) ID** from the Overview page — this is `MICROSOFT_CLIENT_ID`.

### 2. Add redirect URIs per environment

Under **Authentication**, ensure a **Web** platform exists and lists the callback for every origin Habenula serves from (`callbackPath` in `services/microsoft/provider.ts`):

```
# local dev
http://localhost:8787/callback/microsoft
```

Entra permits `http://localhost` redirect URIs for Web apps, so local dev needs no tunnel. Habenula derives the redirect URI as `/callback/microsoft` against a base origin, resolved most-specific-first: `OAUTH_REDIRECT_BASE_URL_MICROSOFT`, then the global `OAUTH_REDIRECT_BASE_URL`, then the incoming request origin.

- Entra rejects any mismatch. Scheme, host, port, and path must match byte for byte.
- The per-provider var keys off the OAuth **provider** id (`microsoft`), not the connect name you type (`outlook_mail`).

### 3. Add the Graph permissions

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:

- `Mail.Read` — for the list / read / search tools
- `Mail.Send` — for the send tool

`offline_access` (and `openid`/`profile`) are standard OpenID scopes granted on consent without needing a row here; adding `offline_access` explicitly is harmless. No admin consent is required for these delegated permissions — the connecting user consents in the browser.

Habenula deliberately does **not** request `User.Read` (nothing in this release reads account identity) or `Mail.ReadWrite` (no hygiene verbs yet). When a later Microsoft service needs more permissions, they are added here and requested by that service's own scope list.

### 4. Create the client secret

Under **Certificates & secrets → Client secrets → New client secret**, add a secret. Copy its **Value** immediately — it is shown once. This is `MICROSOFT_CLIENT_SECRET`. Note the expiry you chose: an expired secret fails every token exchange and refresh until replaced.

### 5. Add the credentials to Habenula

**Local development.** Put the values in `packages/engine/.dev.vars`. `wrangler.toml` holds non-secret config only, so this gitignored file is the sole local source for all three:

```
CREDENTIAL_ENCRYPTION_KEY=<64-char hex>
MICROSOFT_CLIENT_ID=<application (client) id>
MICROSOFT_CLIENT_SECRET=<client secret value>
```

`.dev.vars.example` carries both Microsoft lines commented out. Uncomment them and paste your values.

Generate the encryption key (once, shared across providers) with:

```bash
openssl rand -hex 32
```

**Other run paths.** The shipping self-host is the container in [`SELF-HOSTING.md`](../../../../SELF-HOSTING.md), which reads the same three values from the `.env` file beside `compose.yaml` (full inventory in [`_index.md`](_index.md#environment-variable-inventory)). A deployment to your own Cloudflare account is a planned path, not part of this release. When that path ships, these values move to Wrangler secrets.

### 6. Connect Outlook Mail

Start the engine with `npx habenula up`. Then run, from anywhere inside the clone:

```bash
npx habenula connect outlook_mail
```

Your browser opens to Microsoft's sign-in and consent screen. If you're signed into more than one Microsoft account, an account chooser appears — Habenula sends `prompt=select_account`. Sign in. Grant the requested permissions. On approval, Microsoft redirects to `/callback/microsoft`; the engine exchanges the code with PKCE, encrypts the tokens, and stores them in your Durable Object. The CLI polls and prints success.

You never re-enter the client ID or secret — consent happens entirely in the browser, and the CLI never handles raw tokens. The poll times out after 5 minutes, and `Ctrl-C` cancels cleanly.

A later Microsoft service on this registration connects the same way — no new registration, secret, or redirect URI; the service just needs its Graph permissions added (step 3).

---

## Scopes reference

The deliberate least-privilege set for the Outlook Mail tool surface. See [`../architecture/integrations/outlook-mail.md`](../architecture/integrations/outlook-mail.md#oauth-scopes-and-the-capability-check) for the capability→scope map.

| Scope (wire form) | Grants | Requested |
|-------------------|--------|-----------|
| `offline_access` | A refresh token — without it every Microsoft connection silently becomes re-connect-on-expiry | yes |
| `https://graph.microsoft.com/Mail.Read` | Read, list, and search messages | yes |
| `https://graph.microsoft.com/Mail.Send` | Send mail as the user | yes |

Granted scopes are stored **canonicalized** (`mail.read`, `mail.send`) — Entra's responses vary between fully-qualified and short scope forms, and the pre-policy scope gate compares exact strings, so the provider normalizes on store and the capability map declares the same canonical form.

## Redirect URI reference

| Environment | Authorized redirect URI |
|-------------|-------------------------|
| Local dev | `http://localhost:8787/callback/microsoft` (use the origin `npx habenula up` reported) |
| Cloudflare deployment (planned) | Your Worker origin + `/callback/microsoft` |

---

## Verify

Run from anywhere inside the clone:

```bash
npx habenula status
```

Outlook Mail should show as **connected**. An agent can then use the Outlook tools in a conversation, subject to the governance pipeline and your permission grants.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `AADSTS50011` (redirect URI mismatch) | The registered URI doesn't match the engine's origin exactly. The origin is the one `npx habenula up` reported, not an assumed `http://localhost:8787`. Recheck scheme, host, port, and path under **Authentication**, and that the platform is **Web**. |
| `unauthorized_client` / `AADSTS700016` | Wrong `MICROSOFT_CLIENT_ID`, or the app registration's supported account types exclude the account signing in — re-check step 1's account-type choice. |
| `invalid_client` / `AADSTS7000215` | Wrong or expired `MICROSOFT_CLIENT_SECRET`. Create a new secret (step 4) and update `.dev.vars` (or the container's `.env`). |
| Callback fails with `missing refresh_token — is offline_access in the requested scopes?` | The token response carried no refresh token. Habenula requests `offline_access` by default, so this usually means a conditional-access or tenant policy stripped it; try a personal account or another tenant to isolate. |
| An agent hits `needs_authorization` on an Outlook tool | The credential lacks that capability's scope (e.g. `Mail.Send` was declined at consent, or the API permission is missing). Add the permission (step 3) and re-run `npx habenula connect outlook_mail`. |
| Engine returns 403 behind a tunnel or proxy | The loopback guard rejected a non-loopback `Host`. `LOCALHOST_ONLY="false"` lifts the guard, but the engine ships with no authentication — loopback is the trust boundary, and anything that can reach the port can drive an engine holding credentials at rest. Lift the guard only for a private tunnel, and restore the default when you are done. |
