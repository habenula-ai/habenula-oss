#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// The engine build, defined once for every consumer of dist/: the Dockerfile
// builder stage, the npm-publish path, and a hand run. Five steps in a fixed
// order — the daemon emit runs LAST so the credential-guard identity assertion
// below compares against what the module emit wrote, and the wrangler bundle
// runs first so a bundling failure aborts before any tsc output lands.
//
//   1. wrangler deploy --dry-run --outdir dist/worker   (the bundle the daemon executes)
//   2. tsc -p tsconfig.build.json                       (the module surface: dist/*.js + .d.ts)
//   3. copy src/dev-model/vendor/*.txt into dist/       (tsc emits only from .ts inputs; page.js imports the Text module)
//   4. tsc -p tsconfig.daemon.json                      (dist/daemon/** + dist/credential-guard.js), then the identity assertion
//   5. chmod 0755 dist/daemon/index.js + shebang assertion (matches packages/cli/build.mjs for the cli bin)
//
// Runs from packages/engine/ (the Justfile and Dockerfile both cd here).

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function run(cmd, args) {
  console.log(`[engine-build] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

// 1. Worker bundle — what the daemon boots under Miniflare. Two byproducts
// are dropped: the source map (5MB with every source embedded — the tarball
// ships no src/ while the license work is open, and the no-source-maps
// decision is one decision for all seven packages), and wrangler's generated
// README, whose embedded timestamp would break byte-reproducibility checks
// between builds.
run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", "dist/worker"]);
rmSync(join("dist", "worker", "index.js.map"), { force: true });
rmSync(join("dist", "worker", "README.md"), { force: true });

// The bundle inlines @habenula-ai/audit (MIT), whose notice must accompany
// copies of that code. Wrangler owns this build and exposes no esbuild
// legalComments knob, so prepend the same //! notice banner that
// packages/cli/build.mjs sets on its own bundle via esbuild. The notice then
// travels inside the shipped artifact (dist/worker ships in the tarball), not
// only in the sidecar NOTICE. Keep the wording in lockstep with the CLI banner.
const WORKER_BUNDLE = join("dist", "worker", "index.js");
const NOTICE_BANNER =
  "//! Habenula engine — AGPL-3.0-only. Bundles @habenula-ai/audit (MIT).\n" +
  "//! Full notices: the NOTICE file shipped alongside this bundle.\n";
const workerSrc = readFileSync(WORKER_BUNDLE, "utf8");
if (!workerSrc.startsWith("//! Habenula engine")) {
  writeFileSync(WORKER_BUNDLE, NOTICE_BANNER + workerSrc);
}

// 2. Module-surface emit.
run("npx", ["tsc", "-p", "tsconfig.build.json"]);

// 3. Text modules: tsc emits only from .ts inputs, but dist/dev-model/page.js
// imports the vendored cytoscape .txt beside it. Mirror the vendor dir.
const VENDOR_SRC = "src/dev-model/vendor";
const VENDOR_OUT = join("dist", "dev-model", "vendor");
mkdirSync(VENDOR_OUT, { recursive: true });
for (const name of readdirSync(VENDOR_SRC)) {
  if (name.endsWith(".txt")) copyFileSync(join(VENDOR_SRC, name), join(VENDOR_OUT, name));
}

// 4. Daemon emit — last, because it also writes dist/credential-guard.js
// (start.ts imports ../credential-guard.js, which sits above the daemon
// include but inside rootDir). The two emits may only differ if that file
// gains an import or an emit-affecting compiler option diverges between
// tsconfig.build.json and tsconfig.daemon.json — either would ship a daemon
// that loads a bundler-mode module, so the build fails instead.
const GUARD = join("dist", "credential-guard.js");
const moduleEmitGuard = readFileSync(GUARD);
run("npx", ["tsc", "-p", "tsconfig.daemon.json"]);
const daemonEmitGuard = readFileSync(GUARD);
if (!moduleEmitGuard.equals(daemonEmitGuard)) {
  console.error(
    `[engine-build] ${GUARD} differs between the module emit (tsconfig.build.json) and the daemon emit (tsconfig.daemon.json).\n` +
      "Cause is one of: credential-guard.ts gained an import, or an emit-affecting compiler option diverged between the two configs.\n" +
      "The daemon must not load a bundler-mode module — reconcile the configs (or the import) before shipping.",
  );
  process.exit(1);
}

// 5. The bin target must be directly executable: npm links it and the kernel
// reads the first line. tsc copies a leading shebang from the .ts input but
// never adds one, so assert it survived, then mark the file executable
// (matching packages/cli/build.mjs).
const BIN = join("dist", "daemon", "index.js");
const firstLine = readFileSync(BIN, "utf8").split("\n", 1)[0];
if (firstLine !== "#!/usr/bin/env node") {
  console.error(
    `[engine-build] ${BIN} does not start with '#!/usr/bin/env node' (got: ${JSON.stringify(firstLine)}).\n` +
      "The shebang lives in src/daemon/index.ts line 1; without it the kernel runs the bin as a shell script.",
  );
  process.exit(1);
}
chmodSync(BIN, 0o755);

console.log("[engine-build] OK: dist/worker, module surface, text modules, dist/daemon, bin executable.");
