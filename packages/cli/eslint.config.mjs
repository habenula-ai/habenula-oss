import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLI is allowed to print — that is its job.
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
    },
  },
  {
    // The engine-lifecycle modules and the two commands composed from them may
    // not touch `process` at all — not env, not cwd, not pid, not kill. The
    // persist root and every effect must arrive as an argument, so a test can
    // never fall back to the developer's real ~/.habenula and rotate their
    // live engine state, and the composition root in index.ts stays the one
    // place that reads the real environment. `process` is deliberately absent
    // from languageOptions.globals here; no-restricted-globals reports the
    // reference either way, and test/eslint-process-ban.test.ts asserts it
    // keeps doing so.
    files: ["src/engine/**", "src/commands/up.ts", "src/commands/down.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "src/engine/** and the up/down commands may not read `process`: inject env, cwd, spawn, and kill as arguments (composition root: index.ts).",
        },
      ],
      // The door the global ban does not cover. The type shim declares no such
      // module today, so this is belt-and-braces for the day @types/node
      // arrives for some other reason.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:process",
              message:
                "src/engine/** and the up/down commands may not import `process`: inject effects as arguments (composition root: index.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["node_modules/"],
  }
);
