// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import Anthropic from "@anthropic-ai/sdk";
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
  UPSTREAM_UNAVAILABLE_MESSAGE,
  isRetryableLLMStatus,
} from "./errors";

/**
 * Classify an error thrown by the Anthropic SDK. A retryable upstream failure —
 * a connection error (no HTTP status), a timeout/rate-limit (`408`/`429`), or a
 * `5xx` (incl. `529 overloaded`) surviving the SDK's own retries — is wrapped as
 * an `UpstreamLLMError` so the API boundary can return a friendly, retryable
 * `503`. Anything else (e.g. a `4xx` from a malformed request — our bug)
 * propagates unchanged, to surface as a structured `500`.
 */
export function classifyLLMError(err: unknown): unknown {
  if (err instanceof Anthropic.APIError && isRetryableLLMStatus(err.status)) {
    return new UpstreamLLMError(UPSTREAM_UNAVAILABLE_MESSAGE, { cause: err });
  }
  return err;
}

/**
 * Map one canonical content block to the SDK's request block. The shapes
 * coincide today (the canonical form descends from this API), but the mapping
 * is explicit so a canonical-shape change surfaces here as a type error
 * instead of leaking Habenula's shape onto the wire.
 */
function toAnthropicBlock(block: LLMContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
      };
  }
}

function toAnthropicMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string" ? m.content : m.content.map(toAnthropicBlock),
  }));
}

function toAnthropicTools(tools: LLMToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Narrow the SDK's stop reason to the canonical enum. Values the canonical
 * shape doesn't model (future SDK additions) map to `null` — the loop only
 * branches on `tool_use`, so an unmodeled reason reads as a terminal turn.
 */
function toCanonicalStopReason(
  reason: string | null,
): LLMResponse["stop_reason"] {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
      return reason;
    default:
      return null;
  }
}

export function createAnthropicClient(apiKey: string): LLMClient {
  const client = new Anthropic({ apiKey });

  return {
    async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
      // `.catch` that always rethrows: classify the SDK failure without a typed
      // `let` (the callback returns `never`, so `response` keeps the SDK type).
      const response = await client.messages
        .create({
          model: params.model,
          max_tokens: params.max_tokens,
          ...(params.system !== undefined ? { system: params.system } : {}),
          messages: toAnthropicMessages(params.messages),
          ...(params.tools ? { tools: toAnthropicTools(params.tools) } : {}),
          stream: false,
        })
        .catch((err: unknown) => {
          throw classifyLLMError(err);
        });

      const content: LLMContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      return {
        id: response.id,
        content,
        stop_reason: toCanonicalStopReason(response.stop_reason),
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      };
    },
  };
}
