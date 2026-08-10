// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ChatResponse,
  ResolveResponse,
  StatusResponse,
} from "@habenula-ai/contracts";
import { requireUsableConfig, type Config } from "./config";
import {
  ApiError,
  CHAT_DEADLINE_MS,
  CONTROL_DEADLINE_MS,
  EngineUnavailableError,
  type FetchFn,
  type ResolveChoice,
} from "./api-client";
import { nodeFetch } from "./transport";

/**
 * The CLI's client for the trusted internal MCP drive surface:
 * it drives the agent — `send` a message, `resolve` a
 * held confirmation, read `status` — over `/internal/mcp`. That surface is the
 * only one that reaches Habenula's control plane, and it does so through the
 * agent's own governed tool loop, not through any command this client sends.
 *
 * Deliberately thin and dependency-free: the
 * Streamable-HTTP transport is plain HTTP POST + JSON-RPC 2.0 framing + a
 * `Authorization: Bearer` caller token — the same request shape the CLI already
 * uses for `/api/*` — so NO `@modelcontextprotocol/sdk` and NO `zod` enter
 * `packages/cli`. The engine's server is stateless: a `tools/call` needs no
 * prior `initialize` handshake and carries no session id, so this client is a
 * single request per operation.
 *
 * It returns the SAME contract shapes the CLI already consumes (`ChatResponse`
 * / `ResolveResponse` / `StatusResponse`) and maps the tool payloads to the
 * SAME `ApiError`s the `/api/*` handlers ship — a busy turn to 409
 * `TURN_IN_PROGRESS`, an unknown held call to 404 — so it is a drop-in for the
 * `ApiClient` methods that drive the agent, and the REPL is unchanged.
 *
 * The `fetchFn` is injectable so tests supply a fake without monkey-patching
 * globals — the same seam `ApiClient` uses.
 */
/**
 * The three agent-driving operations, as a structural interface so `ApiClient`
 * can compose a real `InternalClient` in production and tests can inject a fake
 * without the class's private members. Each returns the same contract shape the
 * REPL already consumes.
 */
export interface InternalDriver {
  chat(message: string): Promise<ChatResponse>;
  resolve(heldCallId: string, choice: ResolveChoice): Promise<ResolveResponse>;
  getStatus(): Promise<StatusResponse>;
}

export class InternalClient implements InternalDriver {
  private nextId = 1;

  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchFn = nodeFetch,
  ) {}

  /** Run one agent turn from a user message (`send`). Minutes-scale deadline. */
  async chat(message: string): Promise<ChatResponse> {
    const payload = await this.toolCall(
      "send",
      { message },
      CHAT_DEADLINE_MS,
    );
    if (isBusy(payload)) {
      // The turn gate refused: a turn is already mid-flight. Same envelope the
      // `/api/chat` handler ships (return-kind rule; busy carries no data).
      throw new ApiError(
        409,
        "A turn is already in progress — wait for it to finish or resolve the pending confirmation first.",
        "TURN_IN_PROGRESS",
      );
    }
    return payload as ChatResponse;
  }

  /**
   * Answer a held confirmation (`resolve`). Control-scale deadline, matching
   * `ApiClient.resolve`. `not_found` (unknown/expired held call) and `busy` (a
   * turn mid-flight, the call stays parked) map to the same 404 / 409 the
   * `/api/resolve` handler ships, so the REPL's existing branches are unchanged.
   */
  async resolve(
    heldCallId: string,
    choice: ResolveChoice,
  ): Promise<ResolveResponse> {
    const payload = await this.toolCall(
      "resolve",
      { heldCallId, choice },
      CONTROL_DEADLINE_MS,
    );
    const status = (payload as { status?: string }).status;
    if (status === "not_found") {
      throw new ApiError(404, "held call not found");
    }
    if (status === "busy") {
      throw new ApiError(
        409,
        "A turn is already in progress — the call stays parked; try again.",
        "TURN_IN_PROGRESS",
      );
    }
    if (status === "invalid_choice") {
      // Parity with the /api/resolve route's 400. Without this the payload
      // would fall through as a `resumed` result and the prompt would
      // dereference `result.toolCalls` on undefined.
      throw new ApiError(
        400,
        (payload as { reason?: string }).reason ?? "invalid choice for this hold",
        "INVALID_CHOICE",
      );
    }
    return payload as ResolveResponse;
  }

  /** The governed-session snapshot (`status`). Control-scale deadline. */
  async getStatus(): Promise<StatusResponse> {
    const payload = await this.toolCall("status", {}, CONTROL_DEADLINE_MS);
    return payload as StatusResponse;
  }

  /**
   * Issue one `tools/call` and return the tool's JSON payload (the single text
   * content block, parsed). Throws `ApiError` on a JSON-RPC error, a tool-level
   * `isError` result, or a non-2xx HTTP status (401 → the caller-token guard);
   * `EngineUnavailableError` when the engine is unreachable or past deadline —
   * mirroring `ApiClient`'s availability contract exactly.
   */
  private async toolCall(
    name: string,
    args: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<unknown> {
    const envelope = await this.rpc(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      },
      deadlineMs,
    );
    if (envelope.error) {
      throw new ApiError(502, envelope.error.message || "internal engine error");
    }
    const result = envelope.result as
      | { content?: { text?: string }[]; isError?: boolean }
      | undefined;
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new ApiError(502, "malformed tool result from internal interface");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(502, "unparseable tool result from internal interface");
    }
    if (result?.isError) {
      // The server wraps a DO throw as `{ error }` with `isError: true` and
      // leaks no internals — surface its fixed string.
      const message =
        (payload as { error?: string }).error ?? "internal engine error";
      throw new ApiError(502, message);
    }
    return payload;
  }

  /**
   * POST one JSON-RPC message and parse the JSON-RPC envelope. The request core
   * mirrors `ApiClient.request`: it owns the deadline timer
   * so a timed-out fetch and a connection-refused fetch classify apart, and it
   * rethrows an `ApiError` from the HTTP layer unchanged. The Streamable-HTTP
   * response may be plain JSON or an SSE `data:` stream — both are handled.
   */
  private async rpc(
    message: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<JsonRpcEnvelope> {
    // Same choke point as ApiClient.request: an unusable config refuses before
    // the drive surface is dialled, and never at load time.
    requireUsableConfig(this.config);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    let gotResponse = false;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        // The server may answer as JSON or as an SSE stream; accept both.
        Accept: "application/json, text/event-stream",
      };
      if (this.config.internalToken !== undefined) {
        headers.Authorization = `Bearer ${this.config.internalToken}`;
      }
      const res = await this.fetchFn(this.url(), {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      gotResponse = true;
      return await this.parse(res);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (timedOut) {
        throw new EngineUnavailableError(this.baseUrl(), "deadline", err);
      }
      if (!gotResponse) {
        throw new EngineUnavailableError(this.baseUrl(), "reject", err);
      }
      // A failure after the `Response` existed rethrows raw — with the
      // buffering production transport that is a parse-side failure from a
      // reachable engine; the same post-`Response` rule `ApiClient` documents.
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse a Streamable-HTTP response into its JSON-RPC envelope. A non-2xx is
   * an `ApiError` (401 is the caller-token guard — surfaced with actionable
   * guidance). The body is framed as plain JSON or as SSE; for SSE, the last
   * `data:` line carries the response.
   */
  private async parse(res: Response): Promise<JsonRpcEnvelope> {
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) {
        throw new ApiError(
          401,
          unauthorizedGuidance(this.config.internalTokenSource),
          "UNAUTHORIZED",
        );
      }
      throw new ApiError(res.status, `internal interface error (${res.status})`);
    }
    const payload = extractJsonRpc(text);
    if (payload === null) {
      throw new ApiError(502, "empty response from internal interface");
    }
    try {
      return JSON.parse(payload) as JsonRpcEnvelope;
    } catch {
      throw new ApiError(502, "malformed response from internal interface");
    }
  }

  /**
   * The resolved internal-MCP base URL. `loadConfig` always sets
   * `internalMcpUrl`; the fallback covers a minimal `Config` (e.g. a test's) by
   * deriving the route from the same origin as the `/api/*` base.
   */
  private baseUrl(): string {
    return (
      this.config.internalMcpUrl ??
      new URL("/internal/mcp", this.config.apiUrl).toString()
    );
  }

  private url(): string {
    const u = new URL(this.baseUrl());
    u.searchParams.set("userId", this.config.userId);
    return u.toString();
  }
}

/**
 * The 401 guidance, branched on where the caller token came from — the fix a
 * user needs depends on which resolution actually happened, and "set the
 * export" is the wrong advice for four of the five. Exported for the tests
 * that pin each variant.
 */
export function unauthorizedGuidance(
  source: Config["internalTokenSource"],
): string {
  switch (source) {
    case "env":
      return "internal interface rejected the caller token — HABENULA_INTERNAL_MCP_TOKEN in your environment does not match the engine's INTERNAL_MCP_TOKEN";
    case "file":
      return "internal interface rejected the caller token — the INTERNAL_MCP_TOKEN in your habenula config file does not match the one this engine holds";
    case "withheld-remote":
      return "internal interface rejected the caller token — the config file's token was withheld because the target is not the local engine that file describes; set HABENULA_INTERNAL_MCP_TOKEN to that engine's token";
    case "withheld-unrecorded":
      return "internal interface rejected the caller token — the config file records no engine port yet, so its token was withheld; add HABENULA_PORT to the file, or set HABENULA_INTERNAL_MCP_TOKEN";
    case "withheld-unproven":
      return "internal interface rejected the caller token — the config file's token was withheld because no local engine started from that config is holding the recorded port; set HABENULA_INTERNAL_MCP_TOKEN to that engine's token";
    case "absent":
    case undefined:
      return "internal interface rejected the caller token — set HABENULA_INTERNAL_MCP_TOKEN to match the engine's INTERNAL_MCP_TOKEN";
  }
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function isBusy(payload: unknown): payload is { busy: true } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { busy?: unknown }).busy === true
  );
}

/**
 * Pull the JSON-RPC message out of a Streamable-HTTP body. SSE frames it as
 * one or more `event:`/`data:` lines — the last `data:` line is the message.
 * A plain-JSON body (no `data:` lines) is returned as-is. Returns null for an
 * empty body.
 */
function extractJsonRpc(text: string): string | null {
  if (text.trim().length === 0) return null;
  // SSE frames one event as one or more `data:` lines; the SSE spec concatenates
  // them with "\n" to form the field value. The engine sends a single-line
  // response today, but concatenate defensively so a future chunked framing
  // parses instead of keeping only the last fragment.
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length).trim());
  if (dataLines.length > 0) return dataLines.join("\n");
  return text;
}
