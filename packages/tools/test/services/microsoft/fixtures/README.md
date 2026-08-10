# Microsoft (Entra ID) OAuth response fixtures

These fixtures pin the documented wire-response shapes — see Provenance below
before relying on them as captures. The provider-strategy tests in this
directory own them; they pin the exhaustive mapping (canonicalization,
rotation, every failure leg). The engine's worker-flow integration tests do not
reuse them — they mint their own minimal inline response bodies — so there is no
second copy to keep in sync.

`oauth-exchange.json` — the `common`-tenant v2.0 token response for
`grant_type=authorization_code`. The `scope` value is deliberately the
fully-qualified mixed-case form (`https://graph.microsoft.com/Mail.Read`) so
the provider's canonicalization (`normalizeGraphScope` → `mail.read`) is
pinned against it: Entra's responses vary between the fully-qualified and
short forms, and the scope gate is an exact string-membership check.

`oauth-refresh.json` — the response for `grant_type=refresh_token`. It
carries a **new** `refresh_token` value (`…-rotated`, not the exchange's
`…-exchange`): Microsoft rotates the refresh token on every refresh and
invalidates the old one, so the rotation assertion in provider.test.ts —
store the returned token, throw when absent, never preserve the spent one —
is exercised against realistic structure.

`ext_expires_in` is present in both (a resilience window for Entra outages)
and deliberately unstored — `StoredCredential` has no field for it.

Token string values are scrubbed to obvious non-secret placeholders. Real
Microsoft access tokens are JWTs; the placeholders deliberately do NOT carry
an `eyJ` prefix, so nothing here resembles a real token (and no secret-scan
pattern exists to trip: Microsoft access tokens are JWTs, so an `eyJ` pattern
would false-positive across the whole ecosystem, and its refresh tokens are
opaque strings with no documented stable prefix). Only the response
*structure* is load-bearing; scrubbing values does not weaken the tests.

**Provenance — replace before relying on these beyond CI.** These files were
authored from the Microsoft identity platform's documented token responses
(learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow,
verified 2026-07-14) — the Entra app registration
did not exist yet at authoring time, the same
bootstrap Slack's fixtures had. In particular the `scope` form is the
documented one, so the canonicalization test guards against a regression
from that form, not against the documented form itself being wrong; a wrong
guess fails loud (every Outlook tool fails closed) at the first live
exchange. Once a live app registration exists, re-capture both legs, scrub
the token values, and replace these files verbatim.
