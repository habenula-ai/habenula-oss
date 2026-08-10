// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, isHealthShape, type FetchFn } from "../api-client";
import { InternalClient } from "../internal-client";
import type { Config } from "../config";

/**
 * The two questions `up` and `down` ask about a port. Every probe dials
 * 127.0.0.1 — the address the daemon actually binds — never `localhost`,
 * which can resolve to ::1 first and fail against a healthy engine. The
 * origins `up` records and prints stay `localhost`; that half belongs to the
 * callers.
 */

/**
 * Per-probe bound. The answer a scan wants is a refusal, and a refusal is
 * immediate; the bound exists for a listener that accepts the connection and
 * never answers, which classifies as `listener` — the fail-closed direction,
 * since walking past it would be walking past a possible engine.
 */
export const PROBE_TIMEOUT_MS = 1_000;

export type PortClass = "engine" | "listener" | "refused";

/**
 * Three-way classifier for a loopback port. `ApiClient.probeHealth` cannot
 * serve here: it collapses "connection refused" and "something non-engine is
 * listening" into one `false`, and those two answers take opposite branches —
 * one is a spawn, the other is a refusal.
 */
export async function classifyPort(
  port: number,
  deps: { fetchFn: FetchFn; timeoutMs?: number },
): Promise<PortClass> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? PROBE_TIMEOUT_MS,
  );
  try {
    const res = await deps.fetchFn(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    if (res.status !== 200) return "listener";
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      return "listener";
    }
    return isHealthShape(body) ? "engine" : "listener";
  } catch (err) {
    return connectionRefused(err) ? "refused" : "listener";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a fetch rejection means nothing is listening. Node wraps the socket
 * error as the TypeError's `cause`; a multi-address dial surfaces an
 * AggregateError whose members each carry a code. Only an unambiguous
 * ECONNREFUSED reads as refused — every other rejection (timeout, reset,
 * anything unrecognized) classifies as `listener`, the fail-closed direction.
 */
function connectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeCode = (cause as { code?: unknown } | null)?.code;
  if (causeCode === "ECONNREFUSED") return true;
  const members = (cause as { errors?: unknown[] } | null)?.errors;
  if (Array.isArray(members) && members.length > 0) {
    return members.every(
      (m) => (m as { code?: unknown } | null)?.code === "ECONNREFUSED",
    );
  }
  return false;
}

/**
 * Whether a running engine serves the visual model surface. `VISUAL_MODEL`
 * gates the page and the two `/api/dev/*` routes together and is read at
 * start, so this answers the only question `up --visual-model` has about an
 * engine it did not just spawn: is the surface already there, or does the
 * operator need a restart. `/api/dev/contracts` stands in for the page — same
 * gate, a small JSON body rather than the megabyte of inlined renderer.
 *
 * Anything other than a 200 reads as not served, the fail-closed direction:
 * printing a URL that 404s is worse than one extra restart instruction.
 */
export async function visualModelServed(
  port: number,
  deps: { fetchFn: FetchFn; timeoutMs?: number },
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? PROBE_TIMEOUT_MS,
  );
  try {
    const res = await deps.fetchFn(`http://127.0.0.1:${port}/api/dev/contracts`, {
      signal: controller.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type DriveTokenResult = "accepted" | "rejected" | "error";

/**
 * Whether the drive token answers on a loopback engine's `/internal/mcp`.
 * A `status` tool call through the existing InternalClient: a pure DO read
 * that starts no session and mints no grant. `rejected` is a 401 — the
 * caller-token guard said no; `error` is an engine that answered health and
 * not the drive surface, which callers treat as the same refusal shape.
 */
export async function driveTokenAccepted(
  port: number,
  opts: { token: string | undefined; userId: string },
  deps: { fetchFn: FetchFn },
): Promise<DriveTokenResult> {
  const config: Config = {
    apiUrl: `http://127.0.0.1:${port}`,
    userId: opts.userId,
    internalMcpUrl: `http://127.0.0.1:${port}/internal/mcp`,
    internalToken: opts.token,
    humanTouch: false,
  };
  const client = new InternalClient(config, deps.fetchFn);
  try {
    await client.getStatus();
    return "accepted";
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return "rejected";
    return "error";
  }
}
