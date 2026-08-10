/**
 * The LLM/upstream error boundary at the HTTP boundary. A chat turn whose
 * LLM call fails re-throws out of the conversation loop and the DO; without a
 * boundary the Cloudflare runtime returns a bare text `500 Internal Server
 * Error`, indistinguishable from a real bug. `handleChat` / `handleResolve` now
 * map it, and the split is who failed. A retryable `UpstreamLLMError` (what
 * `anthropic-client` wraps an Anthropic overload/timeout/5xx into) becomes a
 * structured `503` `UPSTREAM_UNAVAILABLE`. An `UpstreamResponseError` — the
 * upstream answered and its answer was unusable — becomes a structured `502`
 * `UPSTREAM_INVALID_RESPONSE`. Only a throw that is neither becomes a `500`
 * `INTERNAL`, because that status is the engine's own bug signal and a
 * deployment behind a chatty local model must not page on it.
 * Full-path (SELF.fetch → handler → DO) per the wiring-blind-spot rule.
 */
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserAgent } from "../../src/agent/user-agent";
import { UpstreamLLMError, UpstreamResponseError } from "../../src/llm/errors";
import type { LLMClient, LLMCreateParams, LLMResponse } from "../../src/llm/types";

/** An LLM client whose every call throws `err` — stands in for a sustained outage. */
function throwingLLM(err: unknown): LLMClient {
  return {
    async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      throw err;
    },
  };
}

async function installClient(userId: string, err: unknown): Promise<void> {
  const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as UserAgent).setLLMClient(throwingLLM(err));
  });
}

function postChat(userId: string, message: string): Promise<Response> {
  return SELF.fetch("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, message }),
  });
}

describe("LLM error boundary over the HTTP boundary", () => {
  it("maps a retryable upstream LLM failure to a structured 503 UPSTREAM_UNAVAILABLE", async () => {
    const userId = "llm-503-user";
    await installClient(userId, new UpstreamLLMError("The assistant is temporarily unavailable"));

    const res = await postChat(userId, "summarize my inbox");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; error_code: string };
    expect(body.error_code).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.error).toContain("temporarily unavailable");
    expect(body.error).toContain("try again");
  });

  it("maps an unexpected internal error to a structured 500 INTERNAL (not a raw text 500)", async () => {
    const userId = "llm-500-user";
    await installClient(userId, new Error("something unexpected blew up"));

    const res = await postChat(userId, "hello");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; error_code: string };
    expect(body.error_code).toBe("INTERNAL");
    // Structured JSON envelope, never the leaked internal message.
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("blew up");
  });

  it("maps an unusable upstream response to a structured 502 UPSTREAM_INVALID_RESPONSE", async () => {
    const userId = "llm-502-user";
    await installClient(
      userId,
      new UpstreamResponseError('Model returned malformed JSON arguments for tool "mock_email_list"'),
    );

    const res = await postChat(userId, "list my inbox");

    // Not a 500: the model emitted garbage, which is not an engine bug. Not a
    // 503 either: the upstream is reachable and answering.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; error_code: string };
    expect(body.error_code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(body.error).toContain("could not use");
    expect(body.error).toContain("try again");
    // The adapter's diagnostic names the tool; the caller must not see it.
    expect(body.error).not.toContain("mock_email_list");
  });

  it("does not leak the raw upstream message to the caller", async () => {
    const userId = "llm-503-noleak-user";
    await installClient(userId, new UpstreamLLMError("529 overloaded_error: rate stuff"));

    const res = await postChat(userId, "hi");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("overloaded_error");
  });
});
