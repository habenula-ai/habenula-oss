#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-run validation harness: the `habenula up` / `habenula down` lifecycle
// end to end, against the BUILT `habenula` bin and the BUILT engine daemon.
// It asserts the promise the host-run path makes: a first run generates the
// shared secrets and starts a serving engine; every later command reaches
// that engine with no exports; a second `up` is idempotent; and `down` stops
// the daemon with no listener left on the port.
//
// A second pass then runs the same lifecycle through the habenula umbrella
// package's forwarder (packages/habenula/bin.js) in a fresh persist root, with
// no engine named in the environment and nothing Habenula on PATH. The first
// pass pins the engine command (resolution step 1), so it never exercises the
// step the umbrella's one-resolution install rides: the forwarder resolves the
// engine out of its own dependency tree and names it in HABENULA_ENGINE_BIN
// (step 2). Stripping PATH is what makes the pass prove that — with the
// workspace's node_modules/.bin on PATH, step 3 would serve the same daemon
// and the pass would hold even if the forwarder named nothing. A global
// install has no such link, which is the shape this reproduces.
//
// Zero-dependency plain Node, on validate-selfhost.mjs's pattern: node
// built-ins + global fetch. Every wait is a bounded poll, never a fixed
// sleep. The harness uses its own temporary persist roots and a non-default
// port, so it can never touch a real local deployment or a developer's
// ~/.habenula.
//
// Run it from the repository root (one-time per change under test):
//
//   node packages/cli/scripts/validate-host-run.mjs
//
// It builds nothing itself. Build the inputs first, from the repository root:
//
//   just cli-build
//   just engine-build

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const CLI_BIN = join(REPO_ROOT, "packages/cli/dist/index.js");
const ENGINE_DAEMON = join(REPO_ROOT, "packages/engine/dist/daemon/index.js");
const UMBRELLA_BIN = join(REPO_ROOT, "packages/habenula/bin.js");

const PORT = Number(process.env.HABENULA_VALIDATE_PORT ?? 8811);
const ROOT = mkdtempSync(join(tmpdir(), "habenula-validate-host-"));
const UMBRELLA_ROOT = mkdtempSync(join(tmpdir(), "habenula-validate-umbrella-"));
const CONFIG = join(ROOT, "config");

let currentStep = "preflight";

function step(label) {
  currentStep = label;
  console.log(`\n── ${label}`);
}

function fail(detail) {
  throw new Error(`FAIL [${currentStep}] ${detail}`);
}

function assert(cond, detail) {
  if (!cond) fail(detail);
}

// A minimal environment for the CLI under test: the process environment with
// every HABENULA_* value stripped, so nothing leaks in from the invoking
// shell and "no exports" means what it says. The persist root is the
// harness's own sandbox; the engine command points at the built daemon.
function harnessEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HABENULA_")) env[key] = value;
  }
  return {
    ...env,
    HABENULA_PERSIST_ROOT: ROOT,
    HABENULA_ENGINE_CMD: `${process.execPath} ${ENGINE_DAEMON}`,
    ...extra,
  };
}

function cli(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: harnessEnv(extraEnv),
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  console.log(out.trimEnd());
  return { status: res.status, out };
}

// The umbrella pass's environment: HABENULA_* stripped like harnessEnv, so no
// HABENULA_ENGINE_CMD and no HABENULA_ENGINE_BIN — the forwarder must supply
// the engine itself. PATH keeps only the entries that carry no Habenula bin,
// which is what a global install of the umbrella looks like: npm links this
// package's own command and nothing its dependencies declare.
function umbrellaEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HABENULA_")) env[key] = value;
  }
  const path = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && !existsSync(join(entry, "habenula-engine")))
    .join(delimiter);
  return {
    ...env,
    PATH: path,
    HABENULA_PERSIST_ROOT: UMBRELLA_ROOT,
    ...extra,
  };
}

function umbrella(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [UMBRELLA_BIN, ...args], {
    cwd: UMBRELLA_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: umbrellaEnv(extraEnv),
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  console.log(out.trimEnd());
  return { status: res.status, out };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function portAnswers() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForPortToRefuse(attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (!(await portAnswers())) return;
    await sleep(500);
  }
  fail(`http://127.0.0.1:${PORT}/api/health still answers after down`);
}

function recordedPid(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, "engine.json"), "utf8")).pid ?? null;
  } catch {
    return null;
  }
}

function preflight() {
  assert(
    existsSync(CLI_BIN),
    `no built CLI at ${CLI_BIN} — run \`just cli-build\` from the repository root first`,
  );
  assert(
    existsSync(ENGINE_DAEMON),
    `no built engine daemon at ${ENGINE_DAEMON} — run \`just engine-build\` from the repository root first`,
  );
}

async function main() {
  console.log(`validate-host-run: persist root ${ROOT}, port ${PORT}`);
  preflight();
  assert(!(await portAnswers()), `something is already answering on port ${PORT} — set HABENULA_VALIDATE_PORT to a free port`);

  try {
    step("1/4 first run: up generates the secrets and starts a serving engine");
    // The port is told once, on the establishing run; up records it, and no
    // later command needs it.
    const up = cli(["up"], { HABENULA_PORT: String(PORT) });
    assert(up.status === 0, `up exited ${up.status}`);
    assert(up.out.includes("Generated your engine secrets"), "up did not report generating the secrets");
    assert(up.out.includes(`Engine ready at http://localhost:${PORT}`), "up did not report the engine ready");
    const config = readFileSync(CONFIG, "utf8");
    assert(/CREDENTIAL_ENCRYPTION_KEY=[0-9a-f]{64}\n/.test(config), "config carries no generated credential key");
    assert(/INTERNAL_MCP_TOKEN=[0-9a-f]{32}\n/.test(config), "config carries no generated drive token");
    assert(config.includes(`HABENULA_PORT=${PORT}`), "config does not record the established port");
    assert(config.includes(`OAUTH_REDIRECT_BASE_URL=http://localhost:${PORT}`), "config does not record the derived redirect base");
    assert(await portAnswers(), "the engine is not answering after up reported ready");
    console.log("✓ generated, started, recorded");

    step("2/4 the CLI reaches the engine with no exports");
    // Nothing but the sandbox root: apiUrl derives from the recorded port and
    // the drive token resolves from the config file. This is the design's
    // first success metric — zero values matched by hand.
    const status = cli(["status"]);
    assert(status.status === 0, `status exited ${status.status} with no exports`);
    console.log("✓ status reached the engine through the recorded config alone");

    step("3/4 a second up is idempotent");
    const again = cli(["up"]);
    assert(again.status === 0, `second up exited ${again.status}`);
    assert(again.out.includes("already running"), "second up did not report already running");
    assert(again.out.includes(`http://localhost:${PORT}`), "second up did not name the running URL");
    console.log("✓ already running, nothing started twice");

    step("4/4 down stops it, with no listener left on the port");
    const down = cli(["down"]);
    assert(down.status === 0, `down exited ${down.status}`);
    assert(down.out.includes("Engine stopped"), "down did not report the stop");
    assert(down.out.includes("did not end your session"), "down did not state what stopping is not");
    await waitForPortToRefuse();
    assert(!existsSync(join(ROOT, "engine.json")), "down left the run record behind");
    console.log("✓ stopped, port refused, record removed");

    // Second pass: the same lifecycle through the umbrella forwarder, with no
    // engine named in the environment and no habenula-engine on PATH — the
    // forwarder has to name the engine in its own tree, the step a registry
    // install of `habenula` rides on every install shape. The first pass's
    // down freed the port, so the passes share it.
    step("umbrella 1/3 up through packages/habenula/bin.js resolves its carried engine");
    const uUp = umbrella(["up"], { HABENULA_PORT: String(PORT) });
    assert(uUp.status === 0, `umbrella up exited ${uUp.status}`);
    assert(
      uUp.out.includes(`Engine ready at http://localhost:${PORT}`),
      "umbrella up did not report the engine ready",
    );
    assert(await portAnswers(), "the engine is not answering after umbrella up reported ready");
    console.log("✓ forwarder → CLI → carried-engine resolution → daemon");

    step("umbrella 2/3 status answers through the forwarder");
    const uStatus = umbrella(["status"]);
    assert(uStatus.status === 0, `umbrella status exited ${uStatus.status}`);
    console.log("✓ status reached the engine through the forwarder");

    step("umbrella 3/3 down stops it and frees the port");
    const uDown = umbrella(["down"]);
    assert(uDown.status === 0, `umbrella down exited ${uDown.status}`);
    assert(uDown.out.includes("Engine stopped"), "umbrella down did not report the stop");
    await waitForPortToRefuse();
    assert(!existsSync(join(UMBRELLA_ROOT, "engine.json")), "umbrella down left the run record behind");
    console.log("✓ stopped, port refused, record removed");

    console.log("\nALL STEPS PASSED — the host-run path is validated, direct and through the umbrella.");
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    // Best-effort sweep: if a failure left a daemon up, stop it by pid.
    for (const root of [ROOT, UMBRELLA_ROOT]) {
      const pid = recordedPid(root);
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

await main();
