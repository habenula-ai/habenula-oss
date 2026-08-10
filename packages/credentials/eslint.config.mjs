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
  // has no composition root at all. Encryption is Web Crypto (crypto.subtle),
  // so the no-Node boundary holds — nothing here reaches for node:crypto.
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
                "@habenula-ai/credentials is a leaf package — no agents SDK imports. See the architecture whitepaper.",
            },
            {
              group: ["cloudflare:*"],
              message:
                "@habenula-ai/credentials is a leaf package — no Cloudflare runtime imports. See the architecture whitepaper.",
            },
            {
              group: ["node:*"],
              message:
                "@habenula-ai/credentials runs inside the Workers runtime — Web Crypto only, no Node.js imports.",
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
    ignores: ["node_modules/", ".wrangler/"],
  }
);
