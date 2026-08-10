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
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
    },
  },
  // The Cloudflare/agents import boundary. Business
  // logic depends on ports (EngineSql, CredentialRowStore, LLMClient); only the
  // composition root may import the agents SDK or cloudflare:* modules. The
  // `ignores` list is a two-file allowlist, not a directory glob, so a future
  // file dropped beside the DO class is still caught. (The pure-function block
  // that once also governed governance/evaluate-policy.ts moved with that file
  // to @habenula-ai/governance; its eslint config is now that invariant's home,
  // guarded by scripts/check-governance-purity.cjs.)
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/agent/user-agent.ts", // composition root — imports `Agent` from "agents"
      "src/index.ts", // composition root — imports `createMcpHandler` from "agents/mcp"
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["agents", "agents/**"],
              message:
                "Cloudflare/agents SDK is confined to the composition root (agent/user-agent.ts, index.ts). Business logic must depend on a port (EngineSql, CredentialRowStore, LLMClient). See the architecture whitepaper.",
            },
            {
              group: ["cloudflare:*"],
              message:
                "Cloudflare runtime imports are confined to the composition root. Business logic must depend on a port. See the architecture whitepaper.",
            },
          ],
        },
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
    ignores: ["dist/", "node_modules/", ".wrangler/"],
  }
);
