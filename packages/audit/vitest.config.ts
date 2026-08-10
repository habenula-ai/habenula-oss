if (typeof globalThis.Bun !== "undefined") {
  throw new Error(
    "@cloudflare/vitest-pool-workers requires Node.js. " +
      "Bun's WebSocket implementation is missing the 'upgrade' event, which " +
      "causes the workerd bridge to time out. Run tests with: npx vitest run",
  );
}

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
