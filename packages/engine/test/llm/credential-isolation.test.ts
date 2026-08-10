import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { SERVICES, toolName } from "@habenula-ai/tools";
import { createAnthropicClient } from "../../src/llm/anthropic-client";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible-client";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

/**
 * Iterated over every OAuth service in the catalog, so a new service re-runs
 * the invariant for free: the secret material seeded for that service must
 * never reach the LLM context or the audit log through its dispatch path.
 * Each service gets real-shape-agnostic per-service secrets; the outbound
 * fetch serves canned Gmail-shaped responses for services that call out
 * (mock services never fetch).
 */

/** Mock fetch that answers the Gmail list + detail calls with canned data. */
function gmailApiFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/messages") && !url.match(/\/messages\/\w/)) {
      return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        payload: {
          headers: [
            { name: "Subject", value: "Hello" },
            { name: "From", value: "a@example.com" },
            { name: "Date", value: "2026-04-08T10:00:00Z" },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

const OAUTH_SERVICES = SERVICES.filter((s) => s.connect.type === "oauth");

describe("Hard Invariant #1: LLM context never contains raw OAuth tokens", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = gmailApiFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const service of OAUTH_SERVICES) {
    const tool = service.tools[0]!;
    const name = toolName(tool);
    // The secret material that must never reach the LLM context or the audit
    // log on this service's authenticated path.
    const ACCESS_TOKEN = `secret_access_token_${service.service}_12345`;
    const REFRESH_TOKEN = `secret_refresh_token_${service.service}_12345`;

    it(`[${service.service}] messages sent to LLM do not contain credential tokens`, async () => {
      const userId = `cred-isolation-${service.service}`;

      const ciphertext = await seedCiphertext({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      });

      // Mock LLM client that captures the messages array
      const capturedMessages: LLMCreateParams["messages"][] = [];

      const mockClient: LLMClient = {
        async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
          capturedMessages.push(JSON.parse(JSON.stringify(params.messages)));

          if (capturedMessages.length === 1) {
            // First call: request tool use (defaults fill the params)
            return {
              id: "msg_1",
              content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
              stop_reason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 5 },
            };
          }
          // Second call: final response
          return {
            id: "msg_2",
            content: [{ type: "text", text: "You have emails." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 20, output_tokens: 10 },
          };
        },
      };

      const stub = getStub();
      await runInDurableObject(stub, (instance) => {
        instance.connectService(service.service, ciphertext);
        const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
        instance.createSessionGrant(
          service.service,
          tool.verb,
          tool.nounExtractor({}),
          sessionId,
        );
        instance.setLLMClient(mockClient);
      });

      await runInDurableObject(stub, async (instance) => {
        return instance.chat({
          message: "Show my emails",
          userId,
        });
      });

      // Verify we captured messages from both LLM calls
      expect(capturedMessages.length).toBe(2);

      // Stringify ALL messages sent to the LLM and check for tokens
      const allMessagesJson = JSON.stringify(capturedMessages);
      expect(allMessagesJson).not.toContain(ACCESS_TOKEN);
      expect(allMessagesJson).not.toContain(REFRESH_TOKEN);
    });

    it(`[${service.service}] audit log from chat does not contain credential tokens`, async () => {
      const userId = `cred-audit-${service.service}`;

      const ciphertext = await seedCiphertext({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      });

      const mockClient: LLMClient = {
        async createMessage(): Promise<LLMResponse> {
          return {
            id: "msg_1",
            content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        },
      };

      // This client always returns tool_use, so the loop will hit max
      // iterations. That's fine — we just need one tool execution to audit.
      const stub = getStub();
      await runInDurableObject(stub, (instance) => {
        instance.connectService(service.service, ciphertext);
        const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
        instance.createSessionGrant(
          service.service,
          tool.verb,
          tool.nounExtractor({}),
          sessionId,
        );
        instance.setLLMClient(mockClient);
      });

      await runInDurableObject(stub, async (instance) => {
        return instance.chat({
          message: "emails",
          userId,
        });
      });

      const rows = await runInDurableObject(stub, (instance) => {
        return instance.sql<Record<string, string | null>>`SELECT * FROM audit_log`;
      });

      const allValues = rows.flatMap((row) =>
        Object.values(row).map((v) => String(v ?? "")),
      );
      const joined = allValues.join("|");
      expect(joined).not.toContain(ACCESS_TOKEN);
      expect(joined).not.toContain(REFRESH_TOKEN);
    });
  }
});

/**
 * Hard Invariant #1 per adapter: the invariant is checked
 * at each adapter's actual WIRE — the serialized provider request — not just
 * at the LLMClient seam, so neither adapter can leak what the seam-level
 * checks above wouldn't see. Same governed dispatch path, real DO.
 */
describe("Hard Invariant #1 per adapter", () => {
  const service = OAUTH_SERVICES[0]!;
  const tool = service.tools[0]!;
  const name = toolName(tool);
  const ACCESS_TOKEN = `secret_access_token_wire_${service.service}_12345`;
  const REFRESH_TOKEN = `secret_refresh_token_wire_${service.service}_12345`;

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = gmailApiFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Seed the credentialed service + a covering grant, then inject `client`. */
  async function seedAndInject(
    stub: ReturnType<typeof getStub>,
    userId: string,
    client: LLMClient,
  ) {
    const ciphertext = await seedCiphertext({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
    });
    await runInDurableObject(stub, (instance) => {
      instance.connectService(service.service, ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant(
        service.service,
        tool.verb,
        tool.nounExtractor({}),
        sessionId,
      );
      instance.setLLMClient(client);
    });
  }

  it("openai-compatible adapter: the serialized wire request carries no credential material", async () => {
    const userId = "wire-isolation-openai";
    const wireBodies: string[] = [];
    let call = 0;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      wireBodies.push(String(init?.body));
      call++;
      const body =
        call === 1
          ? {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      { id: "call_1", type: "function", function: { name, arguments: "{}" } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }
          : { choices: [{ message: { content: "done" }, finish_reason: "stop" }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const stub = getStub();
    await seedAndInject(
      stub,
      userId,
      createOpenAICompatibleClient({ endpoint: "http://llm.test/v1", apiKey: "llm-key", fetchFn }),
    );
    await runInDurableObject(stub, (instance) =>
      instance.chat({ message: "Show my emails", userId }),
    );

    expect(wireBodies.length).toBe(2);
    const joined = wireBodies.join("|");
    expect(joined).not.toContain(ACCESS_TOKEN);
    expect(joined).not.toContain(REFRESH_TOKEN);
  });

  it("anthropic adapter: the serialized wire request carries no credential material", async () => {
    const userId = "wire-isolation-anthropic";
    const wireBodies: string[] = [];
    let call = 0;
    const serviceFetch = gmailApiFetch();
    // Route by host: the SDK's Messages API traffic is captured and answered
    // with canned responses; everything else is the service's outbound call.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("anthropic.com")) {
        return serviceFetch(input as never, init);
      }
      wireBodies.push(
        input instanceof Request ? await input.clone().text() : String(init?.body),
      );
      call++;
      const body =
        call === 1
          ? {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "tool_use", id: "tu_1", name, input: {} }],
              stop_reason: "tool_use",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            }
          : {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "done", citations: null }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const stub = getStub();
    await seedAndInject(stub, userId, createAnthropicClient("sk-test"));
    await runInDurableObject(stub, (instance) =>
      instance.chat({ message: "Show my emails", userId }),
    );

    expect(wireBodies.length).toBe(2);
    const joined = wireBodies.join("|");
    expect(joined).not.toContain(ACCESS_TOKEN);
    expect(joined).not.toContain(REFRESH_TOKEN);
  });
});
