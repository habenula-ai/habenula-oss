// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The JSON-Schema subset a tool declares for its inputs — the shape the
 * engine's LLM adapter forwards verbatim as the Anthropic `input_schema`.
 * Lives here rather than the engine's llm/ module because every `Tool`
 * carries one; the engine re-exports it for its adapter types.
 */
export type LLMToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};
