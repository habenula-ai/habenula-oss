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
  // This package is a leaf below the engine's
  // composition root — no file here may touch the agents SDK or the Cloudflare
  // runtime. Unlike the engine's boundary there is no allowlist: the package
  // has no composition root at all.
  //
  // node:* is banned package-wide, matching @habenula-ai/tools and
  // @habenula-ai/credentials. The one file that needed an exception was the
  // audit hash chain, whose synchronous node:crypto createHash cannot be Web
  // Crypto; it now lives in @habenula-ai/audit, which carries the allowance and
  // the nodejs_compat flag that goes with it. Every file here is a pure
  // evaluator, so nothing in this package has a reason to reach a Node built-in.
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
                "@habenula-ai/governance is a leaf package — no agents SDK imports. See the architecture whitepaper.",
            },
            {
              group: ["cloudflare:*"],
              message:
                "@habenula-ai/governance is a leaf package — no Cloudflare runtime imports. See the architecture whitepaper.",
            },
            {
              group: ["node:*"],
              message:
                "@habenula-ai/governance is a pure-evaluator leaf — no Node.js imports. Chain hashing lives in @habenula-ai/audit.",
            },
          ],
        },
      ],
    },
  },
  // Hard Invariant #2: evaluatePolicy is a PURE function — no side effects, no
  // I/O, no logging. This per-file block is stricter than the package default:
  // it additionally bans the ambient globals that would let a side effect creep
  // in, and it restates the import bans because flat config does not merge.
  // Declared after the package-wide block so it is the sole authority for this
  // file (flat config: last matching block wins wholesale, it does not merge).
  // evaluate-spend.ts holds the same discipline: spend
  // totals and limits arrive as values, so the block is widened rather than
  // duplicated. scripts/check-governance-purity.cjs asserts this block keeps
  // biting for both files.
  {
    files: ["src/evaluate-policy.ts", "src/evaluate-spend.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["agents", "agents/**"], message: "Pure function — no DO/Agent imports" },
            { group: ["cloudflare:*"], message: "Pure function — no Cloudflare runtime imports" },
            { group: ["node:*"], message: "Pure function — no Node.js imports" },
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
