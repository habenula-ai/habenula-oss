# @habenula-ai/contracts

## 1.0.0

### Major Changes

- 7a39633: First release. The shared wire contract: every `/api/*` request and response as a Zod schema, in one place.

  The engine validates against these schemas, and a client infers its types from the same source rather than restating them — so a client and the engine cannot drift into disagreeing about the wire without the build saying so. The engine also serves its own contract table at `GET /api/dev/contracts`, and a CI guard compares that table against the routes actually dispatched, both directions, so the published surface cannot silently fall behind the served one.

  Zero runtime dependencies beyond Zod, no build step: the package exports its TypeScript source.
