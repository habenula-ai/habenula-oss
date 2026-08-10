# @habenula-ai/tools

The Habenula service catalog and tool registry: every Habenula-authored service
integration (Gmail, Google Calendar, Slack, GitHub, Outlook Mail, and the mock
onboarding service), the tools each service exposes, and the OAuth provider
strategies that connect them.

## Install

Run this in your project directory, once per project:

```bash
npm i @habenula-ai/tools
```

This package is the single source of truth the engine derives its tool surface
from: the tool registry, the refresh map, and the connect catalog are
all flattened from `SERVICES`. Habenula authors all entries — services do not
self-declare their security classification.

It is a leaf package with a single **type-only** workspace dependency
(`@habenula-ai/credentials`, for the `StoredCredential` shape its provider
strategies mint and refresh) and no others: no engine imports, no Cloudflare
bindings, no agents SDK, and nothing that survives to runtime. The engine
consumes it as source
(an exact-pinned workspace sibling, no build step) and injects everything environmental —
credentials are resolved by the engine and handed to a tool's `execute` via
`ExecuteContext`; OAuth strategies receive their client secrets through the
narrow `ProviderEnv` interface at call time.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under
[AGPL v3](LICENSE).
