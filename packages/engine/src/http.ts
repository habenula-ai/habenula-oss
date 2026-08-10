// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * JSON response with the demo CORS headers. Shared by every engine route
 * handler. The mock authorizer in @habenula-ai/tools receives this via
 * injection (`handleMockAuthorize(..., json)`) rather than importing it, so the
 * engine's transport policy stays at its composition root.
 */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

// "[::1]" only: an unbracketed IPv6 host never survives the port split, so a
// bare "::1" entry would imply coverage that does not exist.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(hostWithPort: string): boolean {
  // Host may carry a port; IPv6 hosts are bracketed ([::1]:8787). Hostnames
  // are case-insensitive (RFC 4343) — lowercase before the lookup so
  // `LOCALHOST` is not over-rejected.
  const lowered = hostWithPort.toLowerCase();
  const host = lowered.startsWith("[")
    ? lowered.slice(0, lowered.indexOf("]") + 1)
    : lowered.split(":")[0]!;
  return LOOPBACK_HOSTNAMES.has(host);
}

/**
 * Localhost hardening, Worker-wide: reject a
 * request whose Host is not loopback (a DNS-rebound request carries the
 * attacker's Host) or that carries a non-loopback Origin (a browser drive-by;
 * non-browser MCP/CLI clients send no Origin and pass). Runs before ALL
 * routing — hardening /mcp alone would be theater while /api/chat sits open.
 * Returns the 403 to send, or null to admit.
 */
export function rejectNonLocal(request: Request): Response | null {
  // Prefer the Host header; fall back to the request URL's host (workerd
  // derives request.url from Host, and some environments — the test harness
  // among them — don't surface Host as a readable header).
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!host || !isLoopbackHost(host)) {
    return json({ error: "local requests only" }, 403);
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).host)) {
        return json({ error: "local requests only" }, 403);
      }
    } catch {
      return json({ error: "local requests only" }, 403);
    }
  }
  return null;
}
