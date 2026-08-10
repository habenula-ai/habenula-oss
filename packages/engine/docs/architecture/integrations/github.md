# GitHub Integration

GitHub is a GitHub-provider OAuth service (`packages/tools/src/services/github/github.ts`). Its tools call the GitHub REST API directly with raw `fetch` (no Octokit SDK), authenticated by the credential the dispatch layer resolves and injects; an executor never resolves a credential itself.

The connection is a **GitHub App user flow**, not a classic OAuth App. Repository access is chosen when the App is installed, not requested as OAuth scopes, so the connection asks for no scope and the stored credential reports none. The shipped surface today is a single read-only tool; more tools are planned.

## Tool surface

Each tool is its own `(service, verb)` permission subject with its own noun. The noun is extracted synchronously from the call's own params — no credential, no network — so it is the grant key and the audit target at once.

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `github_list` | `list` | the repository owner login, lower-cased; or the sentinel `@me` for any ownerless request (the caller's own repositories) | read |

`github_list` returns the repositories visible to the connected user for a given owner. The noun is the owner login, lower-cased because GitHub logins are case-insensitive, so `Octocat` and `octocat` are the same grant. A request with no owner — a listing of the user's own repositories — nouns as the fixed `@me` sentinel rather than an empty string, so an ownerless listing is a distinct, nameable grant.

## OAuth scopes and the capability check

`github.connect.scopes` is **empty**, and `github_list` declares **no** `requiredScopes` — both deliberate. A GitHub App user token always reports its `scope` as the empty string, because a GitHub App's access is defined by its installed repository permissions, not by OAuth scopes. A scope gate would therefore check the tool's required scope against an always-empty granted set and deny every call as `needs_authorization`. The tool's blast radius is bound instead by governance (noun binding plus confirmation holds) and by the App's own read-only permission grant, chosen at install time.

The OAuth flow uses PKCE with `S256` (supported for GitHub Apps). The provider requires `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and its callback path is `/callback/github`.

**Acquiring the credential.** Registering the GitHub App and wiring its client ID and secret into Habenula is covered in [`connect/github.md`](../../connect/github.md).

## API quirks

- **A `User-Agent` header is required.** GitHub rejects a request with no `User-Agent` as `403`. Every call sends a fixed `Habenula` user agent.
- **The API version is pinned.** Every call sends `X-GitHub-Api-Version: 2022-11-28`. Omitting the header defaults to the latest version, which could shift response shapes without warning.
- **Listing is capped and reports truncation.** A listing scans at most 1000 repositories (ten pages of 100) to protect the Worker subrequest budget. A listing cut off at the cap is returned with a `truncated` flag and an explicit "listing is incomplete" note, so a partial result is never mistaken for a complete one.
- **Owner routing has a fallback.** With no owner, the tool lists `/user/repos`. With an organization owner, it lists `/orgs/{owner}/repos`. If that returns `404` — the owner is a user, or an organization the token cannot reach — the tool falls back to a client-side-filtered scan of `/user/repos`. An unreachable organization and a real user both list as empty rather than erroring. The public-only `/users/{owner}/repos` endpoint is deliberately avoided, because it would drop private repositories.
- **The owner noun guards against coercion.** The emptiness check runs before any string coercion, so an ownerless or malformed request nouns as the `@me` sentinel rather than governing under a literal `"undefined"` or empty-string owner.
- **Failures arrive as HTTP 200.** A token failure is reported with a `200` status and an `error` body field, so both the status and the body are checked. The request sends `Accept: application/json`, or GitHub answers form-encoded.
- **Refresh tokens rotate.** Each refresh returns a new refresh token (prefixed `ghr_`) that invalidates the previous one. The new token must be persisted, or the connection breaks.
