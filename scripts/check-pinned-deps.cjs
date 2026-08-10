#!/usr/bin/env node
// Verifies all dependencies across all workspace packages use exact versions.
// Enforces an exact-semver *allowlist*, not a caret/tilde blocklist: only a
// strict `x.y.z` (optionally with prerelease/build metadata) is accepted, so
// ranges (`>=1`, `1 - 2`), wildcards (`*`, `1.x`), OR-ranges (`1 || 2`), and
// dist-tags (`latest`) are all rejected. One non-semver form is allowed because
// it is still exact: npm aliases whose aliased version is exact
// (`npm:zod@3.25.76`). The `workspace:` protocol is rejected — npm does not
// support it; workspace siblings are referenced by their exact version (npm
// links the local copy when it satisfies the pin). Scans dependencies,
// devDependencies, peerDependencies, and optionalDependencies.

const fs = require("fs");
const path = require("path");

// Optional root argument: the npm-publish driver runs this same check against
// the staging tree it materializes (both driver modes), not only the repo the
// script lives in. No argument keeps the historical behavior.
const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..");
const rootPkgPath = path.join(repoRoot, "package.json");

if (!fs.existsSync(rootPkgPath)) {
  if (process.argv[2]) {
    // An explicit root that has no package.json is a broken invocation, not a
    // repo without workspaces — fail closed rather than skipping enforcement.
    console.error(`ERROR: no package.json at explicit root ${repoRoot}`);
    process.exit(1);
  }
  console.log("No root package.json found — skipping dependency pin check.");
  process.exit(0);
}

const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const workspaceGlobs = rootPkg.workspaces || [];

// Collect all package.json paths to check
const pkgPaths = [rootPkgPath];

// Supports the two workspace forms in use: simple "packages/*" globs (monorepo
// root) and explicit paths like "packages/engine" (the packed OSS tree's
// overlay package.json). An entry that resolves to no package.json is a hard
// error — a silently skipped entry means zero enforcement for that package.
for (const glob of workspaceGlobs) {
  const matched = [];
  if (glob.endsWith("*")) {
    const dir = path.join(repoRoot, glob.replace(/\/?\*$/, ""));
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgFile = path.join(dir, entry.name, "package.json");
        if (fs.existsSync(pkgFile)) {
          matched.push(pkgFile);
        }
      }
    }
  } else {
    const pkgFile = path.join(repoRoot, glob, "package.json");
    if (fs.existsSync(pkgFile)) {
      matched.push(pkgFile);
    }
  }
  if (matched.length === 0) {
    console.error(
      `ERROR: workspace entry "${glob}" matched no package.json — the pin check cannot cover it.`
    );
    process.exit(1);
  }
  pkgPaths.push(...matched);
}

// Strict exact semver: MAJOR.MINOR.PATCH with optional -prerelease and +build.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

// True when a package.json version specifier pins an exact version.
function isExactPin(version) {
  if (typeof version !== "string") return false;
  // npm alias (`npm:<name>@<version>`): the aliased version must itself be exact.
  if (version.startsWith("npm:")) {
    const at = version.lastIndexOf("@");
    if (at < 0) return false; // no `@version` part → not pinned
    return EXACT_SEMVER.test(version.slice(at + 1));
  }
  return EXACT_SEMVER.test(version);
}

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const problems = [];

for (const pkgPath of pkgPaths) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const label = path.relative(repoRoot, pkgPath);
  for (const section of SECTIONS) {
    const deps = pkg[section] || {};
    for (const [name, version] of Object.entries(deps)) {
      if (!isExactPin(version)) {
        problems.push(
          `  ${label} > ${section} > ${name}: "${version}" — not an exact pin (use x.y.z or npm:<name>@x.y.z)`
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error("ERROR: Unpinned dependencies found:\n");
  problems.forEach((p) => console.error(p));
  console.error(
    "\nAll dependencies must use exact versions (no ranges, wildcards, or dist-tags). See CONTRIBUTING.md."
  );
  process.exit(1);
}

console.log("All dependencies are pinned to exact versions.");
