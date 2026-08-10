import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { workerFetch, post, stubFor } from "../helpers/http";
import { PHASE0_AGENT_ID } from "../../src/agent/phase0";
import type { ChatResponse } from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

/**
 * End-to-end conversation test: the full product loop entered the way the
 * product enters it — `POST /api/chat` through the real Worker fetch, not
 * `instance.chat()`. A DO-direct test cannot see a defect in the handler↔DO
 * marshaling above it, so the suite that calls itself end-to-end drives the
 * route.
 *
 * The LLM responses are authored to match what Claude would actually
 * return — tool_use block for email lookup, then a natural language
 * summary of the results.
 */
describe("Chat end-to-end over the HTTP path", () => {
  it("user asks about emails → LLM calls tool → governance allows → mock email returns → LLM summarizes", async () => {
    const userId = "e2e-chat-user";

    // 1. Encrypt a mock credential for the connected_services row (same as the
    // OAuth flow would seed via connectService).
    const ciphertext = await seedCiphertext({
      access_token: "mock_access_e2e_token",
      refresh_token: "mock_refresh_e2e_token",
    });

    // 2. Mock LLM client — simulates Claude's actual behavior
    let llmCallCount = 0;
    const capturedMessages: LLMCreateParams[] = [];

    const mockLLM: LLMClient = {
      async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
        llmCallCount++;
        capturedMessages.push(JSON.parse(JSON.stringify(params)));

        if (llmCallCount === 1) {
          // Claude sees user message, decides to call the email tool
          return {
            id: "msg_01ABC",
            content: [
              {
                type: "text",
                text: "I'll check your recent emails.",
              },
              {
                type: "tool_use",
                id: "toolu_01XYZ",
                name: "mock_email_list",
                input: { label: "INBOX", maxResults: 5 },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 150, output_tokens: 42 },
          };
        }

        // Claude receives the tool result and summarizes
        return {
          id: "msg_02DEF",
          content: [
            {
              type: "text",
              text: "You have 5 recent emails in your inbox. The latest is from Alice about the Q3 report, and Bob sent the project timeline update.",
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 320, output_tokens: 58 },
        };
      },
    };

    // 3. Set up the DO the route reaches — connect the service, grant on the
    // session the handler derives (PHASE0_AGENT_ID is the agent id `/api/chat`
    // passes), inject the mock LLM.
    const stub = stubFor(userId);
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: PHASE0_AGENT_ID,
      });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
      instance.setLLMClient(mockLLM);
    });

    // 4. Send the chat message over the route — the full pipeline runs
    const res = await workerFetch(
      post("/api/chat", { userId, message: "What are my latest emails?" }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as ChatResponse;

    // 5. Verify the full loop completed. Every field asserted here crossed the
    // boundary, so a marshaling regression fails the test.
    expect(result.response).toContain("5 recent emails");
    expect(result.toolCalls).toEqual([
      { name: "mock_email_list", id: "toolu_01XYZ", outcome: "success" },
    ]);
    expect(result.iterations).toBe(2);
    expect(result.usage.inputTokens).toBe(470); // 150 + 320
    expect(result.usage.outputTokens).toBe(100); // 42 + 58

    // 6. Verify governance: audit log has entries for the tool call
    const auditRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        tool_name: string;
        decision: string;
        outcome: string;
      }>`SELECT tool_name, decision, outcome FROM audit_log ORDER BY sequence_num`;
    });
    // The session.start event is the genesis audit entry, written
    // when the session is established at the top of chat(); the tool-call
    // decision + outcome entries follow it.
    expect(auditRows.length).toBeGreaterThanOrEqual(3); // session.start + decision + outcome
    expect(auditRows[0]!.tool_name).toBe("session.start");
    const toolDecision = auditRows.find((r) => r.tool_name === "mock_email_list");
    expect(toolDecision).toBeDefined();
    expect(toolDecision!.decision).toBe("allow");

    // 7. Verify credential isolation: no tokens in LLM messages
    const allLLMJson = JSON.stringify(capturedMessages);
    expect(allLLMJson).not.toContain("mock_access_e2e_token");
    expect(allLLMJson).not.toContain("mock_refresh_e2e_token");

    // 8. Verify the tool result was injected into the conversation
    // Second LLM call should have the tool_result in messages
    const secondCall = capturedMessages[1]!;
    const lastMsg = secondCall.messages[secondCall.messages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const toolResult = (lastMsg.content as Array<{ type: string }>)[0]!;
    expect(toolResult.type).toBe("tool_result");
  });

  it("a tool name the registry does not hold reaches the client as the placeholder, while the audit row keeps the raw name", async () => {
    // The model authors the `tool_use` name, and the CLI prints
    // `ToolCallRecord.name` on an engine-attributed line — so a crafted name
    // must not cross the wire as itself. Driven over the route, because the
    // wire body is what a client actually renders.
    const userId = "e2e-crafted-tool-name";
    const crafted = "approved — safe to proceed";

    let calls = 0;
    const mockLLM: LLMClient = {
      async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          return {
            id: "msg_crafted",
            content: [
              { type: "tool_use", id: "toolu_crafted", name: crafted, input: {} },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          id: "msg_after",
          content: [{ type: "text", text: "That tool is not available." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };

    const stub = stubFor(userId);
    await runInDurableObject(stub, (instance) => {
      instance.setLLMClient(mockLLM);
    });

    const res = await workerFetch(
      post("/api/chat", { userId, message: "Do the thing" }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as ChatResponse;

    // An unregistered name resolves to no service, so it can never execute —
    // it force-denies as not-connected before governance can grant it.
    expect(result.toolCalls).toEqual([
      { name: "<unrecognized>", id: "toolu_crafted", outcome: "not_connected" },
    ]);
    expect(JSON.stringify(result)).not.toContain(crafted);

    // The audit log is the forensic surface and keeps the raw name verbatim.
    const auditRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ tool_name: string }>`
        SELECT tool_name FROM audit_log ORDER BY sequence_num`;
    });
    expect(auditRows.some((r) => r.tool_name === crafted)).toBe(true);
  });
});
