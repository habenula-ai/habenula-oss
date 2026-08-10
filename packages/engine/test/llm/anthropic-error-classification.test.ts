import Anthropic from "@anthropic-ai/sdk";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  classifyLLMError,
  createAnthropicClient,
} from "../../src/llm/anthropic-client";
import { UpstreamLLMError } from "../../src/llm/errors";

/**
 * `classifyLLMError` decides which Anthropic SDK failures are retryable upstream
 * conditions. Retryable — connection/timeout (no status), `408`, `429`,
 * and any `5xx` (incl. `529 overloaded`) — is wrapped as `UpstreamLLMError` so
 * the API boundary returns a friendly `503`. A `4xx` other than 408/429 (a
 * malformed request — our bug) is NOT retryable and propagates unchanged, to
 * surface as a structured `500`.
 */
describe("classifyLLMError", () => {
  const apiError = (status: number | undefined) =>
    new Anthropic.APIError(status, undefined, "boom", undefined);

  it("wraps 5xx (incl. 529 overloaded) as UpstreamLLMError", () => {
    for (const status of [500, 502, 503, 529]) {
      expect(classifyLLMError(apiError(status))).toBeInstanceOf(UpstreamLLMError);
    }
  });

  it("wraps 408 timeout and 429 rate-limit as UpstreamLLMError", () => {
    expect(classifyLLMError(apiError(408))).toBeInstanceOf(UpstreamLLMError);
    expect(classifyLLMError(apiError(429))).toBeInstanceOf(UpstreamLLMError);
  });

  it("wraps a connection error (no HTTP status) as UpstreamLLMError", () => {
    const conn = new Anthropic.APIConnectionError({ message: "socket hang up" });
    expect(classifyLLMError(conn)).toBeInstanceOf(UpstreamLLMError);
  });

  it("does NOT wrap a 4xx client error (our bug) — propagates unchanged", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = apiError(status);
      expect(classifyLLMError(err)).toBe(err); // same reference, not wrapped
    }
  });

  it("does NOT wrap a non-Anthropic error — propagates unchanged", () => {
    const plain = new Error("unrelated");
    expect(classifyLLMError(plain)).toBe(plain);
  });

  it("preserves the original error as the wrapped error's cause", () => {
    const original = apiError(529);
    const wrapped = classifyLLMError(original);
    expect(wrapped).toBeInstanceOf(UpstreamLLMError);
    expect((wrapped as UpstreamLLMError).cause).toBe(original);
  });
});

/**
 * The explicit canonical ↔ Messages-API mapping:
 * the adapter builds the SDK request from canonical fields and narrows the
 * response back. Captured at the wire by overriding global fetch — the SDK
 * runs for real, no live model.
 */
describe("createAnthropicClient — explicit mapping", () => {
  let originalFetch: typeof globalThis.fetch;
  let capturedBodies: Record<string, unknown>[];

  function cannedMessagesResponse(overrides: Record<string, unknown> = {}) {
    return {
      id: "msg_wire",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello", citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 9 },
      ...overrides,
    };
  }

  function installFetch(responseBody: Record<string, unknown>) {
    globalThis.fetch = (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedBodies = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the SDK request from canonical fields (system, blocks, tools)", async () => {
    installFetch(cannedMessagesResponse());
    const client = createAnthropicClient("sk-test");
    await client.createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: "be brief",
      messages: [
        { role: "user", content: "list mail" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "tu_1", name: "mock_email_list", input: { label: "inbox" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "{}", is_error: true },
          ],
        },
      ],
      tools: [
        {
          name: "mock_email_list",
          description: "List email",
          input_schema: { type: "object", properties: {}, required: [] },
        },
      ],
    });

    expect(capturedBodies).toHaveLength(1);
    const body = capturedBodies[0]!;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(512);
    expect(body.system).toBe("be brief");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "user", content: "list mail" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "tu_1", name: "mock_email_list", input: { label: "inbox" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "{}", is_error: true },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: "mock_email_list",
        description: "List email",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ]);
  });

  it("omits the system and tools keys entirely when the canonical params leave them out", async () => {
    installFetch(cannedMessagesResponse());
    await createAnthropicClient("sk-test").createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
    const body = capturedBodies[0]!;
    expect("system" in body).toBe(false);
    expect("tools" in body).toBe(false);
  });

  it("maps the response back to the canonical shape", async () => {
    installFetch(
      cannedMessagesResponse({
        content: [
          { type: "text", text: "checking", citations: null },
          { type: "tool_use", id: "tu_9", name: "mock_email_list", input: { label: "inbox" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 11, output_tokens: 13 },
      }),
    );
    const result = await createAnthropicClient("sk-test").createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({
      id: "msg_wire",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tu_9", name: "mock_email_list", input: { label: "inbox" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 11, output_tokens: 13 },
    });
  });

  it("narrows an unmodeled stop_reason to null", async () => {
    installFetch(cannedMessagesResponse({ stop_reason: "pause_turn" }));
    const result = await createAnthropicClient("sk-test").createMessage({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.stop_reason).toBeNull();
  });
});
