import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { asTurn } from "../helpers/turn";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

describe("LLM error paths", () => {
  it("tool execution error → audit records outcome error + LLM gets error result", async () => {
    const userId = "error-path-test";
    let callCount = 0;

    const mockClient: LLMClient = {
      async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          return {
            id: "msg_1",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "gmail_list",
                input: { label: "INBOX" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          id: "msg_2",
          content: [
            { type: "text", text: "I encountered an error accessing your email." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    };

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      // Connect service but DON'T store any credential
      instance.connectService("gmail");
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
      instance.setLLMClient(mockClient);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.chat({
        message: "Show my emails",
        userId,
      }).then(asTurn);
    });

    // LLM received the error and produced a response
    expect(result.response).toContain("error");
    expect(result.toolCalls).toHaveLength(1);

    // Audit log has an outcome entry recording the error
    const outcomeRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        outcome: string;
        error_message: string | null;
      }>`SELECT outcome, error_message FROM audit_log WHERE outcome = 'error' AND decision_entry_id IS NOT NULL`;
    });
    expect(outcomeRows.length).toBeGreaterThan(0);
    expect(outcomeRows[0]!.error_message).toContain("No credential found");
  });

  it("governance deny → LLM gets denied result, no tool execution", async () => {
    const userId = "deny-path-test";
    let callCount = 0;

    const mockClient: LLMClient = {
      async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
        callCount++;
        if (callCount === 1) {
          return {
            id: "msg_1",
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "gmail_list",
                input: {},
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          id: "msg_2",
          content: [
            { type: "text", text: "I don't have permission to access email." },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    };

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail");
      // An explicit scoped deny grant is a real "no" — the evaluator keeps it a
      // hard deny (not askable/pending), so the call is refused outright. (No
      // grant at all would instead park the call as pending/held.)
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant("gmail", "list", "inbox", sessionId, "deny");
      instance.setLLMClient(mockClient);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.chat({
        message: "Show emails",
        userId,
      }).then(asTurn);
    });

    expect(result.response).toContain("permission");

    // Audit log records the deny decision
    const denyRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ decision: string }>`
        SELECT decision FROM audit_log WHERE decision = 'deny'
      `;
    });
    expect(denyRows.length).toBeGreaterThan(0);
  });
});
