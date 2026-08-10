/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Test-only environment. The package `src/` is env-free — encryption keys are
// injected by the caller at runtime (the engine reads them from its own env).
// The vault unit tests import a key from the test worker's `env` to exercise
// the real AES-256-GCM round-trip; this declares the one var they read, and
// wrangler.toml supplies its value to the workerd test runtime.
declare namespace Cloudflare {
  interface Env {
    CREDENTIAL_ENCRYPTION_KEY: string;
  }
}
