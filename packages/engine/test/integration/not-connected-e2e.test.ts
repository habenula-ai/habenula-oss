import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { workerFetch, post, stubFor } from "../helpers/http";
import type { ChatResponse } from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

/**
 * End-to-end regression guard for the not-connected branch (Commit 6,
 * dbd2b6d), driven through `POST /api/chat` so the whole chain from the route
 * down is under test. The fix has three moving parts that must all stay
 * aligned:
 *
 *   1. UserAgent.executeTool() returns denyReason: "not_connected" when
 *      the service is not in connected_services.
 *   2. The chat() wrapper in user-agent.ts maps denyReason →
 *      notConnected: true on the conversation loop's executeTool result.
 *   3. The conversation loop emits outcome: "not_connected" on the tool
 *      call record AND sends Claude a not-connected tool_result content,
 *      not the generic "Denied by governance policy" string.
 *
 * conversation.test.ts already covers (3) in isolation by passing
 * notConnected: true directly. This test exercises (1) → (2) → (3) plus the
 * handler↔DO marshaling that carries the outcome onto the wire, so a
 * regression in any of those layers fails the integration.
 */
describe("Chat not-connected end-to-end over the HTTP path", () => {
  it("emits outcome 'not_connected' and sends Claude an accurate tool_result when no service is connected", async () => {
    const userId = "not-connected-e2e-user";

    let llmCallCount = 0;
    const capturedMessages: LLMCreateParams[] = [];

    const mockLLM: LLMClient = {
      async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
        llmCallCount++;
        capturedMessages.push(JSON.parse(JSON.stringify(params)));

        if (llmCallCount === 1) {
          // Claude attempts the email tool — service is not connected.
          return {
            id: "msg_01ABC",
            content: [
              { type: "text", text: "I'll check your inbox." },
              {
                type: "tool_use",
                id: "toolu_01XYZ",
                name: "gmail_list",
                input: { label: "INBOX", maxResults: 5 },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 30 },
          };
        }

        // After receiving the not-connected tool_result, Claude narrates
        // the failure to the user.
        return {
          id: "msg_02DEF",
          content: [
            {
              type: "text",
              text: "I can't access your email — the service isn't connected yet.",
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 25 },
        };
      },
    };

    const stub = stubFor(userId);
    await runInDurableObject(stub, (instance) => {
      // Deliberately do NOT call connectService — the service is unconnected.
      // Policy is irrelevant because the not-connected check runs first.
      instance.setLLMClient(mockLLM);
    });

    const res = await workerFetch(
      post("/api/chat", { userId, message: "What are my latest emails?" }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as ChatResponse;

    // (3a) The tool call record carries the new outcome value, and it survives
    //      the projection onto the wire.
    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "toolu_01XYZ", outcome: "not_connected" },
    ]);

    // (3b) Claude received the accurate not-connected reason as the
    //      tool_result content, NOT the generic policy-denied string.
    //      This is the load-bearing assertion: it would catch a
    //      regression where someone collapses the notConnected branch
    //      back into the denied branch.
    const secondCall = capturedMessages[1]!;
    const toolResultMsg = secondCall.messages[secondCall.messages.length - 1]!;
    expect(toolResultMsg.role).toBe("user");
    const toolResult = (toolResultMsg.content as Array<{
      type: string;
      content: string;
      is_error?: boolean;
    }>)[0]!;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("not connected");
    expect(toolResult.content).not.toBe("Denied by governance policy");

    // (1) The audit log records the deny with "Service not connected"
    //     as the error_message — proving the executeTool branch fired.
    const denyRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        outcome: string;
        error_message: string | null;
        decision: string;
      }>`SELECT outcome, error_message, decision FROM audit_log WHERE decision = 'deny'`;
    });
    expect(denyRows.length).toBeGreaterThan(0);
    expect(denyRows[0]!.error_message).toContain("Service not connected");
  });
});
