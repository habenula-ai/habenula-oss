import { describe, it, expect } from "vitest";
import {
  createLLMClient,
  readLLMConfig,
} from "../../src/llm/create-llm-client";

/**
 * Provider selection. The load-bearing assertion is the
 * default row: with nothing but ANTHROPIC_API_KEY set, the resolved config is
 * exactly the pre-seam behavior.
 */
describe("readLLMConfig", () => {
  it("defaults preserve the pre-seam behavior exactly", () => {
    expect(readLLMConfig({ ANTHROPIC_API_KEY: "sk-ant" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxTokens: 1024,
      apiKey: "sk-ant",
    });
  });

  it("anthropic honors LLM_MODEL; ANTHROPIC_API_KEY beats a stale LLM_API_KEY", () => {
    // A leftover LLM_API_KEY from an openai-compatible trial must never be
    // transmitted to api.anthropic.com — the provider-specific key wins.
    const config = readLLMConfig({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-x",
      LLM_API_KEY: "sk-third-party-stale",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    expect(config.model).toBe("claude-x");
    expect(config.apiKey).toBe("sk-ant");
  });

  it("anthropic falls back to LLM_API_KEY only when ANTHROPIC_API_KEY is absent", () => {
    expect(readLLMConfig({ LLM_API_KEY: "sk-generic" }).apiKey).toBe("sk-generic");
  });

  it("openai-compatible reads the full tuple; apiKey stays optional (keyless local runtime)", () => {
    expect(
      readLLMConfig({
        LLM_PROVIDER: "openai-compatible",
        LLM_MODEL: "llama-3.3-70b",
        LLM_ENDPOINT: "http://localhost:8080/v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      model: "llama-3.3-70b",
      maxTokens: 1024,
      endpoint: "http://localhost:8080/v1",
      apiKey: undefined,
    });
  });

  it("fails loud on a misconfigured openai-compatible deploy", () => {
    expect(() =>
      readLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" }),
    ).toThrow(/requires LLM_ENDPOINT/);
    expect(() =>
      readLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_ENDPOINT: "http://x" }),
    ).toThrow(/requires LLM_MODEL/);
  });

  it("fails loud on an unknown provider — never silently falls back", () => {
    expect(() => readLLMConfig({ LLM_PROVIDER: "gemini" })).toThrow(
      /Unknown LLM_PROVIDER "gemini"/,
    );
  });
});

describe("createLLMClient", () => {
  it("builds a client for each provider", () => {
    expect(
      createLLMClient({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 1024,
        apiKey: "sk-ant",
      }).createMessage,
    ).toBeTypeOf("function");
    expect(
      createLLMClient({
        provider: "openai-compatible",
        model: "llama-3.3-70b",
        maxTokens: 1024,
        endpoint: "http://localhost:8080/v1",
      }).createMessage,
    ).toBeTypeOf("function");
  });

  it("anthropic without a key fails at construction, not first use", () => {
    expect(() =>
      createLLMClient({ provider: "anthropic", model: "m", maxTokens: 1024 }),
    ).toThrow(/requires an API key/);
  });

  it("openai-compatible without an endpoint fails at construction", () => {
    expect(() =>
      createLLMClient({ provider: "openai-compatible", model: "m", maxTokens: 1024 }),
    ).toThrow(/requires an endpoint/);
  });
});
