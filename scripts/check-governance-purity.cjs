#!/usr/bin/env node
// Regression guard for governance purity: evaluatePolicy is a
// PURE function — no side effects, no I/O, no logging. The invariant is
// enforced by a per-file `no-restricted-imports` + `no-restricted-globals`
// block in packages/governance/eslint.config.mjs, scoped to evaluate-policy.ts.
// It used to live in the engine (checked by check-import-boundary.cjs) and
// moved here with the file.
//
// The package bans node:*, the agents SDK, and cloudflare:* everywhere; the
// pure-function block is what additionally keeps the two evaluators free of the
// ambient side-effect globals. This asserts programmatically that both layers
// still bite — so a reordered config, a typo'd file glob, or an ESLint
// glob-semantics change on upgrade fails `just governance-lint` instead of
// passing silently. It lints fixture text through the package's real flat
// config (not a copy), so it tracks the config as it evolves.
//
// The chain modules moved to @habenula-ai/audit and took their own cases with
// them: scripts/check-audit-purity.cjs is the sibling guard.

const path = require("path");
const { createRequire } = require("module");

const pkgDir = path.join(__dirname, "..", "packages", "governance");
// eslint is a dependency of the governance package, not of scripts/ — resolve
// it from the package's module scope so this runs from any cwd.
const pkgRequire = createRequire(path.join(pkgDir, "package.json"));
const { ESLint } = pkgRequire("eslint");

const BOUNDARY_RULES = new Set([
  "no-restricted-imports",
  "no-restricted-globals",
]);

// [description, filePath (relative to pkgDir), source, expectedSubstring | null]
// expectedSubstring: a boundary rule must flag the source and name this token.
// null: no boundary rule may flag this file at all.
const CASES = [
  [
    "evaluate-policy.ts importing node:crypto is flagged (pure-function block, not the package default)",
    "src/evaluate-policy.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "node:crypto",
  ],
  [
    "evaluate-policy.ts importing the agents SDK is flagged",
    "src/evaluate-policy.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    "evaluate-policy.ts importing cloudflare:* is flagged",
    "src/evaluate-policy.ts",
    'import { env } from "cloudflare:workers";\nexport const e = env;\n',
    "cloudflare:workers",
  ],
  [
    "evaluate-policy.ts using the fetch global is flagged (no side effects)",
    "src/evaluate-policy.ts",
    "export const p = () => fetch(\"https://example.com\");\n",
    "fetch",
  ],
  [
    // The package-wide leaf boundary bans the agents SDK everywhere, even in
    // files the pure-function block does not govern.
    "policy.ts importing the agents SDK is flagged by the package-wide ban",
    "src/policy.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    // The node:* ban is package-wide now that the chain hash lives in
    // @habenula-ai/audit. Before the split it could only be a per-file rule,
    // because hash.ts needed the synchronous node:crypto createHash. This case
    // fails if a future change re-opens the package-wide allowance.
    "policy.ts importing node:crypto is flagged by the package-wide ban",
    "src/policy.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "node:crypto",
  ],
  // evaluate-spend.ts shares evaluate-policy.ts's per-file block (the glob
  // lists both files): the same cases must bite there.
  [
    "evaluate-spend.ts importing node:crypto is flagged (pure-function block, not the package default)",
    "src/evaluate-spend.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "node:crypto",
  ],
  [
    "evaluate-spend.ts importing the agents SDK is flagged",
    "src/evaluate-spend.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    "evaluate-spend.ts importing cloudflare:* is flagged",
    "src/evaluate-spend.ts",
    'import { env } from "cloudflare:workers";\nexport const e = env;\n',
    "cloudflare:workers",
  ],
  [
    "evaluate-spend.ts using the fetch global is flagged (no side effects)",
    "src/evaluate-spend.ts",
    "export const p = () => fetch(\"https://example.com\");\n",
    "fetch",
  ],
];

(async () => {
  const eslint = new ESLint({ cwd: pkgDir });
  const failures = [];

  for (const [desc, filePath, source, expected] of CASES) {
    const [result] = await eslint.lintText(source, {
      filePath: path.join(pkgDir, filePath),
    });
    const boundaryMessages = result.messages.filter((m) =>
      BOUNDARY_RULES.has(m.ruleId),
    );
    const rendered =
      boundaryMessages.map((m) => m.message).join("; ") || "(none)";

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
    console.error("Governance purity guard FAILED (evaluatePolicy must stay pure):");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }

  console.log(
    "Governance purity enforced (evaluate-policy.ts + evaluate-spend.ts pure-function blocks bite; the package-wide leaf ban covers node:*, agents, and cloudflare:*).",
  );
})().catch((err) => {
  console.error("Governance purity guard errored:", err);
  process.exit(1);
});
