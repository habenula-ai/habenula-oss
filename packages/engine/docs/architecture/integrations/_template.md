# _Service_ Integration

<!--
Template for a new integration doc. Copy this file to `<service>.md`, fill each
section, and delete these comments and any section that does not apply.
Ground every fact in the service definition under
`packages/tools/src/services/<provider>/` — the code is the source of truth.
Public-shipping rules apply: no private issue numbers, no internal phase labels
(translate to "at launch" / "planned" / "later"), short sentences, one term per
concept.
-->

_One paragraph: name the provider and connect type (`oauth` with which provider, or `none`), and state how the tools reach the service — a direct API client with raw `fetch`, authenticated by the credential the dispatch layer injects. Note whether the connection uses a user token or an app/bot token, if that shapes what the agent can see._

## Tool surface

Each tool is its own `(service, verb)` permission subject with its own noun. The noun is extracted synchronously from the call's own params — no credential, no network — so it is the grant key and the audit target at once.

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `<service>_<verb>` | `<verb>` | _what the noun extractor keys on — read the extractor, do not infer from the verb name_ | _read / send / modify / …_ |

_For each verb, state its **noun posture** — what the extracted noun is and why:_

- _Is the noun a resource identifier (a channel, a label, a recipient set), or a fixed **sentinel** for an account-wide or directory-wide action? A sentinel is consented once per session, not per resource; say so._
- _Sentinels must not collide with a real resource name. State the property that guarantees it (e.g. an uppercase sentinel where the provider forces lowercase names)._
- _Which verbs are **consequential** (send, modify, delete, spend)? These hold for confirmation on first use, and any change to the noun forces a fresh confirmation. State what a grant covers for the session._
- _Does any threading, id, or pagination parameter deliberately stay out of the noun? Say which and why._

## OAuth scopes and the capability check

_State the scopes `<service>.connect.scopes` requests, and map each scope to the tools it enables. Justify the set as least-privilege — call out any scope deliberately not requested because a broader one already implies it._

_State the **scope-gate decision** for the tools:_

- _If tools declare `requiredScopes`, the pre-policy scope precondition checks capability coverage (any-of, not exact-string) against the credential's actually granted scopes; a miss produces `needs_authorization` (see [`governance.md`](../governance.md)) and routes the user to `habenula connect <service>`._
- _If a tool declares **no** `requiredScopes` on purpose — for example a provider whose token reports no scopes (an app-install permission model), so a scope gate would deny every call — state that explicitly and name what bounds the tool instead (governance plus the provider's own permission grant)._

_State how **incremental scope grants** work: does connecting a second service under the same provider widen this service's token, or is each connection scoped to its own request? What happens to a user connected under an older, narrower scope set when they first use a tool needing a wider scope?_

**Acquiring the credential.** Registering the provider's app and wiring its client ID and secret into Habenula is covered in the provider's connect guide under `connect/` (for example `connect/slack.md`). Link to it here.

## API quirks

_A bulleted list of the traps a maintainer must know. Cover, where they apply:_

- **Rate limits.** _Per-user, per-app, and burst limits; the account-level volume cap if it differs from the API quota; how a `429` surfaces._
- **Push versus poll.** _Does the service push events (webhooks) or must Habenula poll? Note pagination behavior and any per-page cap, and whether a truncated result is flagged._
- **ToS constraints.** _Any automation or bulk-operation restriction in the provider's terms that bounds what the integration may do._
- **Encoding and consistency.** _Character-set handling, base64 quirks, eventual consistency, id-versus-display-name mismatches._
- **Failure shape.** _Does the provider report errors with a non-error HTTP status (e.g. `200` with an `ok: false` body)? State what the client checks._
- **Token handling.** _Any difference between the connect and refresh token shapes; rotating or single-use refresh tokens that must be persisted._
- **Content in the audit log.** _Confirm message bodies and other content stay out of the audit log; the governed noun persists, the content does not (metadata-only default)._
