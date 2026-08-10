# @habenula-ai/tools

## 1.0.0

### Major Changes

- 7a39633: First release. The service catalog and the tool registry — the table that turns a tool name into something governance can reason about.

  Every tool maps to an abstract `(service, verb, noun)` tuple. The governance pipeline never sees a raw tool name, and a tool server does not get to declare its own security classification: Habenula authors every registry entry, and an unregistered tool defaults to requiring confirmation.

  At this release the catalog carries Gmail, Google Calendar, Outlook Mail, Slack, and GitHub, plus a mock email service and a mock delivery service for exercising the governance loop and the spending caps without connecting anything real or spending anything. Operating Habenula itself is in the same table as a governed service, so `kill`, `disconnect`, `quit`, and the status reads are evaluated by the same rules as everything else.

  Also here: the OAuth provider strategies each service's connect flow resolves through — begin-flow, code exchange, refresh, and the shared callback path.

  One type-only dependency, on `@habenula-ai/credentials`.
