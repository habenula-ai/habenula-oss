import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // This package is a leaf below the engine's composition root — no file here
  // may touch the agents SDK or the Cloudflare runtime. Unlike the engine's
  // boundary there is no allowlist: the package has no composition root at all.
  //
  // NOTE: unlike @habenula-ai/tools and @habenula-ai/credentials, this package
  // does NOT ban node:* imports. The entry hash (hash.ts) uses node:crypto's
  // *synchronous* createHash. It cannot use Web Crypto's crypto.subtle.digest,
  // which is async: the hash is computed inside the Durable Object's
  // transactionSync() so the read-then-write stays atomic (hard invariant /
  // footgun: a non-atomic hash step corrupts the chain). nodejs_compat is
  // enabled in wrangler.toml to match.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["agents", "agents/**"],
              message:
                "@habenula-ai/audit is a leaf package — no agents SDK imports. See the architecture whitepaper.",
            },
            {
              group: ["cloudflare:*"],
              message:
                "@habenula-ai/audit is a leaf package — no Cloudflare runtime imports. See the architecture whitepaper.",
            },
          ],
        },
      ],
    },
  },
  // The chain verifier core holds the same pure-function discipline as
  // evaluatePolicy in @habenula-ai/governance, by design rather than by Hard
  // Invariant #2 (which names evaluate-policy.ts alone). Same block shape:
  // bans node:*, the agents SDK, cloudflare:*, and the ambient side-effect
  // globals. The ban is on the import specifier, so the relative `./hash`
  // import is unaffected and the INHERITED node:crypto dependency stands —
  // recomputing a stored hash means calling the function that wrote it. What
  // this buys is the no-I/O, no-network, no-logging, no-timers discipline; it
  // is NOT the stronger property of touching no Node built-in at all.
  // decision-closure.ts joins the block with the same discipline — and it
  // imports neither ./hash nor anything else, so for it the node:* ban has no
  // transitive exception at all.
  // Declared after the package-wide block so it is the sole authority for
  // these files (flat config: last matching block wins wholesale, it does not
  // merge). scripts/check-audit-purity.cjs asserts this block keeps biting.
  {
    files: ["src/verify-chain.ts", "src/decision-closure.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["agents", "agents/**"], message: "Pure function — no DO/Agent imports" },
            { group: ["cloudflare:*"], message: "Pure function — no Cloudflare runtime imports" },
            { group: ["node:*"], message: "Pure function — no Node.js imports (node:crypto is reached only transitively via ./hash)" },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Pure function — no network calls" },
        { name: "console", message: "Pure function — no logging" },
        { name: "setTimeout", message: "Pure function — no timers" },
        { name: "setInterval", message: "Pure function — no timers" },
        { name: "caches", message: "Pure function — no cache access" },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["node_modules/", ".wrangler/"],
  }
);
