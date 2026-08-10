#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// The `habenula` front door: forward every invocation to @habenula-ai/cli.
//
// The CLI is resolved by its own declaration — resolve its package.json, read
// the `bin.habenula` path that manifest declares, and import that file — so
// this forwarder holds no hardcoded path into the CLI: a CLI that moves its
// bundle cannot strand the shim. The bundle self-executes on import and owns
// argv, exit codes, signals, and the TTY; this file adds no wrapping. There
// is no second process until a command of the CLI's own spawns one.
//
// It also names the engine this install carries, the same way, in
// HABENULA_ENGINE_BIN. PATH cannot carry that fact on its own: npm links a
// dependency's bin into node_modules/.bin for an npx or project-local install,
// but a global install links this package's bin alone — so `up` would re-fetch
// an engine already on disk, or refuse. Naming it here makes one npm
// resolution enough on every install shape.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

// One refusal covers both ways the CLI can be unreachable: absent from the
// tree (a pruned or partly restored node_modules, a hoisting conflict with
// another @habenula-ai/cli) and present but declaring no bin. The resolve is
// the reachable half — unguarded it ends in a MODULE_NOT_FOUND stack naming a
// file inside this package, with no instruction in it.
function refuse(detail) {
  // eslint-disable-next-line no-console -- the forwarder's one refusal; the CLI owns all other output
  console.error(
    `habenula: ${detail} — reinstall this package, or run \`npx @habenula-ai/cli\` directly`,
  );
  process.exit(1);
}

const require = createRequire(import.meta.url);
let manifestPath;
try {
  manifestPath = require.resolve("@habenula-ai/cli/package.json");
} catch {
  refuse("@habenula-ai/cli is not installed alongside this package");
}
const bin = require(manifestPath).bin?.habenula;
if (typeof bin !== "string") {
  refuse("@habenula-ai/cli declares no `habenula` bin");
}

// An engine the caller already chose always wins, and a tree with no engine in
// it is the CLI's story to tell — it has three more ways to find one, and a
// refusal that names them. So this step is silent either way.
if (
  process.env.HABENULA_ENGINE_CMD === undefined &&
  process.env.HABENULA_ENGINE_BIN === undefined
) {
  try {
    const engineManifest = require.resolve("@habenula-ai/engine/package.json");
    const engineBin = require(engineManifest).bin?.["habenula-engine"];
    if (typeof engineBin === "string") {
      process.env.HABENULA_ENGINE_BIN = path.resolve(path.dirname(engineManifest), engineBin);
    }
  } catch {
    // no engine alongside this package — leave the variable unset
  }
}

await import(pathToFileURL(path.resolve(path.dirname(manifestPath), bin)).href);
