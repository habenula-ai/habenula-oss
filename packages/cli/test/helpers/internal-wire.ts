// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frame a tool payload exactly as the engine's Streamable-HTTP server does — an
 * SSE `event: message` / `data:` pair carrying the JSON-RPC envelope whose
 * single content block is the JSON-stringified payload. Modeled on the real
 * response captured in the engine's `internal-protocol` test. Shared by every
 * CLI test that fakes the `/internal/mcp` transport (chat / resolve / status
 * now drive through it).
 */
export function sseToolResult(payload: unknown, isError = false): string {
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      ...(isError ? { isError: true } : {}),
    },
  };
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** The tool name from a JSON-RPC `tools/call` request body, or null. */
export function toolNameOf(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      method?: string;
      params?: { name?: string };
    };
    return parsed.method === "tools/call" ? (parsed.params?.name ?? null) : null;
  } catch {
    return null;
  }
}
