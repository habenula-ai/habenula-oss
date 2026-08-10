// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Habenula-owned canonical LLM shape.
 *
 * These types are the engine's own inference envelope, not any provider's:
 * every adapter (`anthropic-client.ts`, `openai-compatible-client.ts`) maps
 * this shape to its provider wire form and back, and nothing outside an
 * adapter speaks a vendor API. The block set (`text` / `tool_use` /
 * `tool_result`) is kept as the richer superset; persisted held-turn state
 * built from it is versioned by `CANONICAL_SHAPE_VERSION` (`canonical.ts`).
 * Injectable for testing (same pattern as fetchFn).
 */

// Declared in @habenula-ai/tools (every Tool carries one); re-exported here
// so the adapter's consumers keep one import site for LLM types.
import type { LLMToolInputSchema } from "@habenula-ai/tools";
export type { LLMToolInputSchema };

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: LLMToolInputSchema;
}

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock;

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

export interface LLMResponse {
  id: string;
  content: LLMContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface LLMCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
}

export interface LLMClient {
  createMessage(params: LLMCreateParams): Promise<LLMResponse>;
}
