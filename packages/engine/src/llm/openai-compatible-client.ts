// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The OpenAI-compatible adapter. Plain `fetch` against
 * `POST ${endpoint}/chat/completions` — no SDK dependency. This is the
 * *ecosystem* adapter: the chat-completions wire form is the de-facto standard
 * for local runtimes (llama.cpp, vLLM, Ollama), most hosted providers, and
 * gateways (OpenRouter, LiteLLM), so one adapter covers the practical field.
 *
 * The real translation work between the canonical shape and this wire:
 * tool results move from canonical `tool_result` blocks inside a user turn to
 * separate `role:"tool"` messages; tool arguments serialize to a JSON string;
 * `finish_reason` maps to `stop_reason`.
 */

import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMContentBlock,
  LLMMessage,
  LLMToolDefinition,
} from "./types";
import {
  UpstreamLLMError,
  UpstreamResponseError,
  UPSTREAM_INVALID_RESPONSE_MESSAGE,
  UPSTREAM_UNAVAILABLE_MESSAGE,
  isRetryableLLMStatus,
} from "./errors";

/**
 * Per-request ceiling, mirroring the Anthropic SDK's default timeout. Without
 * it a hung local runtime stalls the turn forever and the turn gate answers
 * `busy` to every chat until the DO is evicted.
 *
 * The CLI's chat deadline (`CHAT_DEADLINE_MS` in the CLI's api-client) is
 * derived from this number: ceiling plus a delivery margin, so a caller is
 * still listening when the ceiling ends the turn and the timeout arrives as
 * a readable answer instead of a hang. Moving this value means moving that
 * one with it.
 */
const REQUEST_TIMEOUT_MS = 600_000;

export interface OpenAICompatibleConfig {
  /** Base URL, e.g. `https://api.groq.com/openai/v1` or `http://localhost:8080/v1`. */
  endpoint: string;
  /** Bearer credential; omitted entirely for unauthenticated local runtimes. */
  apiKey?: string;
  /** Injectable for testing (same pattern as fetchFn elsewhere in the engine). */
  fetchFn?: typeof fetch;
}

// --- wire shapes (the slice of the chat-completions API this adapter uses) ---

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

interface WireResponse {
  id?: string;
  choices?: {
    message?: {
      content?: string | null | { type?: string; text?: string }[];
      tool_calls?: WireToolCall[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// --- request mapping ---

/**
 * Flatten one canonical message onto the wire message list. A canonical user
 * turn carrying `tool_result` blocks becomes separate `role:"tool"` messages
 * (the wire has no in-message result block); the wire requires them directly
 * after the assistant turn whose `tool_calls` they answer, which the canonical
 * ordering already guarantees. A `tool` message has no error field, so a
 * canonical `is_error` folds into the content as a text prefix.
 */
function textOf(blocks: LLMContentBlock[]): string {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

function pushWireMessages(out: WireMessage[], message: LLMMessage): void {
  if (typeof message.content === "string") {
    out.push({ role: message.role, content: message.content });
    return;
  }

  if (message.role === "assistant") {
    const text = textOf(message.content);
    const toolCalls: WireToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
    }
    out.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
    return;
  }

  // User turn: tool_result blocks first (the wire-required position), then any
  // text as a plain user message.
  for (const block of message.content) {
    if (block.type === "tool_result") {
      // The wire has no error field on a tool message, so the flag folds into
      // the content as a prefix. A legitimate result that itself starts with
      // "[tool error] " is indistinguishable — ambiguity inherent to this
      // wire, accepted (the audit log carries the real outcome).
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `[tool error] ${block.content}` : block.content,
      });
    }
  }
  const text = textOf(message.content);
  if (text.length > 0) {
    out.push({ role: "user", content: text });
  }
}

function toWireTools(tools: LLMToolDefinition[]): {
  type: "function";
  function: { name: string; description: string; parameters: LLMToolDefinition["input_schema"] };
}[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// --- response mapping ---

/**
 * `stop` → `end_turn`, `tool_calls` → `tool_use`, `length` → `max_tokens`;
 * anything else (`content_filter`, deprecated `function_call`, runtime
 * extensions) → `null` — the loop only branches on `tool_use`, so an unmodeled
 * reason reads as a terminal turn.
 */
function toCanonicalStopReason(
  reason: string | null | undefined,
): LLMResponse["stop_reason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return null;
  }
}

/**
 * Parse a tool call's `arguments` JSON string. The spec warns the model may
 * emit invalid JSON, and a small local model does it routinely — so this is
 * an UpstreamResponseError (a `502`), not a plain Error. It is neither an
 * outage nor an engine bug: the upstream answered, and its answer was
 * unusable.
 */
function parseToolArguments(call: WireToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.function.arguments);
  } catch (err) {
    throw new UpstreamResponseError(
      `Model returned malformed JSON arguments for tool "${call.function.name}"`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UpstreamResponseError(
      `Model returned non-object arguments for tool "${call.function.name}"`,
    );
  }
  return parsed as Record<string, unknown>;
}

export function createOpenAICompatibleClient(
  config: OpenAICompatibleConfig,
): LLMClient {
  const fetchFn = config.fetchFn ?? fetch;
  const url = `${config.endpoint.replace(/\/+$/, "")}/chat/completions`;

  return {
    async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
      const messages: WireMessage[] = [];
      if (params.system !== undefined) {
        messages.push({ role: "system", content: params.system });
      }
      for (const message of params.messages) {
        pushWireMessages(messages, message);
      }

      // `max_tokens` is deprecated upstream in favor of `max_completion_tokens`
      // but remains the ecosystem-baseline field every compatible runtime and
      // gateway accepts — this adapter targets that baseline.
      const body = JSON.stringify({
        model: params.model,
        max_tokens: params.max_tokens,
        messages,
        ...(params.tools ? { tools: toWireTools(params.tools) } : {}),
      });

      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body,
          // A chat-completions endpoint has no legitimate redirect; following
          // one could replay the Authorization header cross-origin. "manual"
          // hands the 3xx back unfollowed, which the status check below turns
          // into a refusal.
          //
          // NOT "error", which is the spec's name for this intent but which
          // workerd rejects outright ('"error" won't be implemented since it
          // does not make sense at the edge; use "manual" and check the
          // response status code'). The throw lands before the request is
          // sent, so every call on this provider failed as an unreachable
          // upstream.
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // No response at all (connection failure, timeout abort) — the mirror
        // of the Anthropic adapter's connection-error (status undefined)
        // classification.
        throw new UpstreamLLMError(UPSTREAM_UNAVAILABLE_MESSAGE, { cause: err });
      }

      // The redirect refusal, now that the runtime hands us the 3xx instead of
      // throwing on it. Never retried and never followed: a chat-completions
      // endpoint that redirects is misconfigured, not briefly unavailable.
      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `chat/completions redirected (${response.status}); refusing to follow it — ` +
            "set LLM_ENDPOINT to the endpoint that serves the API directly",
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const cause = new Error(
          `chat/completions returned ${response.status}: ${detail.slice(0, 256)}`,
        );
        // Retryable upstream conditions per the shared contract;
        // other 4xx = our bug → plain Error.
        if (isRetryableLLMStatus(response.status)) {
          throw new UpstreamLLMError(UPSTREAM_UNAVAILABLE_MESSAGE, { cause });
        }
        throw cause;
      }

      let wire: WireResponse;
      try {
        wire = (await response.json()) as WireResponse;
      } catch (err) {
        // A 200 whose body is not JSON (an HTML error page from a proxy or a
        // misbehaving runtime). The upstream answered; the answer is unusable.
        throw new UpstreamResponseError(UPSTREAM_INVALID_RESPONSE_MESSAGE, {
          cause: err,
        });
      }
      const choice = wire.choices?.[0];
      if (!choice?.message) {
        throw new UpstreamResponseError(
          "chat/completions response carried no choices[0].message",
        );
      }

      const content: LLMContentBlock[] = [];
      // Some runtimes/gateways return the content-parts array form instead of
      // a plain string — honor both, or a normal reply would read as empty.
      const messageContent = choice.message.content;
      let responseText = "";
      if (typeof messageContent === "string") {
        responseText = messageContent;
      } else if (Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part?.type === "text" && typeof part.text === "string") {
            responseText += part.text;
          }
        }
      }
      if (responseText.length > 0) {
        content.push({ type: "text", text: responseText });
      }
      const toolCalls = choice.message.tool_calls ?? [];
      for (const call of toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call),
        });
      }

      // The content blocks, not finish_reason, decide tool_use: several
      // runtimes emit tool_calls under finish_reason "stop"/null (the calls
      // would silently never execute), and a "tool_calls" finish with no
      // calls attached must read as terminal, not as an empty tool turn.
      const stopReason =
        toolCalls.length > 0
          ? "tool_use"
          : choice.finish_reason === "tool_calls"
            ? null
            : toCanonicalStopReason(choice.finish_reason);

      return {
        id: wire.id ?? "",
        content,
        stop_reason: stopReason,
        usage: {
          input_tokens: wire.usage?.prompt_tokens ?? 0,
          output_tokens: wire.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
