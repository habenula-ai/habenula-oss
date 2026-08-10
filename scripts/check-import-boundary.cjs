#!/usr/bin/env node
// Regression guard for the Cloudflare import
// boundary. The boundary is a `no-restricted-imports` block in
// packages/engine/eslint.config.mjs; its correctness otherwise rests on a
// manual planted-violation check that is discarded once
// run. This asserts it programmatically so a typo'd allowlist entry, a
// reordered config block, or an ESLint glob-semantics change on upgrade fails
// `just engine-lint` instead of passing silently.
//
// It lints fixture text through the engine's real flat config (not a copy),
// so it tracks the config as it evolves. Each case names the import the
// boundary must flag (or, for an allowlisted / out-of-scope path, that it must
// NOT flag), and we assert against the `no-restricted-imports` messages only.

const path = require("path");
const { createRequire } = require("module");

const engineDir = path.join(__dirname, "..", "packages", "engine");
// eslint is a dependency of the engine package, not of scripts/ — resolve it
// from the engine's module scope so this runs from any cwd.
const engineRequire = createRequire(path.join(engineDir, "package.json"));
const { ESLint } = engineRequire("eslint");

// [description, filePath (relative to engineDir), source, expectedSubstring | null]
// expectedSubstring: the boundary must flag the import and its message must
// name this specifier. null: the boundary must NOT flag this file at all.
const CASES = [
  [
    "business-logic file importing the agents SDK is flagged",
    "src/data/__boundary_probe.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    "business-logic file importing cloudflare:* is flagged",
    "src/data/__boundary_probe.ts",
    'import { env } from "cloudflare:workers";\nexport const e = env;\n',
    "cloudflare:workers",
  ],
  [
    // Behavioral floor: subpaths at any depth must be banned. (This holds under
    // both `agents/*` and `agents/**` — they are equivalent for module
    // specifiers — so this guards the requirement, not the specific glob.)
    "a deep agents subpath (two levels) is flagged",
    "src/data/__boundary_probe.ts",
    'import x from "agents/mcp/client";\nexport default x;\n',
    "agents/mcp/client",
  ],
  [
    "composition root (index.ts) is allowlisted, not flagged",
    "src/index.ts",
    'import { createMcpHandler } from "agents/mcp";\nexport const h = createMcpHandler;\n',
    null,
  ],
  [
    "composition root (user-agent.ts) is allowlisted, not flagged",
    "src/agent/user-agent.ts",
    'import { Agent } from "agents";\nexport const A = Agent;\n',
    null,
  ],
  [
    // The allowlist is a named file set, not a directory glob. A new sibling of
    // user-agent.ts must still be caught. This guards two regressions the
    // governance/ cases cannot: broadening `ignores` to a dir glob like
    // `src/agent/**`, and a new SDK-reaching file dropped beside the DO class.
    "a new sibling of the composition root in agent/ is flagged",
    "src/agent/__boundary_probe.ts",
    'import { Agent } from "agents";\nexport const A = Agent;\n',
    "agents",
  ],
];

(async () => {
  const eslint = new ESLint({ cwd: engineDir });
  const failures = [];

  for (const [desc, filePath, source, expected] of CASES) {
    const [result] = await eslint.lintText(source, {
      filePath: path.join(engineDir, filePath),
    });
    const boundaryMessages = result.messages.filter(
      (m) => m.ruleId === "no-restricted-imports",
    );
    const rendered = boundaryMessages.map((m) => m.message).join("; ") || "(none)";

    if (expected === null) {
      if (boundaryMessages.length > 0) {
        failures.push(`${desc}\n      expected NO boundary error, got: ${rendered}`);
      }
    } else if (!boundaryMessages.some((m) => m.message.includes(expected))) {
      failures.push(
        `${desc}\n      expected a boundary error naming "${expected}", got: ${rendered}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("Import-boundary guard FAILED:");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }

  console.log(
    "Import boundary enforced (agents/cloudflare:* confined to the composition root).",
  );
})().catch((err) => {
  console.error("Import-boundary guard errored:", err);
  process.exit(1);
});
