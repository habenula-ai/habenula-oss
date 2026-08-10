import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import { workerFetch, post, stubFor } from "../helpers/http";
import {
  initializeMessage,
  internalRpc,
  toolPayload,
} from "../mcp/helpers/internal-rpc";
import type { ChatResponse } from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolDefinition,
} from "../../src/llm/types";

/**
 * A fresh user with nothing connected still sees the full external tool
 * catalog, with every external tool tagged [NOT CONNECTED]. The model is made
 * aware of what is possible and steered (via the system prompt) to tell the
 * user to connect a service rather than calling it. The turn completes as
 * normal text.
 *
 * The `habenula` control-plane tools are the one exception: they hold no OAuth
 * credential, so they are always [CONNECTED], and an internal chat is offered
 * them — a fresh user can operate Habenula itself under governance without
 * connecting anything.
 *
 * Which tools reach the model is decided by the turn's `origin`, and origin is
 * set by the boundary, not by the DO: `/internal/mcp`'s `send` passes
 * `origin: "internal"` while `/api/chat` passes `origin: "human"`. So both
 * cases are driven over their real wire. A DO-direct test that hands
 * `origin` in by hand proves the DO's filter and nothing about the wiring that
 * chooses it.
 */

const TOKEN = "test-internal-caller-token-0116";

beforeEach(() => {
  (env as { INTERNAL_MCP_TOKEN?: string }).INTERNAL_MCP_TOKEN = TOKEN;
});

/** A text-only LLM that records the tool definitions it was offered. */
function catalogRecorder(): {
  client: LLMClient;
  seenTools: () => LLMToolDefinition[] | undefined;
} {
  let seen: LLMToolDefinition[] | undefined;
  return {
    client: {
      async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
        seen = params.tools;
        return {
          id: "msg_1",
          content: [
            { type: "text", text: "Hi! Connect a service to get started." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 8, output_tokens: 9 },
        };
      },
    },
    seenTools: () => seen,
  };
}

describe("fresh-user chat (full catalog, all unconnected)", () => {
  it("tags every external tool [NOT CONNECTED], and control-plane tools [CONNECTED], on an internal send", async () => {
    const userId = "fresh-user-internal";
    const recorder = catalogRecorder();

    await runInDurableObject(stubFor(userId), (instance) => {
      // Deliberately connect nothing.
      instance.setLLMClient(recorder.client);
    });

    // The trusted MCP drive surface is the one offered the control-plane tools,
    // and `send` is what marks the turn `internal`.
    const init = await internalRpc(initializeMessage(1), {
      token: TOKEN,
      userId,
    });
    expect(init.status).toBe(200);
    const sent = await internalRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { message: "hello" } },
      },
      { token: TOKEN, sessionId: init.sessionId, userId },
    );
    expect(sent.body?.error).toBeUndefined();
    const result = toolPayload<ChatResponse>(sent.body);

    expect(result.response).toContain("Connect a service");
    expect(result.toolCalls).toHaveLength(0);

    // The full catalog reaches the SDK. Every EXTERNAL tool is [NOT CONNECTED]
    // (nothing was connected); the credential-less control-plane tools are
    // [CONNECTED] and present, because `send` marked the turn internal.
    const seenTools = recorder.seenTools();
    expect(seenTools).toBeDefined();
    expect(seenTools!.length).toBeGreaterThan(0);
    const controlPlane = seenTools!.filter((t) => t.name.startsWith("habenula_"));
    const external = seenTools!.filter((t) => !t.name.startsWith("habenula_"));
    expect(external.length).toBeGreaterThan(0);
    for (const tool of external) {
      expect(tool.description).toMatch(/^\[NOT CONNECTED\] /);
    }
    expect(controlPlane.length).toBe(5);
    for (const tool of controlPlane) {
      expect(tool.description).toMatch(/^\[CONNECTED\] /);
    }
  });

  it("POST /api/chat is a human turn: same [NOT CONNECTED] catalog, no control-plane tools", async () => {
    const userId = "fresh-user-human";
    const recorder = catalogRecorder();

    await runInDurableObject(stubFor(userId), (instance) => {
      instance.setLLMClient(recorder.client);
    });

    const res = await workerFetch(post("/api/chat", { userId, message: "hello" }));
    expect(res.status).toBe(200);
    const result = (await res.json()) as ChatResponse;
    expect(result.response).toContain("Connect a service");

    // `/api/chat` is gated by network locality only, so it runs as `human` and
    // fails closed on the control plane. Reaching it requires the token-gated
    // internal surface. The external catalog is unchanged — being offered fewer
    // tools is about trust, not about what is connected.
    const seenTools = recorder.seenTools();
    expect(seenTools).toBeDefined();
    const controlPlane = seenTools!.filter((t) => t.name.startsWith("habenula_"));
    const external = seenTools!.filter((t) => !t.name.startsWith("habenula_"));
    expect(controlPlane).toHaveLength(0);
    expect(external.length).toBeGreaterThan(0);
    for (const tool of external) {
      expect(tool.description).toMatch(/^\[NOT CONNECTED\] /);
    }
  });
});
