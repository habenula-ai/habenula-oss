// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Protocol-level coverage of the trusted internal drive surface.
 * Drives `/internal/mcp` through the real
 * Worker fetch as raw JSON-RPC over Streamable HTTP — no SDK client — so the
 * assertions are on the wire the thin CLI client must speak: the initialize
 * handshake, `tools/list`, and `tools/call` for the three drive verbs
 * (`send` / `resolve` / `status`).
 *
 * Real DO, real Worker fetch (Hard Invariant #5) — no mocked primitives; a
 * deterministic text-only LLM is injected where a turn must complete.
 */
import { env } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  initializeMessage,
  internalRpc,
  toolPayload,
} from "./helpers/internal-rpc";
import { ENGINE_VERSION } from "../../src/mcp/commission-server";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

const TOKEN = "test-internal-caller-token-0291c";

beforeEach(() => {
  (env as { INTERNAL_MCP_TOKEN?: string }).INTERNAL_MCP_TOKEN = TOKEN;
});

/** A text-only LLM: no tool calls, so `send` completes the turn in one hop. */
const textOnly: LLMClient = {
  async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
    return {
      id: "m1",
      content: [{ type: "text", text: "hello from the agent" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4 },
    };
  },
};

async function initialize(userId?: string): Promise<string | undefined> {
  const init = await internalRpc(initializeMessage(1), { token: TOKEN, userId });
  expect(init.status).toBe(200);
  return init.sessionId;
}

describe("internal drive surface — Streamable HTTP protocol", () => {
  it("answers the initialize handshake as the habenula server", async () => {
    const { body, status } = await internalRpc(initializeMessage(1), {
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body?.error).toBeUndefined();
    const result = body?.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    expect(result.serverInfo.name).toBe("habenula");
    expect(result.serverInfo.version).toBe(ENGINE_VERSION);
    expect(typeof result.protocolVersion).toBe("string");
  });

  it("lists exactly the three drive verbs — send, resolve, status", async () => {
    const sessionId = await initialize();
    const { body } = await internalRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { token: TOKEN, sessionId },
    );
    expect(body?.error).toBeUndefined();
    const tools = (body?.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    expect(tools.sort()).toEqual(["resolve", "send", "status"]);
  });

  it("send runs a turn and returns a chat-shaped result", async () => {
    const userId = "internal-proto-send-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { setLLMClient: (c: LLMClient) => void }
      ).setLLMClient(textOnly);
    });

    const sessionId = await initialize(userId);
    const { body } = await internalRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "send", arguments: { message: "hi" } },
      },
      { token: TOKEN, sessionId, userId },
    );
    expect(body?.error).toBeUndefined();
    const turn = toolPayload<{
      response: string;
      toolCalls: unknown[];
      usage: { inputTokens: number; outputTokens: number };
      iterations: number;
    }>(body);
    expect(turn.response).toBe("hello from the agent");
    expect(Array.isArray(turn.toolCalls)).toBe(true);
    expect(turn.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(turn.iterations).toBeGreaterThanOrEqual(1);
  });

  it("status returns the governed-session snapshot shape", async () => {
    const userId = "internal-proto-status-user";
    const sessionId = await initialize(userId);
    const { body } = await internalRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      },
      { token: TOKEN, sessionId, userId },
    );
    expect(body?.error).toBeUndefined();
    const status = toolPayload<{
      session: unknown;
      grants: unknown[];
      held: unknown;
    }>(body);
    // No session started for this user → the null-session snapshot.
    expect(status.session).toBeNull();
    expect(status.grants).toEqual([]);
    expect(status.held).toEqual([]);
  });

  it("resolve on an unknown held-call id returns not_found", async () => {
    const userId = "internal-proto-resolve-user";
    const sessionId = await initialize(userId);
    const { body } = await internalRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "resolve",
          arguments: { heldCallId: "does-not-exist", choice: "deny" },
        },
      },
      { token: TOKEN, sessionId, userId },
    );
    expect(body?.error).toBeUndefined();
    expect(toolPayload(body)).toEqual({ status: "not_found" });
  });
});
