import { describe, it, expect } from "vitest";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible-client";
import { UpstreamLLMError, UpstreamResponseError } from "../../src/llm/errors";
import type { LLMCreateParams } from "../../src/llm/types";

/**
 * Pure mapping tests for the OpenAI-compatible adapter:
 * canonical → wire request, wire → canonical response, and the retryable-status
 * classification, all against fixed fixtures via an injected fetchFn. No live
 * model.
 */

/**
 * A fetchFn that captures the request and returns a canned response.
 *
 * It constructs a real `Request` from the init first, and that line is
 * load-bearing rather than decorative. An injected fetchFn that only records
 * its arguments accepts init values the runtime rejects, so the adapter can
 * ship a request the real `fetch` refuses to send and every test still passes.
 * That is exactly how `redirect: "error"` shipped: workerd rejects it
 * outright, the throw landed before any request went out, and the whole
 * openai-compatible provider answered every call as an unreachable upstream.
 * Constructing the Request puts the runtime back in the loop.
 */
function fixtureFetch(
  responseBody: unknown,
  init: { status?: number } = {},
): { fetchFn: typeof fetch; captured: { url?: string; init?: RequestInit } } {
  const captured: { url?: string; init?: RequestInit } = {};
  const fetchFn = (async (url: RequestInfo | URL, requestInit?: RequestInit) => {
    captured.url = String(url);
    captured.init = requestInit;
    // Throws on an init the runtime will not accept.
    new Request(String(url), requestInit);
    return new Response(JSON.stringify(responseBody), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, captured };
}

const minimalResponse = {
  id: "cmpl-1",
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 5 },
};

const baseParams: LLMCreateParams = {
  model: "test-model",
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
};

function sentBody(captured: { init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
}

describe("createOpenAICompatibleClient — request mapping", () => {
  it("POSTs to ${endpoint}/chat/completions (trailing slash tolerated)", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    const client = createOpenAICompatibleClient({
      endpoint: "http://localhost:8080/v1/",
      fetchFn,
    });
    await client.createMessage(baseParams);
    expect(captured.url).toBe("http://localhost:8080/v1/chat/completions");
    expect(captured.init?.method).toBe("POST");
  });

  it("sends a Bearer header only when apiKey is set", async () => {
    const withKey = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({
      endpoint: "http://x",
      apiKey: "sk-test",
      fetchFn: withKey.fetchFn,
    }).createMessage(baseParams);
    expect(
      new Headers(withKey.captured.init?.headers).get("authorization"),
    ).toBe("Bearer sk-test");

    const withoutKey = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({
      endpoint: "http://x",
      fetchFn: withoutKey.fetchFn,
    }).createMessage(baseParams);
    expect(
      new Headers(withoutKey.captured.init?.headers).get("authorization"),
    ).toBeNull();
  });

  it("maps system to a leading system message and model/max_tokens verbatim", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage({
      ...baseParams,
      system: "be brief",
    });
    const body = sentBody(captured);
    expect(body.model).toBe("test-model");
    expect(body.max_tokens).toBe(256);
    expect((body.messages as unknown[])[0]).toEqual({
      role: "system",
      content: "be brief",
    });
  });

  it("maps assistant tool_use blocks to tool_calls with stringified arguments", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage({
      ...baseParams,
      messages: [
        { role: "user", content: "list mail" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "call_1", name: "mock_email_list", input: { label: "inbox" } },
          ],
        },
      ],
    });
    const messages = sentBody(captured).messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "on it",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "mock_email_list", arguments: '{"label":"inbox"}' },
        },
      ],
    });
  });

  it("sends null assistant content when the turn is tool_calls-only", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage({
      ...baseParams,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "t", input: {} }],
        },
      ],
    });
    const messages = sentBody(captured).messages as Record<string, unknown>[];
    expect(messages[0]!.content).toBeNull();
  });

  it("asks for unfollowed redirects and carries a timeout signal on the wire request", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    // "manual", never "error": the runtime rejects "error" at construction, so
    // that value never reaches the wire at all. fixtureFetch constructs a real
    // Request, so this expectation is checked twice — once here by name, and
    // once by the runtime accepting it.
    expect(captured.init?.redirect).toBe("manual");
    expect(captured.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a redirecting endpoint rather than following it", async () => {
    // The Authorization header must never be replayed cross-origin, so a 3xx
    // is a refusal. A plain Error, not UpstreamLLMError: an endpoint that
    // redirects is misconfigured, and retrying it would replay the same 3xx.
    const { fetchFn } = fixtureFetch({}, { status: 302 });
    await expect(
      createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams),
    ).rejects.toThrow(/redirected \(302\); refusing to follow it/);
    await expect(
      createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams),
    ).rejects.not.toBeInstanceOf(UpstreamLLMError);
  });

  it("a mixed user turn emits role:tool messages first, then the text as a user message", async () => {
    // Deliberate reorder: the wire requires role:tool directly after the
    // assistant tool_calls turn, so tool results always precede the text.
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "also, be quick" },
            { type: "tool_result", tool_use_id: "call_1", content: "{}" },
          ],
        },
      ],
    });
    expect(sentBody(captured).messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "{}" },
      { role: "user", content: "also, be quick" },
    ]);
  });

  it("maps tool_result blocks to separate role:tool messages, folding is_error into content", async () => {
    const { fetchFn, captured } = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage({
      ...baseParams,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: '{"rows":[]}' },
            { type: "tool_result", tool_use_id: "call_2", content: "Denied by user", is_error: true },
          ],
        },
      ],
    });
    const messages = sentBody(captured).messages as Record<string, unknown>[];
    expect(messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: '{"rows":[]}' },
      { role: "tool", tool_call_id: "call_2", content: "[tool error] Denied by user" },
    ]);
  });

  it("maps canonical tools to function entries and omits the key when absent", async () => {
    const withTools = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn: withTools.fetchFn }).createMessage({
      ...baseParams,
      tools: [
        {
          name: "mock_email_list",
          description: "List email",
          input_schema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    expect(sentBody(withTools.captured).tools).toEqual([
      {
        type: "function",
        function: {
          name: "mock_email_list",
          description: "List email",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);

    const withoutTools = fixtureFetch(minimalResponse);
    await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn: withoutTools.fetchFn }).createMessage(baseParams);
    expect("tools" in sentBody(withoutTools.captured)).toBe(false);
  });
});

describe("createOpenAICompatibleClient — response mapping", () => {
  it("maps content, tool_calls (parsed arguments), finish_reason and usage", async () => {
    const { fetchFn } = fixtureFetch({
      id: "cmpl-9",
      choices: [
        {
          message: {
            content: "checking",
            tool_calls: [
              {
                id: "call_7",
                type: "function",
                function: { name: "mock_email_list", arguments: '{"label":"inbox"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 13 },
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result).toEqual({
      id: "cmpl-9",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "call_7", name: "mock_email_list", input: { label: "inbox" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 11, output_tokens: 13 },
    });
  });

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["content_filter", null],
    [null, null],
  ] as const)("maps finish_reason %s → stop_reason %s", async (wire, canonical) => {
    const { fetchFn } = fixtureFetch({
      choices: [{ message: { content: "x" }, finish_reason: wire }],
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result.stop_reason).toBe(canonical);
  });

  it("tool_calls decide stop_reason even under finish_reason stop (runtime quirk)", async () => {
    // Several llama.cpp/Ollama/vLLM builds emit tool_calls with finish_reason
    // "stop" — the calls must still execute, so blocks win over finish_reason.
    const { fetchFn } = fixtureFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
            ],
          },
          finish_reason: "stop",
        },
      ],
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("finish_reason tool_calls with no calls attached reads as terminal, not an empty tool turn", async () => {
    const { fetchFn } = fixtureFetch({
      choices: [{ message: { content: "hm" }, finish_reason: "tool_calls" }],
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result.stop_reason).toBeNull();
    expect(result.content).toEqual([{ type: "text", text: "hm" }]);
  });

  it("honors the content-parts array form some runtimes return", async () => {
    const { fetchFn } = fixtureFetch({
      choices: [
        {
          message: { content: [{ type: "text", text: "part one, " }, { type: "text", text: "part two" }] },
          finish_reason: "stop",
        },
      ],
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result.content).toEqual([{ type: "text", text: "part one, part two" }]);
  });

  it("defaults id and usage when a minimal runtime omits them", async () => {
    const { fetchFn } = fixtureFetch({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    });
    const result = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    expect(result.id).toBe("");
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("malformed tool arguments are an unusable response, not an engine bug", async () => {
    const { fetchFn } = fixtureFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "t", arguments: "{not json" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const promise = createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    await expect(promise).rejects.toThrow(/malformed JSON arguments/);
    await expect(promise).rejects.toBeInstanceOf(UpstreamResponseError);
    await expect(promise).rejects.not.toBeInstanceOf(UpstreamLLMError);
  });

  it("a response carrying no choices is an unusable response", async () => {
    const { fetchFn } = fixtureFetch({ choices: [] });
    const promise = createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    await expect(promise).rejects.toThrow(/no choices/);
    await expect(promise).rejects.toBeInstanceOf(UpstreamResponseError);
  });

  it("non-object tool arguments (valid JSON, wrong shape) are an unusable response", async () => {
    const { fetchFn } = fixtureFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c", type: "function", function: { name: "t", arguments: "[1,2]" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const promise = createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams);
    await expect(promise).rejects.toThrow(/non-object arguments/);
    await expect(promise).rejects.toBeInstanceOf(UpstreamResponseError);
    await expect(promise).rejects.not.toBeInstanceOf(UpstreamLLMError);
  });
});

describe("createOpenAICompatibleClient — retryable-status classification", () => {
  it.each([[408], [429], [500], [503], [529]])(
    "wraps HTTP %d as UpstreamLLMError",
    async (status) => {
      const { fetchFn } = fixtureFetch({ error: "overloaded" }, { status });
      await expect(
        createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams),
      ).rejects.toBeInstanceOf(UpstreamLLMError);
    },
  );

  it("wraps a network failure (no response) as UpstreamLLMError with cause", async () => {
    const boom = new Error("socket hang up");
    const fetchFn = (async () => {
      throw boom;
    }) as typeof fetch;
    const err = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn })
      .createMessage(baseParams)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamLLMError);
    expect((err as UpstreamLLMError).cause).toBe(boom);
  });

  it.each([[400], [401], [404], [422]])(
    "does NOT wrap HTTP %d (our bug) — plain Error with status",
    async (status) => {
      const { fetchFn } = fixtureFetch({ error: "bad request" }, { status });
      const err = await createOpenAICompatibleClient({ endpoint: "http://x", fetchFn })
        .createMessage(baseParams)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UpstreamLLMError);
      expect((err as Error).message).toContain(String(status));
    },
  );

  it("wraps a 200 with a non-JSON body (proxy error page) as UpstreamResponseError", async () => {
    const fetchFn = (async () =>
      new Response("<html>bad gateway page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    await expect(
      createOpenAICompatibleClient({ endpoint: "http://x", fetchFn }).createMessage(baseParams),
    ).rejects.toBeInstanceOf(UpstreamResponseError);
  });
});
