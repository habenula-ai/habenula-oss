// Tests for the umbrella package (node --test — plain Node, like the CLI it
// fronts; no Workers pool). Two halves:
//
//   1. The manifest contract. The release pairing rests on the two pins
//      living in `dependencies` (the publish driver's ordering guard ignores
//      devDependencies by design) and on Changesets rewriting them, so the
//      shape is asserted here, in the package whose shape it is.
//   2. The process boundary. Spawn the forwarder the way npx does and assert
//      the CLI actually answers through it — help text out, exit codes
//      propagated, a refusal that names a fix when the CLI is absent, and the
//      carried engine named in HABENULA_ENGINE_BIN. The bundle tests execute
//      the CLI's built bundle, so a missing bundle fails with the build
//      instruction, never a silent skip; the environment tests run against a
//      stub tree, because only a stub can report what it was handed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const BIN = path.join(PKG_ROOT, "bin.js");
const manifest = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

// Resolve the CLI bundle exactly as bin.js does, and fail with the fix when
// it has not been built — the forwarder would otherwise fail on import with
// an ENOENT that names no recipe.
function cliBundlePath() {
  const require = createRequire(import.meta.url);
  const cliManifestPath = require.resolve("@habenula-ai/cli/package.json");
  const bin = require(cliManifestPath).bin?.habenula;
  assert.equal(typeof bin, "string", "@habenula-ai/cli declares no `habenula` bin");
  return path.resolve(path.dirname(cliManifestPath), bin);
}

function runForwarder(args) {
  const bundle = cliBundlePath();
  assert.ok(
    existsSync(bundle),
    `no built CLI bundle at ${bundle} — run \`just cli-build\` from the repository root first`,
  );
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

// --- 1. the manifest contract --------------------------------------------------

test("manifest: exactly the two first-party pins, in dependencies, exact-pinned", () => {
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ["@habenula-ai/cli", "@habenula-ai/engine"],
    "the umbrella depends on the CLI and the engine, and on nothing else",
  );
  for (const [dep, version] of Object.entries(manifest.dependencies)) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
      `${dep} must be exact-pinned (no range operator) — Changesets rewrites the pin on every release`,
    );
  }
  // The publish driver's internal-edge guard reads dependencies /
  // optionalDependencies / peerDependencies and ignores devDependencies, so a
  // first-party pin parked there would silently skip the ordering guard.
  for (const section of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      assert.ok(
        !dep.startsWith("@habenula-ai/"),
        `${dep} sits in ${section} — the umbrella's first-party pins belong in dependencies`,
      );
    }
  }
});

test("manifest: the bin and files fields carry the forwarder and nothing else", () => {
  assert.deepEqual(manifest.bin, { habenula: "bin.js" });
  assert.deepEqual(manifest.files, ["bin.js"]);
  assert.equal(manifest.name, "habenula");
});

// --- 2. the process boundary ----------------------------------------------------

test("bin.js --help reaches the CLI: its help arrives with exit 0", () => {
  const res = runForwarder(["--help"]);
  assert.equal(res.status, 0, `--help exited ${res.status}: ${res.stderr}`);
  assert.match(
    `${res.stdout}${res.stderr}`,
    /Usage: habenula/,
    "the CLI's own help text should arrive through the forwarder unchanged",
  );
});

test("bin.js propagates a nonzero exit from the CLI", () => {
  const res = runForwarder(["definitely-not-a-command"]);
  assert.notEqual(res.status, 0, "an unknown subcommand must not exit 0 through the forwarder");
});

// A throwaway tree with the forwarder and stub dependencies: the stub CLI
// prints the engine hint it was handed, which is the only way to observe an
// environment variable set in a child process. The real CLI cannot answer the
// question — it would go on to start something.
function stubTree({ withEngine = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "habenula-forwarder-"));
  copyFileSync(BIN, path.join(dir, "bin.js"));
  const cliDir = path.join(dir, "node_modules/@habenula-ai/cli");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: "@habenula-ai/cli", version: "0.0.0", type: "module", bin: { habenula: "stub.js" } }),
  );
  writeFileSync(
    path.join(cliDir, "stub.js"),
    'console.log(`hint=${process.env.HABENULA_ENGINE_BIN ?? "(unset)"}`);\n',
  );
  let engineEntry = null;
  if (withEngine) {
    const engineDir = path.join(dir, "node_modules/@habenula-ai/engine");
    mkdirSync(path.join(engineDir, "dist/daemon"), { recursive: true });
    writeFileSync(
      path.join(engineDir, "package.json"),
      JSON.stringify({
        name: "@habenula-ai/engine",
        version: "0.0.0",
        bin: { "habenula-engine": "dist/daemon/index.js" },
      }),
    );
    engineEntry = path.join(engineDir, "dist/daemon/index.js");
    writeFileSync(engineEntry, "// daemon\n");
    // require.resolve returns a real path, and the temp root is behind a
    // symlink on macOS (/var → /private/var).
    engineEntry = realpathSync(engineEntry);
  }
  return { dir, engineEntry };
}

function runStubbed(dir, env = {}) {
  const res = spawnSync(process.execPath, [path.join(dir, "bin.js")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HABENULA_ENGINE_CMD: undefined, HABENULA_ENGINE_BIN: undefined, ...env },
  });
  assert.equal(res.status, 0, `forwarder exited ${res.status}: ${res.stderr}`);
  return res.stdout.trim();
}

test("bin.js names the engine this install carries, so up needs no PATH entry", () => {
  const { dir, engineEntry } = stubTree();
  try {
    // The install-shape fix: npm links no dependency command for a global
    // install, so PATH cannot carry this and the forwarder has to.
    assert.equal(runStubbed(dir), `hint=${engineEntry}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin.js leaves an engine the caller already chose alone", () => {
  const { dir } = stubTree();
  try {
    assert.equal(runStubbed(dir, { HABENULA_ENGINE_CMD: "node /my/own/daemon.mjs" }), "hint=(unset)");
    assert.equal(runStubbed(dir, { HABENULA_ENGINE_BIN: "/my/own/daemon.mjs" }), "hint=/my/own/daemon.mjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin.js stays silent when no engine sits alongside it: the CLI owns that story", () => {
  const { dir } = stubTree({ withEngine: false });
  try {
    assert.equal(runStubbed(dir), "hint=(unset)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bin.js refuses with an instruction when the CLI is not in the tree", () => {
  // Node resolves from the file's own location, so the forwarder is copied
  // somewhere with no node_modules above it — the shape a pruned or partly
  // restored install leaves behind. The refusal must name a fix; an unguarded
  // require.resolve would print a MODULE_NOT_FOUND stack instead.
  const dir = mkdtempSync(path.join(tmpdir(), "habenula-forwarder-"));
  try {
    copyFileSync(BIN, path.join(dir, "bin.js"));
    const res = spawnSync(process.execPath, [path.join(dir, "bin.js"), "--help"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /@habenula-ai\/cli is not installed alongside this package/);
    assert.match(res.stderr, /npx @habenula-ai\/cli/);
    assert.doesNotMatch(res.stderr, /MODULE_NOT_FOUND|Require stack/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
