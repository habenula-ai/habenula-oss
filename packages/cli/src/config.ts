// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readConfigFile } from "./engine/config-file";
import { resolveEnginePaths, type EnginePaths } from "./engine/paths";
import { localDaemonHoldsPort } from "./engine/run-record";
import { stated } from "./engine/stated";

/**
 * Where `internalToken` came from, recorded so the 401 guidance can name the
 * reason instead of always naming the export. The three withheld values are the
 * three ways a file-held token declines to travel: the target is somewhere else
 * (`withheld-remote`), the file records no port to compare a target against
 * (`withheld-unrecorded`), or the recorded port is not held by a live engine
 * this config started (`withheld-unproven`).
 */
export type InternalTokenSource =
  | "env"
  | "file"
  | "withheld-remote"
  | "withheld-unrecorded"
  | "withheld-unproven"
  | "absent";

export interface Config {
  apiUrl: string;
  userId: string;
  /**
   * The trusted internal MCP drive surface: where the
   * CLI drives the agent (chat / resolve / status). Defaults to `/internal/mcp`
   * on the same origin as `apiUrl`; override with HABENULA_INTERNAL_MCP_URL.
   * Optional on the type so a test can build a minimal `Config`; `loadConfig`
   * always resolves it, and the client falls back to the `apiUrl`-derived URL.
   */
  internalMcpUrl?: string;
  /**
   * Shared-secret caller token for `internalMcpUrl`. Sent as
   * `Authorization: Bearer`. The engine 401s a missing or wrong token, so the
   * CLI can only drive the agent once this is provisioned to match the engine's
   * INTERNAL_MCP_TOKEN. It authenticates the CLI as a trusted caller — it is not
   * an OAuth credential. Resolves from the environment, else from the config
   * file — but the file's copy only travels to the local engine that file
   * describes (see `internalTokenSource`).
   */
  internalToken?: string;
  /**
   * Which of the token resolutions above actually happened. Optional on the
   * type so a test can build a minimal `Config`; `loadConfig` always sets it,
   * and a missing value reads as `absent`.
   */
  internalTokenSource?: InternalTokenSource;
  /** Human Touch presence gate: macOS Touch ID before an affirmative approval. Off by default. */
  humanTouch: boolean;
  /**
   * A config the CLI could not use: an unreadable or malformed config file, an
   * unusable persist root, or a stated port that is not a port. Carried rather
   * than thrown, because `loadConfig` runs before Commander parses and a config
   * fault must not take out the commands that read nothing from it — `--help`,
   * `--version`, and the offline `log verify --file`. Every request path raises
   * it first instead, so the refusal still lands before anything is dialled.
   * See `requireUsableConfig`.
   */
  configFault?: Error;
}

const DEFAULT_PORT = 8787;
const DEFAULT_USER_ID = "cli-user";

/**
 * One layer's answer about the local port. The three cases take three different
 * branches, so they cannot collapse into `number | null`: unset falls through to
 * the next layer, a port is used, and a malformed value is a fault. Silently
 * ignoring the malformed case is what made a typo'd port read as "engine not
 * reachable at http://localhost:8787" while the engine served 8788 and the file
 * said so.
 */
type PortRead =
  | { kind: "unset" }
  | { kind: "port"; port: number }
  | { kind: "malformed"; raw: string };

/**
 * Read one layer's HABENULA_PORT. The accepted shape mirrors the daemon's own
 * semantics: digits only, 1 through 65535.
 */
function readPort(raw: string | undefined): PortRead {
  const value = stated(raw);
  if (value === undefined) return { kind: "unset" };
  if (!/^\d+$/.test(value)) return { kind: "malformed", raw: value };
  const port = Number(value);
  if (port === 0 || port > 65535) return { kind: "malformed", raw: value };
  return { kind: "port", port };
}

/**
 * The loopback host spellings treated as one origin. The daemon binds
 * 127.0.0.1 and the recorded origin reads localhost, so a comparison that
 * split the spellings would withhold the file's own token from the engine the
 * file configures.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a URL names the local engine on the stated port: plain http, a
 * loopback host in any spelling, and exactly that port. This is the scope
 * check that keeps the file-held drive token from travelling to any other
 * target in an Authorization header.
 */
function isLocalEngineOrigin(urlString: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())) return false;
  const effectivePort = url.port === "" ? "80" : url.port;
  return effectivePort === String(port);
}

/** Injected seams. Production defaults read the real disk and process table. */
export interface ConfigDeps {
  /**
   * Whether a live local engine started from this config holds the given port —
   * the proof that scopes the file-held drive token. Defaults to the run-record
   * check; a test injects it rather than staging an engine.
   */
  daemonHoldsPort?: (port: number) => boolean;
}

/**
 * Load CLI configuration: environment first, then the config file under the
 * persist root (the file `habenula up` writes and the user may edit by hand).
 *
 * `fileVars` is read from disk when omitted; tests pass it directly (`null` for
 * "no file") so no test ever reads a developer's real ~/.habenula/config.
 *
 * Total by construction — it does not throw. A config it cannot use comes back
 * as `configFault` on the returned value, and the request paths raise that. The
 * reason is blast radius: this runs before Commander parses, so throwing here
 * takes out `--help`, `--version`, and the offline `log verify --file`, none of
 * which read a single value from the file. What must not happen is a *silently
 * dropped* variable — a lost INTERNAL_MCP_TOKEN line would 401 every drive call
 * with a message naming the wrong fix — and carrying the fault keeps that
 * property while narrowing what it breaks.
 *
 * Known debt: HABENULA_USER_ID is a hardcoded routing key, not real
 * authentication. Tracked in the technical backlog.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  fileVars?: Record<string, string> | null,
  deps: ConfigDeps = {},
): Config {
  let configFault: Error | undefined;
  const fault = (err: unknown): void => {
    configFault ??= err instanceof Error ? err : new Error(String(err));
  };

  // Both reads happen here rather than in a default argument, so a throw from
  // either lands in the fault instead of escaping to the caller.
  let paths: EnginePaths | undefined;
  let vars: Record<string, string> | null = fileVars ?? null;
  if (fileVars === undefined) {
    try {
      paths = resolveEnginePaths(env);
      vars = readConfigFile(paths.configPath);
    } catch (err) {
      fault(err);
      vars = null;
    }
  }

  // The local port has two sources, environment first: the escape-hatch
  // HABENULA_PORT is honoured for a run and never written back, so deriving
  // from the file alone would leave every later command in that shell dialling
  // the recorded port while the daemon serves the exported one. The run record
  // is deliberately not a source for the port — it is `up`'s and `down`'s
  // state, and a killed spawn can leave it behind.
  //
  // A malformed value at either layer is a fault, not a fall-through. Ignoring
  // it sends the CLI to 8787 and reports the engine as unreachable, which points
  // every signal in the output at the wrong subsystem.
  const envPort = readPort(env.HABENULA_PORT);
  if (envPort.kind === "malformed") {
    fault(portFault(envPort.raw, "HABENULA_PORT in your environment"));
  }
  const filePort = readPort(vars?.HABENULA_PORT);
  if (filePort.kind === "malformed") {
    fault(
      portFault(
        filePort.raw,
        `HABENULA_PORT in ${paths?.configPath ?? "your habenula config file"}`,
      ),
    );
  }
  const statedPort =
    envPort.kind === "port"
      ? envPort.port
      : filePort.kind === "port"
        ? filePort.port
        : null;

  const apiUrl =
    stated(env.HABENULA_API_URL) ??
    `http://localhost:${statedPort ?? DEFAULT_PORT}`;
  const internalMcpUrl =
    stated(env.HABENULA_INTERNAL_MCP_URL) ??
    new URL("/internal/mcp", apiUrl).toString();

  // The token-scope check is on the internal-MCP origin, not on apiUrl: the
  // token travels in a header addressed to internalMcpUrl, and
  // HABENULA_INTERNAL_MCP_URL can point that somewhere apiUrl does not. When
  // neither source states a port, the derivation above landed on the default —
  // a value the file never stated, which describes no engine — so the file's
  // token is withheld rather than compared against it.
  //
  // Matching the origin is necessary and not sufficient. A loopback address on
  // the recorded port identifies an address, not an engine, and any local
  // process can hold one — an `ssh -L 8787:host:8787` forward included. So the
  // last gate is a proof that a live engine this config started is the thing on
  // the other end; without it the file's copy of the drive secret would travel
  // to whatever answered.
  const daemonHoldsPort =
    deps.daemonHoldsPort ??
    ((port: number) =>
      paths !== undefined &&
      localDaemonHoldsPort(paths, port, (pid, signal) =>
        process.kill(pid, signal),
      ));

  const envToken = stated(env.HABENULA_INTERNAL_MCP_TOKEN);
  const fileToken = stated(vars?.INTERNAL_MCP_TOKEN);
  let internalToken: string | undefined;
  let internalTokenSource: InternalTokenSource;
  if (envToken !== undefined) {
    internalToken = envToken;
    internalTokenSource = "env";
  } else if (fileToken !== undefined) {
    if (statedPort === null) {
      internalTokenSource = "withheld-unrecorded";
    } else if (!isLocalEngineOrigin(internalMcpUrl, statedPort)) {
      internalTokenSource = "withheld-remote";
    } else if (!daemonHoldsPort(statedPort)) {
      internalTokenSource = "withheld-unproven";
    } else {
      internalToken = fileToken;
      internalTokenSource = "file";
    }
  } else {
    internalTokenSource = "absent";
  }

  return {
    apiUrl,
    userId:
      stated(env.HABENULA_USER_ID) ??
      stated(vars?.HABENULA_USER_ID) ??
      DEFAULT_USER_ID,
    internalMcpUrl,
    internalToken,
    internalTokenSource,
    // Value-based (not presence-based like HABENULA_NO_BANNER): a security-adjacent
    // opt-in must not switch on from a stray empty assignment. Unrecognized values
    // fail safe to off. `stated` keeps the reverse true as well — a blank
    // HABENULA_HUMAN_TOUCH= in the environment falls through to the file rather
    // than switching the gate off; an explicit "off" still wins.
    humanTouch: /^(1|true|yes|on)$/i.test(
      stated(env.HABENULA_HUMAN_TOUCH) ?? stated(vars?.HABENULA_HUMAN_TOUCH) ?? "",
    ),
    configFault,
  };
}

/** The refusal for a stated port that is not a port, naming which layer said it. */
function portFault(raw: string, where: string): Error {
  return new Error(
    `${where} is \`${raw}\`, which is not a port (digits only, 1-65535). Fix it — the CLI will not fall back to 8787 and report the engine as unreachable.`,
  );
}

/**
 * Raise a carried config fault at the first point a value from the config
 * matters. Every request path calls this before dialling, so a bad config still
 * refuses rather than guessing — but `--help`, `--version`, and the offline
 * `log verify --file` never reach it and keep working, which is the whole point
 * of carrying the fault instead of throwing it.
 *
 * The message names the escape hatch. A config file the user cannot fix from
 * memory must not be able to stand between them and `habenula kill`.
 */
export function requireUsableConfig(config: Config): void {
  if (config.configFault === undefined) return;
  throw new Error(
    `${config.configFault.message}\n  Set HABENULA_PORT and HABENULA_INTERNAL_MCP_TOKEN in your environment to bypass the config file for this command.`,
  );
}
