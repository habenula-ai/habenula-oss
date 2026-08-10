# Slack OAuth response fixtures

These fixtures pin the documented wire-response shapes — see Provenance below
before relying on them as captures. The provider-strategy tests in this
directory own them; they pin the exhaustive mapping (the nested-vs-flat parse
hazard, every failure leg). The engine's worker-flow integration tests do not
reuse them — they mint their own minimal inline response bodies — so there is no
second copy to keep in sync.

`oauth-exchange.json` — the `oauth.v2.access` response for
`grant_type=authorization_code` with token rotation enabled and only
`user_scope` requested: every user-token field nests under `authed_user`,
and the top-level `access_token` (the bot slot this release does not request) is
an empty string.

`oauth-refresh.json` — the `oauth.v2.access` response for
`grant_type=refresh_token` on a user token: the refreshed token sits FLAT at
the top level, with no `authed_user` wrapper, and carries a NEW single-use
`refresh_token`.

The nested-vs-flat difference between the two files is the load-bearing fact
the provider tests exist to pin.

Token string values are scrubbed to obvious non-secret placeholders that
deliberately do NOT carry the real `xoxe.xoxp-` / `xoxe-1-` prefixes, so the
secret-scan patterns covering those prefixes never match this directory. Only
the response *structure* is load-bearing; scrubbing values does not weaken
the tests.

**Provenance — replace before relying on these beyond CI.** These fixtures
should be captured from a live exchange/refresh, never hand-authored,
because a hand-authored fixture re-encodes the same nesting assumption the
mapping makes. These files were
authored from Slack's official response documentation
(docs.slack.dev/authentication/installing-with-oauth and
docs.slack.dev/authentication/using-token-rotation, fetched 2026-07-09) —
a live Slack app did not exist yet at authoring
time. Once a live app registration exists, re-capture both legs, scrub the
token values, and replace these files verbatim.
