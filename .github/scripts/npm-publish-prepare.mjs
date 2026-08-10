#!/usr/bin/env node
// The published-manifest transform: what a tarball's package.json carries that
// the committed one does not. Pure and table-driven — the table below is the
// reviewable artifact, and a unit test asserts it covers every subpath the
// committed manifests declare (plus the deliberate additions in
// ADDED_ENTRIES, and nothing else).
//
// The committed trees stay working workspaces that resolve ./src/*.ts; only
// the staged copy this script rewrites points at dist/. It runs in the publish
// job's ephemeral staging tree — nothing it writes is ever committed.
//
// Scope is deliberately narrow: `private`, the entry points, and `scripts`.
// No dependency edge, no version, no package name — the pin re-check in the
// driver is the tripwire that catches this scope widening later.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-package published entry points. `exports` maps subpath → dist target.
 * cli publishes as bin-only: no main, no types, no exports.
 *
 * No `types` condition anywhere: for a subpath resolving to ./dist/x.js,
 * TypeScript finds the sibling ./dist/x.d.ts on its own, so the map stays
 * minimal and matches the shape the committed manifests already have.
 */
export const ENTRY_TABLE = {
  contracts: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      "./requests": "./dist/requests/index.js",
      "./responses": "./dist/responses/index.js",
    },
  },
  credentials: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      "./*": "./dist/*.js",
    },
  },
  governance: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      "./*": "./dist/*.js",
    },
  },
  audit: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      "./*": "./dist/*.js",
    },
  },
  tools: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      "./services/*": "./dist/services/*.js",
    },
  },
  engine: {
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": "./dist/index.js",
      // An exports map hides every other path in the package, package.json
      // included. The unscoped `habenula` forwarder reads this manifest to
      // find the daemon bin the install carries, so the map has to leave it
      // reachable — without this the forwarder resolves nothing and `up`
      // re-fetches an engine already on disk.
      "./package.json": "./package.json",
    },
  },
  cli: {},
  habenula: {},
};

/**
 * Table entries with no committed counterpart, per package — the deliberate
 * additions. No committed manifest declares `main` or `types` (workspaces
 * resolve through `exports`), so those two ride every publishing row; engine
 * additionally gains its `.` export, because it commits no entry points at
 * all, and `./package.json`, which its own exports map would otherwise hide
 * from the umbrella forwarder. cli publishes bin-only and adds nothing. An
 * addition not listed here fails this module's own coverage test.
 */
export const ADDED_ENTRIES = {
  contracts: ["main", "types"],
  credentials: ["main", "types"],
  governance: ["main", "types"],
  audit: ["main", "types"],
  tools: ["main", "types"],
  engine: [".", "./package.json", "main", "types"],
};

/**
 * Rewrite one staged package.json in place: publishable, dist-pointing,
 * script-free. Returns the transformed manifest object.
 */
export function transformManifest(pkgDir, pkgShortName) {
  const table = ENTRY_TABLE[pkgShortName];
  if (table === undefined) {
    throw new Error(`npm-publish-prepare: no entry-table row for package "${pkgShortName}"`);
  }
  const manifestPath = join(pkgDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  manifest.private = false;
  delete manifest.scripts;
  if (table.main !== undefined) manifest.main = table.main;
  if (table.types !== undefined) manifest.types = table.types;
  if (table.exports !== undefined) manifest.exports = table.exports;

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Engine only: retarget the shipped wrangler.toml's `main` from the TypeScript
 * source to the packed Worker bundle. Touches nothing else in the file —
 * bindings, migrations, compatibility settings, and the Worker name all ship
 * unchanged (the name-collision warning lives in the engine README).
 */
export function retargetWranglerToml(pkgDir) {
  const tomlPath = join(pkgDir, "wrangler.toml");
  if (!existsSync(tomlPath)) {
    throw new Error(`npm-publish-prepare: expected ${tomlPath} to exist for the engine package`);
  }
  const toml = readFileSync(tomlPath, "utf8");
  const retargeted = toml.replace(/^main = "src\/index\.ts"$/m, 'main = "dist/worker/index.js"');
  if (retargeted === toml) {
    throw new Error(
      'npm-publish-prepare: wrangler.toml has no `main = "src/index.ts"` line to retarget — the committed shape changed and this transform must be updated with it',
    );
  }
  writeFileSync(tomlPath, retargeted);
}
