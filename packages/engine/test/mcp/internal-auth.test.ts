// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Caller-token auth on the `/internal/mcp` route. The trust predicate is a verified shared-secret
 * caller token, NOT network locality. This suite pins the security-relevant
 * properties:
 *   - a missing token and a wrong token are indistinguishable (both 401, same
 *     body) — no oracle a caller can probe;
 *   - the check runs BEFORE dispatch — a rejected call never reaches the DO
 *     (the injected LLM is never invoked);
 *   - the correct token admits the request;
 *   - an unconfigured secret fails closed (every request 401s).
 *
 * Real DO, real Worker fetch (Hard Invariant #5) — no mocked primitives.
 */
import { env } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeMessage, internalRpc } from "./helpers/internal-rpc";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

const TOKEN = "test-internal-caller-token-0291c";

beforeEach(() => {
  (env as { INTERNAL_MCP_TOKEN?: string }).INTERNAL_MCP_TOKEN = TOKEN;
});

afterEach(() => {
  (env as { INTERNAL_MCP_TOKEN?: string }).INTERNAL_MCP_TOKEN = TOKEN;
});

/** An LLM that records whether it was ever asked to generate. */
function trackingLLM(): { client: LLMClient; calls: () => number } {
  let n = 0;
  return {
    client: {
      async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
        n++;
        return {
          id: "m",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    calls: () => n,
  };
}

describe("/internal/mcp — caller-token auth", () => {
  it("401s when the Authorization header is missing", async () => {
    const { body, status } = await internalRpc(initializeMessage(1));
    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("401s on a wrong token — identical response to the missing case (no oracle)", async () => {
    const missing = await internalRpc(initializeMessage(1));
    const wrong = await internalRpc(initializeMessage(1), {
      token: "not-the-token",
    });
    expect(wrong.status).toBe(401);
    // Byte-identical body and status: a caller cannot distinguish "no token"
    // from "wrong token", so the surface leaks no validity oracle.
    expect(wrong.status).toBe(missing.status);
    expect(wrong.body).toEqual(missing.body);
  });

  it("admits the request on the correct token", async () => {
    const { body, status } = await internalRpc(initializeMessage(1), {
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body?.error).toBeUndefined();
    const result = body?.result as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe("habenula");
  });

  it("rejects before dispatch — a bad-token send never reaches the DO", async () => {
    const userId = "internal-auth-nodispatch-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const llm = trackingLLM();
    await runInDurableObject(stub, (instance) => {
      (
        instance as unknown as { setLLMClient: (c: LLMClient) => void }
      ).setLLMClient(llm.client);
    });

    // A full send with a wrong token: initialize would fail auth too, so send
    // the tools/call directly. The route rejects at the token gate before
    // createMcpHandler, so the agent turn never runs.
    const { status } = await internalRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send", arguments: { message: "kill everything" } },
      },
      { token: "wrong", userId },
    );
    expect(status).toBe(401);
    expect(llm.calls()).toBe(0);
  });

  it("fails closed when INTERNAL_MCP_TOKEN is unset — every request 401s", async () => {
    delete (env as { INTERNAL_MCP_TOKEN?: string }).INTERNAL_MCP_TOKEN;
    const missing = await internalRpc(initializeMessage(1));
    const withToken = await internalRpc(initializeMessage(1), { token: TOKEN });
    expect(missing.status).toBe(401);
    // Even presenting the (previously valid) token is refused: with no secret
    // configured, no trusted caller can exist.
    expect(withToken.status).toBe(401);
  });
});
