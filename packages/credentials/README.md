# @habenula-ai/credentials

The Habenula credential vault: the decrypted OAuth credential shape
(`StoredCredential`), AES-256-GCM encryption at rest (`EncryptedPayload` and the
`crypto` primitives), the row-backed store seam (`CredentialRowStore`), and
single-flight token refresh (`SingleFlightRefresher`).

## Install

Run this in your project directory, once per project:

```bash
npm i @habenula-ai/credentials
```

This is the package that owns the **hard invariant** that the LLM context must never
contain a raw OAuth token. Nothing here logs, serialises to the model, or
crosses the `/api/*` wire; credentials are encrypted at rest on the per-user
Durable Object's `connected_services` row and resolved to plaintext
only at tool-execution time, inside the engine, then discarded.

It is a leaf package with **no runtime dependencies**: no engine imports, no
Cloudflare bindings, no agents SDK, and no Node.js — encryption uses Web Crypto
(`crypto.subtle`). Storage is injected: the Durable Object builds a
`CredentialRowStore` over its own SQLite and hands it in, so the encrypt /
decrypt / refresh logic stays here while the storage target stays in the engine.
Token refresh is likewise injected — `SingleFlightRefresher` calls a `refreshFn`
supplied by the OAuth provider strategy in `@habenula-ai/tools`, so this package
never depends on the catalog.

The engine consumes it as source (an exact-pinned workspace sibling, no build step);
`@habenula-ai/tools` depends on it for the `StoredCredential` type its provider
strategies mint and refresh.

Part of the [Habenula](../engine/README.md) OSS release. Licensed under
[AGPL v3](LICENSE).
