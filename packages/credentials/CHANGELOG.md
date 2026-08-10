# @habenula-ai/credentials

## 1.0.0

### Major Changes

- 7a39633: First release. The credential vault — where a connected service's OAuth token lives, and the reason the model never holds one.

  - `StoredCredential` and the encryption at rest: AES-256-GCM over Web Crypto, no Node built-ins, so it runs unchanged in the Workers runtime.
  - A row-backed store seam, so the credential sits on the same row as the connection it authenticates. Disconnecting a service clears both in one atomic delete, and no orphaned credential survives it.
  - Single-flight token refresh, so concurrent tool calls against one expiring token produce one refresh rather than a race.

  The package owns the invariant that the model's context never contains a raw token: the runtime holds a session reference, resolves it to the real credential at execution time, and discards it after use.

  Zero runtime dependencies.
