#!/usr/bin/env node
// Regression guard for audit-chain purity: verifyChainRange and
// checkDecisionClosure are PURE functions — no side effects, no I/O, no
// logging. They hold that discipline by design rather than by Hard Invariant #2
// (which names evaluate-policy.ts alone), and it is what lets a verdict be
// recomputed anywhere from a range of rows. The invariant is enforced by a
// per-file `no-restricted-imports` + `no-restricted-globals` block in
// packages/audit/eslint.config.mjs.
//
// The audit package allows node:* package-wide (hash.ts needs the synchronous
// node:crypto createHash), so the pure-function block is what keeps the
// verifier and the closure check stricter than their neighbour. This asserts
// programmatically that the block still bites — so a reordered config, a typo'd
// file glob, or an ESLint glob-semantics change on upgrade fails
// `just audit-lint` instead of passing silently. It lints fixture text through
// the package's real flat config (not a copy), so it tracks the config as it
// evolves.
//
// Sibling of scripts/check-governance-purity.cjs, which guards the evaluators
// the same way. One gate per package: the two packages allow node:* differently,
// and a single gate taught both would have to encode that difference twice.

const path = require("path");
const { createRequire } = require("module");

const pkgDir = path.join(__dirname, "..", "packages", "audit");
// eslint is a dependency of the audit package, not of scripts/ — resolve it
// from the package's module scope so this runs from any cwd.
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
  // verify-chain.ts's real node:crypto reach is transitive via the relative
  // ./hash import, which no-restricted-imports does not (and must not) flag.
  // A direct import is a different thing and is banned.
  [
    "verify-chain.ts importing node:crypto directly is flagged (inherited-only via ./hash)",
    "src/verify-chain.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "node:crypto",
  ],
  [
    "verify-chain.ts importing the agents SDK is flagged",
    "src/verify-chain.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    "verify-chain.ts importing cloudflare:* is flagged",
    "src/verify-chain.ts",
    'import { env } from "cloudflare:workers";\nexport const e = env;\n',
    "cloudflare:workers",
  ],
  [
    "verify-chain.ts using the fetch global is flagged (no side effects)",
    "src/verify-chain.ts",
    "export const p = () => fetch(\"https://example.com\");\n",
    "fetch",
  ],
  // decision-closure.ts shares verify-chain.ts's per-file block (the glob lists
  // both files): the same cases must bite there. Unlike verify-chain.ts it
  // imports nothing, so its node:* ban has no transitive exception at all.
  [
    "decision-closure.ts importing node:crypto is flagged (pure-function block)",
    "src/decision-closure.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    "node:crypto",
  ],
  [
    "decision-closure.ts importing the agents SDK is flagged",
    "src/decision-closure.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
  ],
  [
    "decision-closure.ts using the fetch global is flagged (no side effects)",
    "src/decision-closure.ts",
    "export const p = () => fetch(\"https://example.com\");\n",
    "fetch",
  ],
  [
    // Guards the other direction: the pure-function block must NOT over-reach
    // into hash.ts, which legitimately needs node:crypto's synchronous
    // createHash (the chain is hashed inside transactionSync — Web Crypto's
    // async digest can't be used there).
    "hash.ts importing node:crypto is NOT flagged",
    "src/hash.ts",
    'import { createHash } from "node:crypto";\nexport const h = createHash;\n',
    null,
  ],
  [
    // The package-wide leaf boundary still bans the agents SDK everywhere, even
    // in files the pure-function block does not govern.
    "hash.ts importing the agents SDK is flagged by the package-wide ban",
    "src/hash.ts",
    'import type { Agent } from "agents";\nexport type X = Agent;\n',
    "agents",
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
    console.error("Audit purity guard FAILED (the verifier and the closure check must stay pure):");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }

  console.log(
    "Audit purity enforced (verify-chain.ts + decision-closure.ts pure-function blocks bite; hash.ts node:crypto allowed).",
  );
})().catch((err) => {
  console.error("Audit purity guard errored:", err);
  process.exit(1);
});
