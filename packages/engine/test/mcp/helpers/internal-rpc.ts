// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { SELF } from "cloudflare:test";

/**
 * POST one JSON-RPC message to `/internal/mcp` as a raw Streamable-HTTP client
 * (no SDK), mirroring the commission surface's `protocol.test.ts` helper. This
 * is the same wire the thin CLI client speaks: JSON-RPC 2.0 over HTTP POST with
 * a `Bearer` caller token, a response framed as plain JSON or an SSE `data:`
 * stream, and an `mcp-session-id` echoed across calls.
 *
 * `token` is sent as `Authorization: Bearer <token>` when provided, and omitted
 * entirely when undefined — so the auth suite can exercise the missing-header
 * path distinctly from the wrong-token path.
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export async function mcpRpc(
  path: string,
  message: Record<string, unknown>,
  opts: { token?: string; sessionId?: string; userId?: string } = {},
): Promise<{
  body: JsonRpcResponse | null;
  sessionId?: string;
  status: number;
}> {
  const { token, sessionId, userId } = opts;
  const url = userId
    ? `http://localhost${path}?userId=${encodeURIComponent(userId)}`
    : `http://localhost${path}`;
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  let body: JsonRpcResponse | null = null;
  if (text.trim().length > 0) {
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const payload =
      dataLines.length > 0 ? dataLines[dataLines.length - 1]! : text;
    try {
      body = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      body = null;
    }
  }
  return { body, sessionId: nextSession, status: res.status };
}

/** `mcpRpc` bound to the trusted internal drive route. */
export function internalRpc(
  message: Record<string, unknown>,
  opts: { token?: string; sessionId?: string; userId?: string } = {},
): Promise<{
  body: JsonRpcResponse | null;
  sessionId?: string;
  status: number;
}> {
  return mcpRpc("/internal/mcp", message, opts);
}

export function initializeMessage(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      // The pinned MCP spec revision. The server negotiates; the
      // caller asserts on what comes back.
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "internal-test", version: "0.0.0" },
    },
  };
}

/** The single content payload of a `tools/call` result, parsed from JSON. */
export function toolPayload<T = Record<string, unknown>>(
  body: JsonRpcResponse | null,
): T {
  const content = (body?.result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]!.text) as T;
}
