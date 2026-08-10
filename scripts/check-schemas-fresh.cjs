#!/usr/bin/env node
// Regenerates the committed Zod row schemas from the DDL registry and fails if
// they drift from what's checked in. The generated files under
// packages/engine/src/data/schemas/ are build artifacts of src/data/ddl.ts —
// this gate is the CI guard that a DDL change without a matching `just
// engine-codegen` run cannot land.

const { execSync } = require("child_process");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const engineDir = path.join(repoRoot, "packages", "engine");
const schemasRel = "packages/engine/src/data/schemas";

try {
  // `npx tsx` resolves the tsx binary from the nearest node_modules up the tree,
  // so it works whether npm hoists tsx to the repo root (the default) or keeps
  // it per-package. `--no-install` keeps it honest: if tsx is somehow absent,
  // fail fast rather than let npx fetch an unpinned copy from the registry
  // (deps are exact-pinned; see .npmrc). Matches the `codegen` recipe in
  // packages/engine/Justfile.
  execSync(`npx --no-install tsx src/data/codegen/generate.ts`, {
    cwd: engineDir,
    stdio: "pipe",
  });
} catch (err) {
  console.error("Schema codegen failed to run:");
  console.error(err.stdout?.toString() || "");
  console.error(err.stderr?.toString() || String(err));
  process.exit(1);
}

function fail(reason, detail) {
  console.error(
    `Generated schemas are stale. Run \`just engine-codegen\` and commit the result.\n${reason}` +
      (detail ? `\n${detail}` : ""),
  );
  process.exit(1);
}

// Drift in tracked/staged files: regeneration changed working-tree content that
// differs from the index. `git diff` compares working tree to index, so freshly
// staged-and-correct schemas (the pre-commit case) show no diff and pass.
try {
  execSync(`git diff --exit-code -- ${schemasRel}`, {
    cwd: repoRoot,
    stdio: "pipe",
  });
} catch (err) {
  fail("Regeneration changed committed schema content.", err.stdout?.toString());
}

// A brand-new table emits a schema file `git diff` can't see. Untracked (and
// not staged) generated files must be added before commit.
const untracked = execSync(
  `git ls-files --others --exclude-standard -- ${schemasRel}`,
  { cwd: repoRoot },
)
  .toString()
  .trim();
if (untracked) {
  fail("Untracked generated schema files are not committed:", untracked);
}

console.log("Generated schemas are up to date.");
