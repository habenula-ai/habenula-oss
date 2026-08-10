#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Loopback self-host validation harness. Builds the container from a tree, boots it
// on loopback, and
// drives the governance loop through a full container recreation, asserting
// that governed state persisted: the connected service survives, the audit
// chain's tail hash is unchanged (preservation), the whole retained chain
// recomputes clean (`log verify` exits 0), and a post-restart governed
// action's prevHash links onto that tail (extension). Two legs then prove
// `habenula up` treats the running container as a foreign engine: reported
// with its port recorded when the drive token answers, refused with nothing
// recorded when it does not. The dump legs then
// prove a dumped chain verifies offline with the engine down, and that
// `log dump - | log verify --file -` round-trips with dump's progress off
// stdout. Separate boots assert
// the debug surfaces (dev observability, direct execute) ship off by
// default, that a dead workerd child takes the
// daemon down instead of leaving it unresponsive, and that a placeholder or
// missing CREDENTIAL_ENCRYPTION_KEY refuses to boot.
//
// Zero-dependency plain Node: node built-ins + global
// fetch + the docker CLI. Every wait is a bounded poll, never a fixed sleep
// (the root Justfile `dev` idiom). Usage:
//
//   node packages/engine/scripts/validate-selfhost.mjs [tree-root]
//
// `tree-root` is where compose.yaml's build context lives — the packed OSS
// tree (`dist/oss`) in the monorepo, the repository root for a public cloner.
// Defaults to this script's own repo root. The monorepo root is rejected: its
// lockfile resolves private workspaces, so the in-container `npm ci` cannot
// work from it — run `just container-validate` instead.
//
// The harness runs under its own Compose project name and a non-default port,
// so its containers, network, and `down -v` can never touch a real local
// deployment (default project "engine", port 8787) or a dev loop.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const TREE = resolve(process.argv[2] ?? SCRIPT_REPO_ROOT);
// The stack definition and the user's .env both live at the tree root — the
// same layout the runbook teaches (compose.yaml ships via the OSS overlay).
const ENV_FILE = join(TREE, ".env");
// The CLI leg drives the built `habenula` bin — the exact command the
// runbook gives users. The invoking repo's root `npm ci` builds and links it
// (the packages/cli `prepare` script), pointed at the container over HTTP.
// The container itself is built from TREE — the shipped bytes are what is
// under validation; the packed tree's own install story is covered by
// `just oss-release-verify`.

const PORT = Number(process.env.HABENULA_VALIDATE_PORT ?? 8799);
const PROJECT = "habenula-validate";
const BASE = `http://127.0.0.1:${PORT}`;
// One userId across the HTTP and CLI legs, so both drive the same DO. This is
// the CLI's own default routing key.
const USER_ID = "cli-user";

// The wrangler.toml placeholder — public by design; the engine must refuse
// to boot under it. Written in full because the secret-scanner allowlist
// anchors on the whole 64-hex value — a partial/constructed form trips the
// generic-api-key rule instead of matching the allowlist.
const PLACEHOLDER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Shared caller token for the trusted /internal/mcp drive surface: the CLI's
// `status` verb drives it (only kill/quit are direct /api calls), and the
// engine 401s every internal request when INTERNAL_MCP_TOKEN is unset (fail
// closed). Provisioning it per run also proves the daemon forwards the
// binding into the Worker env.
const INTERNAL_TOKEN = randomBytes(16).toString("hex");

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

function run(cmd, args, { cwd, capture = false, allowFailure = false, timeoutMs, env } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: timeoutMs,
  });
  if (!allowFailure && (res.error !== undefined || res.status !== 0)) {
    fail(
      `\`${cmd} ${args.join(" ")}\` exited ${res.status ?? String(res.error)}` +
        (capture && res.stderr ? `\n${res.stderr}` : ""),
    );
  }
  return res;
}

function compose(args, opts = {}) {
  return run("docker", ["compose", "-p", PROJECT, ...args], { cwd: TREE, ...opts });
}

function composeCapture(args, opts = {}) {
  return compose(args, { capture: true, ...opts }).stdout ?? "";
}

function writeEnv(vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_FILE, `${lines.join("\n")}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (HTML pages); callers that need JSON assert on it
  }
  return { status: res.status, json, text };
}

// Bounded poll on the liveness probe: 240 × 500ms ≈ 2min
// after `up` returns — a slow boot delays the run rather than flaking it.
async function waitHealthy(attempts = 240) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  fail(`engine not healthy at ${BASE}/api/health after ${attempts} attempts`);
}

// The inverse poll, for the liveness leg: workerd owns the listening socket, so
// killing it stops the port accepting connections. Short bound — the socket goes
// with the process; this is not waiting on the daemon's own probe.
async function waitUnreachable(attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    } catch {
      return;
    }
    await sleep(500);
  }
  fail(`${BASE}/api/health still answers after the workerd child was killed`);
}

function restartCount(cid) {
  const res = run("docker", ["inspect", "-f", "{{.RestartCount}}", cid], { capture: true });
  const count = Number((res.stdout ?? "").trim());
  assert(Number.isInteger(count), `could not read RestartCount for ${cid}: ${res.stdout}`);
  return count;
}

function cli(args) {
  const res = run("npx", ["--no-install", "habenula", ...args], {
    cwd: SCRIPT_REPO_ROOT,
    capture: true,
    timeoutMs: 120_000,
    allowFailure: true,
    env: {
      ...process.env,
      HABENULA_API_URL: BASE,
      HABENULA_USER_ID: USER_ID,
      HABENULA_INTERNAL_MCP_TOKEN: INTERNAL_TOKEN,
    },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  console.log(out.trimEnd());
  return { status: res.status, out };
}

// The CLI with stdout and stderr KEPT SEPARATE (and optional stdin), for the
// dump legs: `log dump -` promises its data on stdout and its progress on
// stderr, and only separated streams can prove that. `cli()` above merges
// them for display, which would mask exactly that regression.
function cliRaw(args, input) {
  const res = spawnSync("npx", ["--no-install", "habenula", ...args], {
    cwd: SCRIPT_REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
      HABENULA_API_URL: BASE,
      HABENULA_USER_ID: USER_ID,
      HABENULA_INTERNAL_MCP_TOKEN: INTERNAL_TOKEN,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// `habenula up` against the container, in its own throwaway persist root.
// Every HABENULA_* value from the invoking shell is stripped so the leg
// proves the state a user is actually in; the container's port is told
// through HABENULA_PORT (it sits outside up's default scan range).
function cliUp(persistRoot, token) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HABENULA_")) env[key] = value;
  }
  const res = spawnSync("npx", ["--no-install", "habenula", "up"], {
    cwd: SCRIPT_REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...env,
      HABENULA_PERSIST_ROOT: persistRoot,
      HABENULA_PORT: String(PORT),
      HABENULA_USER_ID: USER_ID,
      HABENULA_INTERNAL_MCP_TOKEN: token,
    },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  console.log(out.trimEnd());
  return { status: res.status, out };
}

function preflight() {
  const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (version.error !== undefined || version.status !== 0) {
    fail("docker compose v2 is required — install Docker Desktop or OrbStack, then re-run.");
  }
  assert(
    existsSync(join(TREE, "compose.yaml")),
    `no compose.yaml at ${TREE} — pass the tree root (in the monorepo: run \`just container-validate\`, which packs to dist/oss).`,
  );
  assert(
    !existsSync(join(TREE, "kb")),
    "the monorepo root is not a supported build context (its lockfile resolves private workspaces). Run `just container-validate`, which builds from the packed dist/oss tree.",
  );
  assert(
    !existsSync(ENV_FILE),
    `refusing to overwrite ${ENV_FILE} — the harness writes its own throwaway .env there. Move yours aside first.`,
  );
}

async function persistenceRun() {
  step("1/16 build the image and boot on loopback");
  writeEnv({
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    INTERNAL_MCP_TOKEN: INTERNAL_TOKEN,
    HABENULA_PORT: PORT,
    // The persistence legs drive POST /api/tools/execute, which ships off
    // (404) — the harness is exactly the debug caller the gate exists for.
    // The default-off boot (step 14) runs WITHOUT this and asserts the 404.
    DEBUG_MODE: "true",
  });
  compose(["build"]);
  // Offline image-content check: workerd validates outbound TLS against the
  // SYSTEM CA store, which the slim base image does not ship — without it
  // every external HTTPS call from the engine (Anthropic, real OAuth
  // providers) fails at runtime. The harness's own loop is hermetic by
  // design, so this is the only place the regression is catchable in CI.
  const certs = compose(
    ["run", "--rm", "--no-deps", "engine", "test", "-s", "/etc/ssl/certs/ca-certificates.crt"],
    { capture: true, allowFailure: true },
  );
  assert(
    certs.error === undefined && certs.status === 0,
    "runtime image carries no system CA store (/etc/ssl/certs/ca-certificates.crt) — workerd's outbound TLS would fail; the Dockerfile runtime stage must install ca-certificates",
  );
  compose(["up", "-d"]);
  await waitHealthy();
  console.log(`✓ engine healthy at ${BASE}`);

  step("2/16 session start with the full 90-minute budget");
  let start = await api("POST", "/api/session/start", { userId: USER_ID });
  if (start.json?.status === "refused") {
    // A leftover session can only mean a previous run against a surviving
    // volume; end it and take a fresh clock.
    await api("POST", "/api/session/quit", { userId: USER_ID });
    start = await api("POST", "/api/session/start", { userId: USER_ID });
  }
  assert(
    start.status === 200 && start.json?.status === "started",
    `session start failed: ${start.status} ${start.text}`,
  );
  const expiry = Date.parse(start.json.activeSession?.expiry ?? "");
  const budgetMin = (expiry - Date.now()) / 60_000;
  assert(
    budgetMin >= 85,
    `session expiry leaves only ${budgetMin.toFixed(1)}min — steps 7–9 need the session to outlive the restart (determinism guard)`,
  );
  console.log(`✓ session started, ${budgetMin.toFixed(1)}min on the clock`);

  step("3/16 connect mock_email through the real OAuth machinery");
  const conn = await api("POST", `/connect/mock_email?userId=${USER_ID}`);
  assert(
    conn.status === 200 && typeof conn.json?.authorizeUrl === "string",
    `connect entry failed: ${conn.status} ${conn.text}`,
  );
  const consent = await fetch(new URL(conn.json.authorizeUrl, BASE), {
    signal: AbortSignal.timeout(10_000),
  });
  assert(consent.ok, `consent page failed: ${consent.status}`);
  const html = await consent.text();
  const approve = html.match(/class="approve" href="([^"]+)"/);
  assert(approve !== null, "consent page carries no approve link");
  // The href is HTML-escaped; &amp; is the only entity a URL picks up here.
  const approveUrl = new URL(approve[1].replaceAll("&amp;", "&"), BASE);
  const callback = await fetch(approveUrl, { signal: AbortSignal.timeout(10_000) });
  assert(callback.ok, `mock callback failed: ${callback.status}`);
  const services = await api("GET", `/api/services?userId=${USER_ID}`);
  assert(
    services.json?.services?.some((s) => s.service === "mock_email"),
    `mock_email not listed after connect: ${services.text}`,
  );
  console.log("✓ mock_email connected (credential minted, encrypted, stored)");

  step("4/16 governed execute: held, then granted for the session");
  const exec1 = await api("POST", "/api/tools/execute", {
    userId: USER_ID,
    toolName: "mock_email_send",
    params: {
      to: ["ops@example.com"],
      subject: "Self-host validation",
      body: "Sent by validate-selfhost.mjs (no real transmission — mock connector).",
    },
  });
  assert(
    exec1.json?.decision === "pending" && typeof exec1.json?.held?.heldCallId === "string",
    `mock_email_send was not held: ${exec1.status} ${exec1.text}`,
  );
  const resolved = await api("POST", "/api/resolve", {
    userId: USER_ID,
    heldCallId: exec1.json.held.heldCallId,
    choice: "session",
  });
  assert(
    resolved.status === 200 && resolved.json?.status === "resumed",
    `resolve(session) did not resume: ${resolved.status} ${resolved.text}`,
  );
  console.log("✓ held → session grant → executed");

  step("5/16 snapshot A: audit tail hash + connected service");
  const snapA = await api("GET", `/api/status?userId=${USER_ID}`);
  assert(typeof snapA.json?.auditTail?.hash === "string", `audit tail empty: ${snapA.text}`);
  assert(
    (snapA.json.held ?? []).length === 0,
    "a call is still parked before the restart — step 9 expects exactly the step-8 hold",
  );
  const tailHash = snapA.json.auditTail.hash;
  console.log(`✓ pre-restart tail hash H1 = ${tailHash.slice(0, 16)}…`);

  step("6/16 full container recreation (down → up; only the volume survives)");
  // `down` then `up`, not `docker restart`: the writable layer must die so
  // the proof is about the mounted volume.
  compose(["down"]);
  compose(["up", "-d"]);
  await waitHealthy();
  console.log("✓ recreated from the image");

  step("7/16 post-restart: state preserved (tail unchanged, service present)");
  const services2 = await api("GET", `/api/services?userId=${USER_ID}`);
  assert(
    services2.json?.services?.some((s) => s.service === "mock_email"),
    `mock_email lost across the recreation: ${services2.text}`,
  );
  const snapB = await api("GET", `/api/status?userId=${USER_ID}`);
  assert(
    snapB.json?.auditTail?.hash === tailHash,
    `audit tail moved across the recreation: ${snapB.json?.auditTail?.hash} ≠ H1`,
  );
  assert(snapB.json.session !== null, "session did not survive the recreation — the 90-minute clock is DO state and must persist");
  // Whole-chain integrity ALONGSIDE the anchored tail check above, never in
  // place of it: the tail hash was recorded BEFORE the restart, so that check
  // is anchored against a value the engine cannot retroactively change —
  // which is precisely what `log verify` lacks. The recompute proves every
  // retained link; the anchor proves the tip did not move.
  const verify = cliRaw(["log", "verify"]);
  assert(
    verify.status === 0,
    `log verify exited ${verify.status ?? "null"} after the restart (4 = unchecked edge, 3 = broken chain, 2 = unreachable):\n${verify.stdout}${verify.stderr}`,
  );
  assert(
    verify.stdout.includes("OK:"),
    `log verify exited 0 without reporting a verified range: ${verify.stdout}`,
  );
  console.log("✓ tail === H1; whole chain recomputes clean; mock_email still connected; session alive");

  step("8/16 chain extension: ungranted verb held, prevHash links onto H1");
  // `list` is a verb distinct from the granted `send` — asserted (held), not
  // assumed. The held call writes exactly one audit row, so the tail's
  // prevHash === H1 is the whole extension proof: a two-row write would leave
  // prevHash at the intermediate row, a zero-row write would leave the tail at
  // H1 itself, and an epoch rotation on boot would show prevHash = GENESIS.
  const exec2 = await api("POST", "/api/tools/execute", {
    userId: USER_ID,
    toolName: "mock_email_list",
    params: { label: "INBOX" },
  });
  assert(
    exec2.json?.decision === "pending",
    `mock_email_list was not held (decision: ${exec2.json?.decision}) — the distinct-verb precondition broke`,
  );
  const snapC = await api("GET", `/api/status?userId=${USER_ID}`);
  assert(typeof snapC.json?.auditTail?.hash === "string", `audit tail unreadable: ${snapC.text}`);
  assert(
    snapC.json.auditTail.prevHash === tailHash,
    `post-restart entry does not link onto H1: prevHash ${snapC.json.auditTail.prevHash} ≠ ${tailHash} (a GENESIS value here means the chain re-genesised on boot)`,
  );
  assert(snapC.json.auditTail.hash !== tailHash, "audit tail did not move — the held call wrote no row");
  console.log("✓ chain extended, not reset: prevHash === H1");

  step("9/16 CLI against the container: status shows the hold, kill, quit");
  const st = cli(["status"]);
  assert(st.status === 0, `CLI status exited ${st.status}`);
  assert(st.out.includes("mock_email · list"), "CLI status does not show the held mock_email · list call");
  const kill = cli(["kill"]);
  assert(kill.status === 0 && kill.out.includes("Kill switch activated"), `CLI kill failed (exit ${kill.status})`);
  const quit = cli(["quit"]);
  assert(quit.status === 0, `CLI quit exited ${quit.status}`);
  console.log("✓ CLI status / kill / quit all green");

  // The container is the one foreign engine the harness can produce for real,
  // and this is the last point where one is up. Each leg gets its own fresh
  // persist root: sharing one would leave the second leg reading the port the
  // first recorded, asserting the refusal from a warm config rather than from
  // the state a user is actually in.
  step("10/16 habenula up classifies the running container as a foreign engine");
  const upRootA = mkdtempSync(join(tmpdir(), "habenula-validate-up-"));
  try {
    const upOk = cliUp(upRootA, INTERNAL_TOKEN);
    assert(upOk.status === 0, `up against the container exited ${upOk.status ?? "null"}`);
    assert(
      upOk.out.includes("did not start it"),
      "up did not report the container as an engine it did not start",
    );
    assert(
      upOk.out.includes("Nothing was started"),
      "up did not state that it started nothing",
    );
    assert(
      !existsSync(join(upRootA, "engine.json")) && !existsSync(join(upRootA, "engine.log")),
      "up claimed a run slot or opened a log for an engine it did not start",
    );
    const upConfig = readFileSync(join(upRootA, "config"), "utf8");
    assert(
      upConfig.includes(`HABENULA_PORT=${PORT}`),
      `up did not record the container's port in its config: ${upConfig}`,
    );
    assert(
      !upConfig.includes("OAUTH_REDIRECT_BASE_URL"),
      "up recorded a redirect base for an engine it does not own",
    );
  } finally {
    rmSync(upRootA, { recursive: true, force: true });
  }
  console.log("✓ foreign engine reported, port recorded, nothing spawned");

  step("11/16 habenula up with a mismatched token refuses and records nothing");
  const upRootB = mkdtempSync(join(tmpdir(), "habenula-validate-up-"));
  try {
    const upBad = cliUp(upRootB, "not-the-container-token");
    assert(upBad.status === 1, `up with a wrong token exited ${upBad.status ?? "null"}, expected 1`);
    assert(
      upBad.out.includes("rejected") && upBad.out.includes("HABENULA_INTERNAL_MCP_TOKEN"),
      "up did not report the drive-token rejection with its remedy",
    );
    assert(
      !existsSync(join(upRootB, "config")) && !existsSync(join(upRootB, "engine.json")),
      "a refused up must record nothing",
    );
  } finally {
    rmSync(upRootB, { recursive: true, force: true });
  }
  console.log("✓ mismatched token refused, nothing recorded");

  step("12/16 dump the chain, stop the engine, verify the file offline");
  // The offline half of the verification claim: a dump taken from a live
  // engine must verify with NOTHING listening. The workers-pool suite cannot
  // cover this — it cannot stop the engine it runs inside.
  const dumpFile = join(TREE, ".validate-audit-dump.jsonl");
  const dump = cliRaw(["log", "dump", dumpFile]);
  assert(dump.status === 0, `log dump exited ${dump.status ?? "null"}:\n${dump.stderr}`);
  compose(["down"]); // engine gone; the volume survives for step 11
  await waitUnreachable();
  const offline = cliRaw(["log", "verify", "--file", dumpFile]);
  assert(
    offline.status === 0,
    `offline verify exited ${offline.status ?? "null"}:\n${offline.stdout}${offline.stderr}`,
  );
  assert(offline.stdout.includes("OK:"), `offline verify reported no verified range: ${offline.stdout}`);
  rmSync(dumpFile, { force: true });
  console.log("✓ dump verified offline with the engine down");

  step("13/16 pipe round trip: log dump - | log verify --file -");
  compose(["up", "-d"]);
  await waitHealthy();
  // BOTH stages' exit codes are asserted individually, not a pipeline's: a
  // shell pipeline reports only its last stage, so a dump that failed
  // mid-write would pass a check that reads $?.
  const piped = cliRaw(["log", "dump", "-"]);
  assert(piped.status === 0, `log dump - exited ${piped.status ?? "null"}:\n${piped.stderr}`);
  let manifest = null;
  try {
    manifest = JSON.parse(piped.stdout.split("\n", 1)[0] ?? "");
  } catch {
    // asserted below
  }
  assert(
    manifest !== null && manifest.habenulaAuditDump === 1,
    "dump's stdout does not begin with the manifest line — progress output leaked onto stdout",
  );
  assert(/page 1/.test(piped.stderr), "dump printed no page/byte progress on stderr");
  const pipeVerify = cliRaw(["log", "verify", "--file", "-"], piped.stdout);
  assert(
    pipeVerify.status === 0,
    `piped verify exited ${pipeVerify.status ?? "null"}:\n${pipeVerify.stdout}${pipeVerify.stderr}`,
  );
  console.log("✓ dump → verify round-trips through the pipe, progress off stdout");

  compose(["down", "-v"]);
}

async function defaultOffRun() {
  step("14/16 fresh-volume boot: debug surfaces off by default");
  // A fresh valid-key .env with neither VISUAL_MODEL nor DEBUG_MODE — the
  // persistence legs' .env deliberately opens the direct-execute gate, so this
  // leg writes its own. A separate boot so default-off is tested on its own.
  writeEnv({
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    HABENULA_PORT: PORT,
  });
  compose(["up", "-d"]);
  await waitHealthy();
  const devApi = await api("GET", `/api/dev/model?userId=${USER_ID}`);
  assert(devApi.status === 404, `/api/dev/model returned ${devApi.status}, expected 404 with VISUAL_MODEL unset`);
  const devPage = await api("GET", "/dev/model");
  assert(devPage.status === 404, `/dev/model returned ${devPage.status}, expected 404 with VISUAL_MODEL unset`);
  const execOff = await api("POST", "/api/tools/execute", {
    userId: USER_ID,
    toolName: "mock_email_list",
    params: { label: "INBOX" },
  });
  assert(
    execOff.status === 404,
    `/api/tools/execute returned ${execOff.status}, expected 404 with DEBUG_MODE unset`,
  );
  compose(["down", "-v"]);
  console.log("✓ /api/dev/model, /dev/model, and /api/tools/execute all 404");
}

// Kills the workerd child from inside the container. The slim base ships no
// pkill/pgrep, so this walks /proc with the image's own node — the binary the
// entrypoint already depends on — and SIGKILLs by process name.
const KILL_WORKERD_JS = `
const { readdirSync, readFileSync } = require("node:fs");
let killed = 0;
for (const pid of readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(pid)) continue;
  try {
    if (readFileSync("/proc/" + pid + "/comm", "utf8").trim() !== "workerd") continue;
    process.kill(Number(pid), "SIGKILL");
    killed += 1;
  } catch {}
}
if (killed === 0) {
  console.error("no workerd process found in the container");
  process.exit(1);
}
`;

// A workerd-only death is the one failure the container cannot see for itself:
// Miniflare never respawns the child, and the node parent outlives it, so an
// unsupervised daemon stays up with the port refusing connections. Recovery has
// to come from the daemon exiting — a healthcheck could not deliver it, because
// Docker restart policies act on container exit, not on health status.
async function runtimeLivenessRun() {
  step("15/16 dead workerd child: the daemon exits and the engine restarts");
  compose(["up", "-d"]);
  await waitHealthy();
  const cid = composeCapture(["ps", "-q", "engine"]).trim();
  assert(cid !== "", "no running container found for the liveness boot");
  const restartsBefore = restartCount(cid);
  const killed = run("docker", ["exec", cid, "node", "-e", KILL_WORKERD_JS], {
    capture: true,
    allowFailure: true,
  });
  assert(
    killed.error === undefined && killed.status === 0,
    `could not kill the workerd child (docker exec exited ${killed.status ?? String(killed.error)}): ${killed.stderr ?? ""}`,
  );
  await waitUnreachable();
  console.log("✓ workerd killed — the port stopped answering while the container stayed up");

  // The daemon's own probe has to notice and exit; restart: unless-stopped then
  // brings the engine back on the same volume. waitHealthy's 2min bound covers
  // the 45s worst-case detection plus a boot.
  await waitHealthy();
  const restartsAfter = restartCount(cid);
  assert(
    restartsAfter > restartsBefore,
    `engine answers again with no container restart (RestartCount ${restartsBefore} → ${restartsAfter}) — a daemon that survives its own dead runtime is the zombie this leg exists to catch`,
  );
  const logs = composeCapture(["logs", "engine"]);
  assert(
    logs.includes("runtime unresponsive"),
    "container restarted but the daemon logged no liveness refusal — recovery came from something other than the probe",
  );
  compose(["down", "-v"]);
  console.log(
    `✓ daemon exited, container restarted (RestartCount ${restartsBefore} → ${restartsAfter}), engine healthy again`,
  );
}

async function negativeBoots() {
  step("16/16 negative boots: placeholder and missing key are refused");
  const cases = [
    ["placeholder key", PLACEHOLDER_KEY, "publicly known dev placeholder"],
    ["missing key", "", "is not set"],
  ];
  for (const [label, key, expectMsg] of cases) {
    writeEnv({ CREDENTIAL_ENCRYPTION_KEY: key, HABENULA_PORT: PORT });
    compose(["up", "-d"]);
    const cid = composeCapture(["ps", "-aq", "engine"]).trim();
    assert(cid !== "", `no container found for the ${label} boot`);
    // The shipped compose carries restart: unless-stopped, so a refused boot
    // crash-loops rather than staying exited. `docker wait` blocks until the
    // next stop and prints that exit code — bounded by the timeout.
    const wait = run("docker", ["wait", cid], { capture: true, allowFailure: true, timeoutMs: 60_000 });
    assert(
      wait.error === undefined && wait.status === 0,
      `${label}: container did not exit within 60s — the guard did not refuse the boot`,
    );
    const exitCode = Number(wait.stdout.trim());
    assert(
      Number.isInteger(exitCode) && exitCode !== 0,
      `${label}: container exited ${wait.stdout.trim()}, expected non-zero`,
    );
    const logs = composeCapture(["logs", "engine"]);
    assert(logs.includes(expectMsg), `${label}: guard message ("…${expectMsg}…") missing from compose logs`);
    compose(["down", "-v"]);
    console.log(`✓ ${label} refused (exit ${exitCode}, guard message logged)`);
  }
}

async function main() {
  console.log(`validate-selfhost: tree ${TREE}`);
  console.log(`validate-selfhost: project ${PROJECT}, port ${PORT}, user ${USER_ID}`);
  preflight();
  try {
    await persistenceRun();
    await defaultOffRun();
    await runtimeLivenessRun();
    await negativeBoots();
    console.log("\nALL STEPS PASSED — the loopback self-host path is validated.");
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    // Diagnostics before teardown: state + recent logs of whatever is up.
    compose(["ps", "-a"], { allowFailure: true });
    compose(["logs", "--tail", "100", "engine"], { allowFailure: true });
    process.exitCode = 1;
  } finally {
    compose(["down", "-v", "--remove-orphans"], { allowFailure: true, capture: true });
    rmSync(ENV_FILE, { force: true });
  }
}

await main();
