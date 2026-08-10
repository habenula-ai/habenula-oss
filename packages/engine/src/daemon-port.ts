// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The habenula-engine daemon's listen-port input.
 *
 * Pure and dependency-free, and outside `src/daemon/` for the same reason
 * `credential-guard.ts` is: every module under `src/daemon/` reaches Miniflare,
 * which cannot load inside workerd, and the engine's one vitest project runs in
 * the Workers runtime. Keeping the parse here is what makes it unit-testable
 * beside the guard whose failure surface it matches.
 *
 * A port is not a bind address, so this input does not widen the loopback
 * boundary closes. `host` stays hardcoded per daemon
 * entrypoint, `127.0.0.1:9000` is exactly as loopback-only as
 * `127.0.0.1:8787`, and the engine's LOCALHOST_ONLY guard splits the port off
 * the Host header before judging it (`isLoopbackHost` in `src/http.ts`), so no
 * port value changes its verdict.
 */

/** The daemon's port when HABENULA_PORT is unset — wrangler dev's default too. */
export const DEFAULT_DAEMON_PORT = 8787;

/**
 * Resolve the daemon's listen port from a raw HABENULA_PORT value.
 *
 * Returns the port, or a human-readable refusal. The refusal shape mirrors
 * `validateCredentialKey`, so both daemon pre-flight failures print one line
 * and exit 1 rather than one printing and the other throwing a stack trace.
 *
 * Digits only, deliberately. `Number()` accepts `0x22`, ` 8787 `, `8.787e3` and
 * `+8787`; none is a port a user meant to type, and each would leave the daemon
 * serving somewhere its own docs do not describe.
 *
 * `0` is refused rather than forwarded. Miniflare hands workerd
 * `requestedPort ?? 0` and workerd binds a random free port for it, so the
 * daemon would come up where the CLI's default URL cannot reach it, with the
 * ready line the only record of where it went.
 */
export function resolveDaemonPort(
  raw: string | undefined,
): { port: number } | { refusal: string } {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { port: DEFAULT_DAEMON_PORT };

  if (!/^\d+$/.test(trimmed)) {
    return {
      refusal: `HABENULA_PORT must be a whole number, got "${raw}". Unset it to use the default ${DEFAULT_DAEMON_PORT}.`,
    };
  }

  const port = Number(trimmed);
  if (port === 0) {
    return {
      refusal: `HABENULA_PORT cannot be 0. Port 0 binds a random free port, which the CLI's default http://localhost:${DEFAULT_DAEMON_PORT} would not find. Set a fixed port.`,
    };
  }
  if (port > 65535) {
    return {
      refusal: `HABENULA_PORT must be between 1 and 65535, got ${port}. Unset it to use the default ${DEFAULT_DAEMON_PORT}.`,
    };
  }

  return { port };
}
