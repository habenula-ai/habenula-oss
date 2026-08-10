if (typeof globalThis.Bun !== "undefined") {
  throw new Error(
    "@cloudflare/vitest-pool-workers requires Node.js. " +
      "Bun's WebSocket implementation is missing the 'upgrade' event, which " +
      "causes the workerd bridge to time out. Run tests with: npx vitest run",
  );
}

import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // Explicit bindings win over wrangler.toml [vars] AND any local
      // .dev.vars, so the suite is deterministic regardless of either.
      // CREDENTIAL_ENCRYPTION_KEY: a fresh per-run key — the engine refuses
      // the known placeholder, and tests must run on
      // the same fail-closed configuration consumers get. VISUAL_MODEL: the
      // /api/dev/* contract tests exercise the surface, now off by default
      // in wrangler.toml. DEBUG_MODE: the suite drives
      // POST /api/tools/execute throughout; the gate's own tests exercise the
      // off states by overriding the env object. LOCALHOST_ONLY: pins the
      // loopback guard on even when a .dev.vars sets it "false" for
      // tunnel-based dev.
      miniflare: {
        bindings: {
          CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
          VISUAL_MODEL: "true",
          DEBUG_MODE: "true",
          LOCALHOST_ONLY: "true",
          // OAuth client placeholders the begin-flow / token-exchange integration
          // tests read (env.<PROVIDER>_CLIENT_ID/_SECRET). These live here as
          // TEST-ONLY bindings, not in wrangler.toml [vars]: a secret-bearing
          // [vars] entry deploys as plain_text and clobbers a same-named production
          // secret. Inert fixture values — real OAuth flows run against the mock
          // provider; these only need to be defined and stable.
          GOOGLE_CLIENT_ID: "placeholder-client-id",
          GOOGLE_CLIENT_SECRET: "placeholder-client-secret",
          SLACK_CLIENT_ID: "placeholder-slack-client-id",
          SLACK_CLIENT_SECRET: "placeholder-slack-client-secret",
          GITHUB_CLIENT_ID: "placeholder-github-client-id",
          GITHUB_CLIENT_SECRET: "placeholder-github-client-secret",
          MICROSOFT_CLIENT_ID: "placeholder-microsoft-client-id",
          MICROSOFT_CLIENT_SECRET: "placeholder-microsoft-client-secret",
          // Redirect-base overrides pinned to empty (resolveCallbackUrl treats
          // "" as unset) so a tunnel base in a local .dev.vars can't leak into
          // the no-base derivation tests.
          OAUTH_REDIRECT_BASE_URL: "",
          OAUTH_REDIRECT_BASE_URL_GOOGLE: "",
          OAUTH_REDIRECT_BASE_URL_SLACK: "",
          OAUTH_REDIRECT_BASE_URL_MICROSOFT: "",
          OAUTH_REDIRECT_BASE_URL_GITHUB: "",
        },
      },
    }),
  ],
});
