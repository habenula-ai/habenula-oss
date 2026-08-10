// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-console -- daemon entrypoint: console is the intended output channel (the ready line and the pre-flight refusal). */
/**
 * habenula-engine daemon.
 *
 * Hosts the wrangler-bundled engine Worker under bare Miniflare — embedding
 * the same workerd the test suite runs — as an always-on local process. Runs
 * under Node from compiled output (dist/daemon/), never in the Workers
 * runtime. The two entrypoints (index.ts loopback, container.ts image) differ
 * only in the host they bind.
 *
 * Deliberately registers NO signal handlers: Miniflare's vendored
 * exit-hook@2.2.1 owns SIGTERM/SIGINT — it kills the workerd child and exits
 * 143, the conventional terminated-by-SIGTERM code Docker expects. Durability
 * rests on DO SQLite commit semantics, not on shutdown hooks. A miniflare
 * bump must re-verify that exit behavior.
 *
 * It does supervise itself: workerd owns the listening socket, Miniflare never
 * respawns a dead child, and this process outlives it on its own loopback
 * server — so an unsupervised daemon whose workerd died is up, silent, and
 * serving nothing. The liveness probe below turns that state into an exit.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { validateCredentialKey } from "../credential-guard.js";
import { resolveDaemonPort } from "../daemon-port.js";

/**
 * The Worker bindings forwarded from the daemon's environment — exactly the
 * HabenulaEnv surface (src/env.ts) (minus USER_AGENT, a DO binding, not an env var). Only
 * names present in process.env are forwarded, so unset optionals stay absent
 * in the Worker env rather than arriving as empty strings.
 *
 * This is an allowlist, and a name missing from it is dropped in silence: the
 * operator sets it in `.env`, the container starts clean, and the Worker never
 * sees it. Adding a variable to HabenulaEnv without adding it here is therefore a
 * bug on the container run path only, which `wrangler dev` cannot reproduce.
 * Every new provider's `*_CLIENT_ID`, `*_CLIENT_SECRET`, and
 * `OAUTH_REDIRECT_BASE_URL_<PROVIDER>` must land in both lists.
 */
const FORWARDED_BINDINGS = [
  "CREDENTIAL_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_ENDPOINT",
  "LLM_API_KEY",
  "LOCALHOST_ONLY",
  "INTERNAL_MCP_TOKEN",
  "VISUAL_MODEL",
  "DEBUG_MODE",
  "OAUTH_REDIRECT_BASE_URL",
  "OAUTH_REDIRECT_BASE_URL_GOOGLE",
  "OAUTH_REDIRECT_BASE_URL_SLACK",
  "OAUTH_REDIRECT_BASE_URL_MICROSOFT",
  "OAUTH_REDIRECT_BASE_URL_GITHUB",
] as const;

/**
 * Liveness-probe timings. The probe is a loopback `GET /api/health` — the
 * state-free liveness route, which sits above the engine's
 * credential-key guard, so it reports the runtime and nothing else. Worst-case
 * detection is interval × threshold (45s), and the probe stays silent until it
 * trips: the always-on daemon's output remains the single ready line.
 */
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_FAILURE_THRESHOLD = 3;

/**
 * Exit code for a runtime that stopped serving. Distinct from the daemon's two
 * other exits — 1 (a refused pre-flight or a runtime that never came up) and
 * 143 (SIGTERM, Miniflare's exit-hook) — so an operator reading a crash-loop
 * can tell which one fired.
 */
const EXIT_RUNTIME_UNRESPONSIVE = 70;

/**
 * Boot the engine under Miniflare on the given host and HABENULA_PORT (default
 * 8787). The pre-flight reuses the engine's own credential guard, so a refused
 * key exits 1 here with the byte-identical message the Worker fetch guard would
 * 503 with — the "identical failure surface" requirement.
 * The port refusal and a failed bind exit the same way, so every reason this
 * daemon declines to come up reads as one line rather than a stack trace.
 *
 * `host` takes no input on either entrypoint and must not gain one before
 * engine authentication ships. The port does, and does
 * not widen that boundary — see `../daemon-port.ts`.
 *
 * `fallbackPersistRoot` is where Durable Object state lands when
 * HABENULA_PERSIST_ROOT is unset: ~/.habenula for the loopback entry, /data
 * for the container (which also sets the variable, so the fallback is inert
 * there). Without it, Miniflare resolves the store to .mf/do relative to the
 * process working directory — two runs from two directories would silently
 * split one user's audit chain and connected services into two stores.
 */
export async function startDaemon(
  host: string,
  fallbackPersistRoot: string,
): Promise<void> {
  const refusal = validateCredentialKey(process.env.CREDENTIAL_ENCRYPTION_KEY);
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }

  const resolved = resolveDaemonPort(process.env.HABENULA_PORT);
  if ("refusal" in resolved) {
    console.error(resolved.refusal);
    process.exit(1);
  }
  const port = resolved.port;

  const bindings: Record<string, string> = {};
  for (const name of FORWARDED_BINDINGS) {
    const value = process.env[name];
    if (value !== undefined) bindings[name] = value;
  }

  // The wrangler dry-run bundle sits beside the compiled daemon:
  // dist/daemon/ (this file) · dist/worker/ (index.js + the Text .txt module).
  const bundleDir = fileURLToPath(new URL("../worker/", import.meta.url));

  const mf = new Miniflare({
    name: "habenula",
    modules: true,
    scriptPath: join(bundleDir, "index.js"),
    modulesRoot: bundleDir,
    modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { USER_AGENT: { className: "UserAgent", useSQLite: true } },
    defaultPersistRoot: process.env.HABENULA_PERSIST_ROOT ?? fallbackPersistRoot,
    durableObjectsPersist: true,
    host,
    port,
    bindings,
  });

  // Miniflare surfaces a busy port as MiniflareCoreError ERR_ADDRESS_IN_USE,
  // and its own message advises a `--port` flag this daemon does not have.
  // Catching it gives every startup failure the credential guard's shape: one
  // line naming the variable that fixes it, exit 1, no Node stack trace. Match
  // the code rather than the message text — ERR_ADDRESS_IN_USE is an exported
  // USER_ERROR_CODES member and stable across bumps in a way the prose is not.
  //
  // What this cannot suppress: workerd is a child process and Miniflare pipes
  // its stderr straight through, so a bind failure still prints workerd's own
  // `*** Fatal uncaught kj::Exception ... Address already in use` above our
  // line. Silencing it would mean taking over `handleRuntimeStdio` and
  // reimplementing the default pipe, which would also swallow genuine runtime
  // errors — a bad trade for cosmetics. Ours prints last, which is what the
  // reader acts on.
  let url: URL;
  try {
    url = await mf.ready;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      code === "ERR_ADDRESS_IN_USE"
        ? `habenula-engine: port ${port} is already in use. Set HABENULA_PORT to a free port and start again.`
        : `habenula-engine: the runtime failed to start — ${detail}`,
    );
    process.exit(1);
  }

  console.log(`habenula-engine ready at ${url.href}`);
  superviseRuntime(url);
}

/**
 * Exit when the engine stops answering on its own port.
 *
 * Miniflare gives workerd the entry socket (`--socket-addr`) and keeps the
 * child on private state: nothing is exported to watch it, no event fires when
 * it dies, and nothing respawns it. A workerd-only death — an in-container OOM
 * kill, an external signal — therefore leaves this process healthy-looking with
 * the port refusing connections. Exiting non-zero is what makes that
 * recoverable: under Compose the container exits and `restart: unless-stopped`
 * brings it back on the same persist volume, and on the bare `npx` path the
 * daemon stops instead of lying, which is the state the CLI already reports as
 * offline.
 *
 * The probe is HTTP over the bound port rather than a check on the child
 * process, so a workerd that is alive but no longer serving fails it too. It
 * asserts a 200 and nothing about the body: the daemon's dependency surface is
 * Miniflare and the credential guard, and the wire shape belongs to the
 * clients that consume it.
 *
 * `url` is Miniflare's own entry URL, already loopback for both entrypoints
 * (Miniflare maps a `0.0.0.0` bind to `127.0.0.1` when reporting it), so the
 * probe presents a loopback `Host` and passes the engine's LOCALHOST_ONLY
 * guard without the daemon deriving an address of its own.
 */
function superviseRuntime(url: URL): void {
  const probeUrl = new URL("/api/health", url);
  let consecutiveFailures = 0;

  const probe = async (): Promise<void> => {
    try {
      const res = await fetch(probeUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Drain before judging the status: an unconsumed body holds its socket
      // open, and this runs every interval for the life of the daemon.
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`unexpected status ${res.status}`);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures < PROBE_FAILURE_THRESHOLD) return;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `habenula-engine: runtime unresponsive — ${consecutiveFailures} consecutive ${probeUrl.pathname} probes failed (${reason}). Exiting ${EXIT_RUNTIME_UNRESPONSIVE} so the engine restarts.`,
      );
      process.exit(EXIT_RUNTIME_UNRESPONSIVE);
    }
  };

  // unref: the probe timer must never be the reason the process stays alive.
  setInterval(() => void probe(), PROBE_INTERVAL_MS).unref();
}
