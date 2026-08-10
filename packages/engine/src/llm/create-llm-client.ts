// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider selection. `readLLMConfig(env)` reads the
 * deployment's `(provider, model, endpoint/credential)` tuple; `createLLMClient`
 * builds the matching adapter. Selection is deployment-static: the config is
 * read when the client is built and never changes under a live session, so a
 * held turn always resumes under the provider that parked it.
 *
 * Defaults preserve the pre-seam behavior exactly: Anthropic,
 * `claude-sonnet-4-6`, `env.ANTHROPIC_API_KEY`.
 */

import { createAnthropicClient } from "./anthropic-client";
import { createOpenAICompatibleClient } from "./openai-compatible-client";
import type { LLMClient } from "./types";

export interface LLMConfig {
  provider: "anthropic" | "openai-compatible";
  model: string;
  /** Per-turn output budget; not env-tunable (the pre-seam constant). */
  maxTokens: number;
  /** Base URL — required for (and only used by) `openai-compatible`. */
  endpoint?: string;
  apiKey?: string;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 1024;

/** The env slice the selector reads (structural — tests pass plain objects). */
export interface LLMEnv {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_ENDPOINT?: string;
  LLM_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

/**
 * Resolve the deployment's LLM config from env. Misconfiguration fails loud at
 * client construction — never silently falls back to another provider.
 */
export function readLLMConfig(env: LLMEnv): LLMConfig {
  const provider = env.LLM_PROVIDER ?? "anthropic";

  if (provider === "anthropic") {
    return {
      provider,
      model: env.LLM_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      // The provider-specific key wins: a stale LLM_API_KEY left behind by an
      // openai-compatible trial must not be silently transmitted to
      // api.anthropic.com when the provider flips back (or defaults back) to
      // anthropic. LLM_API_KEY covers only the deployment that has no
      // ANTHROPIC_API_KEY at all.
      apiKey: env.ANTHROPIC_API_KEY ?? env.LLM_API_KEY,
    };
  }

  if (provider === "openai-compatible") {
    if (!env.LLM_ENDPOINT) {
      throw new Error("LLM_PROVIDER=openai-compatible requires LLM_ENDPOINT");
    }
    if (!env.LLM_MODEL) {
      throw new Error("LLM_PROVIDER=openai-compatible requires LLM_MODEL");
    }
    return {
      provider,
      model: env.LLM_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      endpoint: env.LLM_ENDPOINT,
      // Optional by design: a local runtime (llama.cpp, Ollama) has no key.
      apiKey: env.LLM_API_KEY,
    };
  }

  throw new Error(
    `Unknown LLM_PROVIDER "${provider}" — expected "anthropic" or "openai-compatible"`,
  );
}

/** Build the adapter the config names. Neither provider is privileged. */
export function createLLMClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case "anthropic": {
      if (!config.apiKey) {
        throw new Error("Anthropic provider requires an API key (ANTHROPIC_API_KEY or LLM_API_KEY)");
      }
      return createAnthropicClient(config.apiKey);
    }
    case "openai-compatible": {
      if (!config.endpoint) {
        throw new Error("openai-compatible provider requires an endpoint");
      }
      return createOpenAICompatibleClient({
        endpoint: config.endpoint,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      });
    }
  }
}
