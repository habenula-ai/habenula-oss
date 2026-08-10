# @habenula-ai/contracts

The Habenula wire contract: every `/api/*` request and response shape, defined
once as Zod schemas. The engine validates inbound requests and
outbound responses with these schemas; clients (the CLI today) infer their
TypeScript types from the same definitions, so the two sides cannot drift
silently.

## Install

Run this in your project directory, once per project:

```bash
npm i @habenula-ai/contracts
```

It is a neutral leaf package — its only dependency is `zod`, and it exports
`.ts` source directly with no build step. Consumers import from the package
root or the `./requests` and `./responses` subpaths.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under
[AGPL v3](LICENSE).
