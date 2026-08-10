// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import { ApiError, type ApiClient } from "../api-client";
import { printError } from "../errors";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

/** Ceiling on the best-effort cleanup POST, so a cancel can't hang on an
 * unresponsive Worker (the pending row ages out on its own TTL regardless). */
const ABANDON_TIMEOUT_MS = 3_000;

/** Ceiling on a single wait-loop status read. Without it a Worker that accepts
 * the connection but never responds (a half-open socket) would wedge the loop
 * inside a poll `await` — past the sleep race — leaving cancel unobserved until
 * that read returned. Bounding each read caps cancel latency and lets a stuck
 * read fall through to the next poll as a transient failure. Generous, so a
 * merely-slow-but-alive Worker is not abandoned mid-read. */
const POLL_READ_TIMEOUT_MS = 10_000;

/** 128 + SIGINT — the shell convention for a user cancel. Distinct from the
 * denied/expired/timeout exit (1) so scripts can tell "user cancelled" from
 * "timed out". */
export const EXIT_CANCELLED = 130;

export interface RunConnectOptions {
  /** Override for tests — defaults to spawning a platform-specific opener. */
  openBrowser?: (url: string) => void;
  /** Override for tests — defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests — defaults to Date.now. */
  now?: () => number;
  /**
   * The injected cancel channel: the wait loop exits
   * promptly when this aborts. Injected because the two entry points own
   * their input differently — the standalone command installs a SIGINT
   * handler for the call's duration; the REPL wires it to its own input
   * machinery so cancel never grabs stdin or exits the process.
   */
  cancelSignal?: AbortSignal;
  /** Override the wait ceiling (the `--timeout` flag). Default 5 minutes. */
  timeoutMs?: number;
}

/**
 * Connect a service through the single connect entry. The command is
 * service-generic: it posts the service name verbatim (the internal underscore
 * name, e.g. `mock_email`) and branches on the response — open the returned
 * authorize URL and poll for an OAuth service, report success for a
 * credential-less service, surface the error for an unknown name. Run without
 * a service, it enumerates the connectable set from the catalog endpoint; the
 * enumerated id is exactly the string to connect with. The catalog is
 * discovery only — no client-side name validation, the connect route stays
 * the authority on unknown names.
 */
export async function runConnect(
  client: ApiClient,
  service: string | undefined,
  opts: RunConnectOptions = {},
): Promise<number> {
  if (service === undefined) {
    try {
      const { services } = await client.getCatalog();
      console.log("Connectable services:");
      for (const s of services) {
        console.log(`  - ${s.service}`);
      }
      console.log("Run `habenula connect <service>` to connect one.");
      return 0;
    } catch (err) {
      if (err instanceof ApiError) {
        printError(err);
        return 1;
      }
      throw err;
    }
  }

  const signal = opts.cancelSignal;

  let response;
  try {
    response = await client.connect(service, signal);
  } catch (err) {
    // A cancel during the opening POST returns cleanly rather than surfacing an
    // AbortError: no flow handle exists yet (or its response never landed), so
    // there is nothing to abandon — the pending row, if the server created one,
    // ages out on its TTL.
    if (signal?.aborted) {
      console.log(`Cancelled connecting ${service}.`);
      return EXIT_CANCELLED;
    }
    if (err instanceof ApiError) {
      // Surface in the CLI's canonical format and return non-zero; `wrap`
      // propagates the code (it does not re-format a returned-code path).
      printError(err);
      // An unknown name is the one rejection discovery helps with: append
      // the connectable set (best-effort — the error above already stands).
      // Keyed on the machine-readable error code, not the message prose, so
      // rewording the engine's error never silently kills the hint.
      if (err.errorCode === "UNKNOWN_SERVICE") {
        await printConnectableHint(client);
      }
      return 1;
    }
    throw err;
  }

  // Credential-less service — connected directly, nothing to open.
  if ("connected" in response) {
    console.log(`Connected: ${service}`);
    return 0;
  }

  const url = response.authorizeUrl;
  const flow = response.flow;
  console.log(`Opening browser for ${service} OAuth flow:`);
  console.log(`  ${url}`);
  console.log("If the browser does not open, paste the URL above into it.");

  const open = opts.openBrowser ?? openInBrowser;
  open(url);

  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const start = now();

  // The persistent recovery cue: the way out must be
  // discoverable from a hung-looking terminal without prior knowledge.
  console.log(
    "Waiting for authorization… press Ctrl-C to cancel and return to the prompt.",
  );

  // The wait polls the flow's own status, not the connected-services list, so
  // it can exit early on a terminal outcome instead of running to the ceiling.
  // Every non-success exit issues the cleanup POST (`abandon`): on user cancel
  // and timeout it drops the still-pending row so no orphan survives; on
  // denied/expired the row is already terminal, so the same call is a harmless
  // idempotent no-op — issued uniformly rather than special-cased per exit.
  for (;;) {
    // Clamp the sleep to what remains before the deadline, so a `--timeout`
    // shorter than the poll interval is honored to the second instead of being
    // rounded up to a full interval. (The wait still sleeps before its first
    // poll: an immediate poll would only ever catch a just-opened flow as
    // pending — the user has not authorized yet — so it would waste a round
    // trip.)
    const remaining = Math.max(timeoutMs - (now() - start), 0);
    await abortableSleep(Math.min(POLL_INTERVAL_MS, remaining), sleep, signal);
    // Cancel takes priority. A cancel can race a just-completed authorization,
    // so confirm-poll once before declaring "cancelled": if the flow landed in
    // the meantime, report the truth (the connection is real) rather than a
    // misleading cancel. The confirm-poll is bounded (ABANDON_TIMEOUT_MS) so a
    // dead Worker can't turn the cancel into a hang; on any other status —
    // including an unreadable one — abandon and report the cancel.
    if (signal?.aborted) {
      try {
        const { status } = await client.getConnectFlowStatus(
          service,
          flow,
          AbortSignal.timeout(ABANDON_TIMEOUT_MS),
        );
        if (status === "connected") {
          console.log(`Connected: ${service}`);
          return 0;
        }
      } catch {
        // Status unreadable within the bound — fall through to the cancel path.
      }
      await abandon(client, flow);
      console.log(`Cancelled connecting ${service}.`);
      return EXIT_CANCELLED;
    }
    // Poll before the timeout check so a connect that lands during the final
    // sleep interval is reported as connected, not as a spurious timeout. The
    // read is bounded and cancel-armed (`readSignal`): a hung Worker can't wedge
    // the loop inside this await, and a cancel that fires mid-read aborts it —
    // the abort surfaces as a caught transient, the loop turns over, and the
    // sleep race resolves at once to run the cancel path.
    try {
      const { status } = await client.getConnectFlowStatus(
        service,
        flow,
        readSignal(POLL_READ_TIMEOUT_MS, signal),
      );
      if (status === "connected") {
        console.log(`Connected: ${service}`);
        return 0;
      }
      if (status === "denied") {
        await abandon(client, flow);
        console.error(`Authorization for ${service} was denied at the provider.`);
        return 1;
      }
      if (status === "expired") {
        await abandon(client, flow);
        console.error(
          `The ${service} authorization request expired — run connect again to retry.`,
        );
        return 1;
      }
      // "pending" — fall through to the timeout check.
    } catch {
      // Worker may be momentarily unreachable; fall through to the timeout
      // check and keep polling until the ceiling. This deliberately swallows an
      // EngineUnavailableError too: the wait rides out a transient engine outage
      // (e.g. a wrangler reload mid-OAuth) rather than aborting. Consequence for
      // the exit-2 availability contract: an engine that dies
      // *after* the flow opens is reported as a connect timeout (exit 1), not
      // exit 2 — exit 2 covers only the opening request, before a flow exists.
    }
    if (now() - start >= timeoutMs) {
      await abandon(client, flow);
      console.error(
        `Timed out waiting for ${service} to connect after ${Math.round(timeoutMs / 1000)}s.`,
      );
      return 1;
    }
  }
}

/**
 * Best-effort server-side cleanup of the pending flow. Cancel is idempotent
 * and the outcome message is already decided — a cleanup failure must never
 * mask it. Time-bounded (`ABANDON_TIMEOUT_MS`) so an unresponsive Worker can't
 * turn a cancel into an uninterruptible hang; the pending row ages out on its
 * own TTL if the POST never lands.
 */
async function abandon(client: ApiClient, flow: string): Promise<void> {
  try {
    await client.cancelConnectFlow(flow, AbortSignal.timeout(ABANDON_TIMEOUT_MS));
  } catch {
    // Timed out, aborted, or the Worker rejected it — the TTL is the backstop.
  }
}

/**
 * Sleep racing the cancel signal, so a cancel returns in milliseconds rather
 * than up to one poll interval. The underlying sleep is not torn down on
 * abort (a timer resolving late is harmless); the race just stops waiting.
 */
function abortableSleep(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    // Settle on either outcome: a sleep that rejects still just means "done
    // waiting", and must not leave this promise (and the wait loop) hung.
    void sleep(ms).then(settle, settle);
  });
}

/**
 * A per-read abort signal that fires on either a timeout or the wait's cancel
 * signal, whichever comes first. The timeout bounds a stuck read; the cancel
 * arm makes an in-flight read abort the moment Ctrl-C fires rather than after
 * it returns. `AbortSignal.any` owns its own listener teardown, so composing a
 * fresh one each poll does not accumulate listeners on the long-lived cancel
 * signal.
 */
function readSignal(ms: number, cancel?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return cancel ? AbortSignal.any([cancel, timeout]) : timeout;
}

/** Best-effort discovery hint after an unknown-service rejection. */
async function printConnectableHint(client: ApiClient): Promise<void> {
  try {
    const { services } = await client.getCatalog();
    console.error(
      `Connectable services: ${services.map((s) => s.service).join(", ")}`,
    );
  } catch {
    // Discovery is a hint; the rejection above is already reported.
  }
}

function openInBrowser(url: string): void {
  const opener = pickOpener();
  try {
    const child = spawn(opener.command, [...opener.args, url], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // The URL is already printed; failing to spawn an opener is non-fatal.
  }
}

function pickOpener(): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", ""] };
  }
  return { command: "xdg-open", args: [] };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
