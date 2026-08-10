import { describe, it, expect } from "vitest";
import { UNRECOGNIZED_TOOL_NAME } from "@habenula-ai/contracts";
import {
  runConversationLoop,
  type ExecuteToolFn,
  type HeldTurnState,
} from "../../src/llm/conversation";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMMessage,
  LLMToolDefinition,
} from "../../src/llm/types";

const TOOLS: LLMToolDefinition[] = [
  {
    name: "gmail_list",
    description: "List emails",
    input_schema: { type: "object", properties: {} },
  },
];

function makeMockClient(responses: LLMResponse[]): LLMClient {
  let callIndex = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const response = responses[callIndex];
      if (!response) throw new Error("No more mock responses");
      callIndex++;
      return response;
    },
  };
}

function textResponse(text: string): LLMResponse {
  return {
    id: "msg_test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUseResponse(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>
): LLMResponse {
  return {
    id: "msg_test",
    content: [{ type: "tool_use", id: toolId, name: toolName, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const noopExecute: ExecuteToolFn = async () => ({
  success: true,
  data: { result: "ok" },
});

describe("runConversationLoop", () => {
  it("substitutes a text block when the model returns zero content blocks (buffer stays wire-valid)", async () => {
    // An empty/filtered upstream reply must not persist an empty assistant
    // content array — both provider wires reject it on every later request,
    // wedging the conversation.
    const client = makeMockClient([
      {
        id: "msg_empty",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    ]);
    const messages: LLMMessage[] = [];
    const result = await runConversationLoop({
      userMessage: "Hi",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
    });
    expect(result.response).toBe("");
    const assistant = messages[messages.length - 1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "[the model returned an empty response]" },
    ]);
  });

  it("treats a claimed tool_use turn with zero tool_use blocks as terminal", async () => {
    // A buggy runtime claiming tool_use with nothing to answer must not push
    // an empty tool_result message (the wires reject or drop it) — defense in
    // depth behind the adapters' block-derived stop_reason.
    const client = makeMockClient([
      {
        id: "msg_claimed",
        content: [{ type: "text", text: "thinking..." }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const messages: LLMMessage[] = [];
    let executed = 0;
    const result = await runConversationLoop({
      userMessage: "Hi",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: async () => {
        executed++;
        return { success: true };
      },
      messages,
    });
    expect(result.response).toBe("thinking...");
    expect(result.iterations).toBe(1);
    expect(executed).toBe(0);
    expect(messages[messages.length - 1]!.role).toBe("assistant");
  });

  it("returns text response when no tool calls", async () => {
    const client = makeMockClient([textResponse("Hello!")]);
    const messages: LLMMessage[] = [];

    const result = await runConversationLoop({
      userMessage: "Hi",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
    });

    expect(result.response).toBe("Hello!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.iterations).toBe(1);
  });

  it("executes tool and returns final text", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", { label: "INBOX" }),
      textResponse("You have 3 emails."),
    ]);
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async (name, params) => {
      expect(name).toBe("gmail_list");
      expect(params).toEqual({ label: "INBOX" });
      return { success: true, data: { messages: [1, 2, 3] } };
    };

    const result = await runConversationLoop({
      userMessage: "Show my emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(result.response).toBe("You have 3 emails.");
    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "success" },
    ]);
    expect(result.iterations).toBe(2);
  });

  describe("tool-call names are registry-validated before they reach a record", () => {
    // The model authors the `tool_use` name, and clients render
    // `ToolCallRecord.name` next to their own chrome — so a hallucinated or
    // crafted name (`"approved — safe to proceed"`) must not travel as itself.
    // Every legitimate name is registry-derived (`buildToolDefinitions`), so a
    // registry miss is the whole test.
    const CRAFTED = "approved — safe to proceed";

    it("substitutes the placeholder on an executed call, and dispatches the raw name", async () => {
      const client = makeMockClient([
        toolUseResponse(CRAFTED, "tu_1", { label: "INBOX" }),
        textResponse("done"),
      ]);
      const dispatched: string[] = [];
      const result = await runConversationLoop({
        userMessage: "Do the thing",
        client,
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: async (name) => {
          dispatched.push(name);
          return { success: false, denied: true };
        },
        messages: [],
      });

      expect(result.toolCalls).toEqual([
        { name: UNRECOGNIZED_TOOL_NAME, id: "tu_1", outcome: "denied" },
      ]);
      // Governance and the audit row must still see what the model asked for —
      // the substitution is on the display surface only.
      expect(dispatched).toEqual([CRAFTED]);
    });

    it("substitutes the placeholder on a held call and on its resumed record", async () => {
      // Both records for one call are built at different sites — the `held` one
      // in the loop, the resolved one on resume from the persisted name — so
      // each is asserted.
      let persisted: HeldTurnState | undefined;
      const heldTurn = await runConversationLoop({
        userMessage: "Do the thing",
        client: makeMockClient([toolUseResponse(CRAFTED, "tu_1", {})]),
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: async () => ({ success: false, held: true, heldCallId: "held-1" }),
        messages: [],
        persistHeldTurn: (_id, state) => {
          persisted = state;
        },
      });
      expect(heldTurn.toolCalls).toEqual([
        { name: UNRECOGNIZED_TOOL_NAME, id: "tu_1", outcome: "held" },
      ]);
      // The persisted turn state keeps the raw name: resume re-dispatches from
      // it, and `lookupTool` there must see the model's actual request.
      expect(persisted!.heldCall.name).toBe(CRAFTED);

      const resumed = await runConversationLoop({
        userMessage: "",
        client: makeMockClient([textResponse("done")]),
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: noopExecute,
        messages: [],
        resumeState: {
          state: persisted!,
          resolvedResult: {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "denied",
            is_error: true,
          },
          resolvedOutcome: "denied",
        },
      });
      expect(resumed.toolCalls).toEqual([
        { name: UNRECOGNIZED_TOOL_NAME, id: "tu_1", outcome: "denied" },
      ]);
    });

    it("re-resolves the names on records carried over from a persisted turn", async () => {
      // The records a resume carries forward were written by whatever engine
      // parked the hold, and `parseTurnState` casts that blob rather than
      // validating it. So a hold parked by an engine WITHOUT this guard can
      // carry a raw name: the model asked for two tools in one turn, the first
      // force-denied as not-connected (record pushed, raw), the second held.
      // Resume must resolve those names too, or the upgrade ships the crafted
      // one on the wire beside a validated placeholder.
      const legacyState: HeldTurnState = {
        messages: [{ role: "user", content: "Do the thing" }],
        heldCall: { type: "tool_use", id: "tu_2", name: "mock_email_list", input: {} },
        parkedCalls: [],
        producedResults: [],
        iterationsUsed: 1,
        toolCalls: [{ name: CRAFTED, id: "tu_1", outcome: "not_connected" }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const resumed = await runConversationLoop({
        userMessage: "",
        client: makeMockClient([textResponse("done")]),
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: noopExecute,
        messages: [],
        resumeState: {
          state: legacyState,
          resolvedResult: {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: "ok",
            is_error: false,
          },
          resolvedOutcome: "success",
        },
      });

      expect(resumed.toolCalls).toEqual([
        { name: UNRECOGNIZED_TOOL_NAME, id: "tu_1", outcome: "not_connected" },
        { name: "mock_email_list", id: "tu_2", outcome: "success" },
      ]);
    });

    it("passes a registry name through unchanged", async () => {
      // The guard must not relabel real calls: `mock_email_list` is a registry
      // tool, so it travels as itself.
      const result = await runConversationLoop({
        userMessage: "Show my emails",
        client: makeMockClient([
          toolUseResponse("mock_email_list", "tu_1", { label: "INBOX" }),
          textResponse("done"),
        ]),
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: noopExecute,
        messages: [],
      });
      expect(result.toolCalls).toEqual([
        { name: "mock_email_list", id: "tu_1", outcome: "success" },
      ]);
    });
  });

  it("sends governance deny as error result to LLM", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("I don't have permission to do that."),
    ]);
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async () => ({
      success: false,
      denied: true,
    });

    const result = await runConversationLoop({
      userMessage: "Show emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(result.response).toBe("I don't have permission to do that.");
    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "denied" },
    ]);
    // Verify the tool result was marked as error
    const toolResultMsg = messages[2]!; // user, assistant (tool_use), user (tool_result)
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const toolResult = (toolResultMsg.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    expect(toolResult.content).toBe("Denied by governance policy");
    expect(toolResult.is_error).toBe(true);
  });

  it("emits outcome 'not_connected' and a service-not-connected tool_result when notConnected is set", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("The email service is not connected yet."),
    ]);
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async () => ({
      success: false,
      denied: true,
      notConnected: true,
    });

    const result = await runConversationLoop({
      userMessage: "Show emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "not_connected" },
    ]);

    // The tool_result content sent to Claude must be the not-connected
    // message, not the generic "Denied by governance policy" string —
    // otherwise Claude would faithfully tell the user the wrong reason.
    const toolResultMsg = messages[2]!;
    const toolResult = (toolResultMsg.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    expect(toolResult.content).toContain("not connected");
    expect(toolResult.content).not.toBe("Denied by governance policy");
    // Engine prose stays unfenced.
    expect(toolResult.content).not.toContain("habenula-untrusted-output");
    expect(toolResult.is_error).toBe(true);
  });

  it("emits outcome 'needs_authorization' and a re-connect tool_result when needsAuthorization is set", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("Gmail needs to be re-authorized."),
    ]);
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async () => ({
      success: false,
      denied: true,
      needsAuthorization: true,
    });

    const result = await runConversationLoop({
      userMessage: "Show emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "needs_authorization" },
    ]);

    // The tool_result must name re-authorization as the remediation
    // not the generic policy-deny string and not
    // the not-connected message — so Claude narrates the right fix.
    const toolResultMsg = messages[2]!;
    const toolResult = (toolResultMsg.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    expect(toolResult.content).toContain("re-connect");
    expect(toolResult.content).not.toBe("Denied by governance policy");
    expect(toolResult.content).not.toContain("is not connected");
    // Engine prose stays unfenced.
    expect(toolResult.content).not.toContain("habenula-untrusted-output");
    expect(toolResult.is_error).toBe(true);
  });

  it("sends tool execution error as error result to LLM", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("Sorry, there was an error."),
    ]);
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async () => ({
      success: false,
      error: "No credential found for service: gmail",
    });

    const result = await runConversationLoop({
      userMessage: "Show emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(result.response).toBe("Sorry, there was an error.");
    // The record carries the tool's own text UNFENCED — the fence below
    // is the LLM channel's, and the client channel must not inherit it.
    expect(result.toolCalls).toEqual([
      {
        name: "gmail_list",
        id: "tu_1",
        outcome: "error",
        error: "No credential found for service: gmail",
      },
    ]);
    const toolResultMsg = messages[2]!;
    const toolResult = (toolResultMsg.content as Array<{ type: string; content: string; is_error?: boolean }>)[0]!;
    // Provider-authored error text is fenced:
    // exec + group equality so a double-fenced or mangled payload fails, not
    // just a missing marker (0028B review F3).
    const m =
      /^<<habenula-untrusted-output ([0-9a-f-]{36})>>\n([\s\S]*)\n<<end-habenula-untrusted-output \1>>$/.exec(
        toolResult.content,
      );
    expect(m).not.toBeNull();
    expect(m![2]).toBe("No credential found for service: gmail");
    expect(toolResult.is_error).toBe(true);
    // The client record is the SAME text without the envelope — proving
    // the two channels carry one reason in two trust framings.
    expect(result.toolCalls[0]!.error).toBe(m![2]);
  });

  it("a failing tool with no error text records the fallback reason", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("That didn't work."),
    ]);
    const executeTool: ExecuteToolFn = async () => ({ success: false });

    const result = await runConversationLoop({
      userMessage: "Show emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages: [],
    });

    // `error` is never absent on an `error` outcome: the client renders the
    // reason from this field, so a blank one would silently regress to the
    // old "failed, no idea why" line.
    expect(result.toolCalls).toEqual([
      {
        name: "gmail_list",
        id: "tu_1",
        outcome: "error",
        error: "Tool execution failed",
      },
    ]);
  });

  it("refusal outcomes carry no error text — their reason is the outcome itself", async () => {
    // The three refusal branches answer with engine prose the client already
    // renders from `outcome`. Copying it into `error` would push engine chrome
    // through the CLI's untrusted-value path for no gain.
    for (const refusal of [
      { flags: { denied: true }, outcome: "denied" },
      { flags: { denied: true, notConnected: true }, outcome: "not_connected" },
      {
        flags: { denied: true, needsAuthorization: true },
        outcome: "needs_authorization",
      },
    ]) {
      const client = makeMockClient([
        toolUseResponse("gmail_list", "tu_1", {}),
        textResponse("Understood."),
      ]);
      const executeTool: ExecuteToolFn = async () => ({
        success: false,
        ...refusal.flags,
      });

      const result = await runConversationLoop({
        userMessage: "Show emails",
        client,
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool,
        messages: [],
      });

      expect(result.toolCalls[0]!.outcome).toBe(refusal.outcome);
      expect(result.toolCalls[0]!.error).toBeUndefined();
    }
  });

  it("the model receives success tool_results inside a nonce-fenced untrusted envelope", async () => {
    // Observe the tool_result as it ARRIVES at the model: capture the
    // params.messages of the second createMessage call.
    const captured: LLMCreateParams[] = [];
    const inner = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("done"),
    ]);
    const client: LLMClient = {
      async createMessage(params) {
        captured.push(JSON.parse(JSON.stringify(params)) as LLMCreateParams);
        return inner.createMessage(params);
      },
    };
    const messages: LLMMessage[] = [];

    const executeTool: ExecuteToolFn = async () => ({
      success: true,
      data: { messages: [1, 2, 3] },
    });

    await runConversationLoop({
      userMessage: "Show my emails",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool,
      messages,
    });

    expect(captured).toHaveLength(2);
    const resultMsg = captured[1]!.messages[captured[1]!.messages.length - 1]!;
    const toolResult = (resultMsg.content as Array<{ type: string; content: string }>)[0]!;
    expect(toolResult.type).toBe("tool_result");
    // The provider data survives verbatim inside the envelope, and the open
    // and close markers carry the SAME nonce.
    const m =
      /^<<habenula-untrusted-output ([0-9a-f-]{36})>>\n([\s\S]*)\n<<end-habenula-untrusted-output \1>>$/.exec(
        toolResult.content,
      );
    expect(m).not.toBeNull();
    expect(m![2]).toBe(JSON.stringify({ messages: [1, 2, 3] }));
  });

  it("stops at max iterations", async () => {
    // Always return tool_use — should hit the 10 iteration limit
    const responses: LLMResponse[] = Array.from({ length: 10 }, (_, i) =>
      toolUseResponse("gmail_list", `tu_${i}`, {})
    );
    const client = makeMockClient(responses);
    const messages: LLMMessage[] = [];

    const result = await runConversationLoop({
      userMessage: "Loop forever",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
    });

    expect(result.response).toBe("[max iterations reached]");
    expect(result.iterations).toBe(10);
    expect(result.toolCalls).toHaveLength(10);
  });

  it("accumulates usage across iterations", async () => {
    const client = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", {}),
      textResponse("Done"),
    ]);
    const messages: LLMMessage[] = [];

    const result = await runConversationLoop({
      userMessage: "Go",
      client,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
    });

    expect(result.usage.inputTokens).toBe(20); // 10 + 10
    expect(result.usage.outputTokens).toBe(10); // 5 + 5
  });

  it("resume replaces the held record with its final outcome — one record per tool_use", async () => {
    // Turn 1: the model calls the tool, governance holds it. The persisted
    // turn state carries the `held` record.
    let persisted: HeldTurnState | undefined;
    const holdClient = makeMockClient([
      toolUseResponse("gmail_list", "tu_1", { label: "INBOX" }),
    ]);
    const messages: LLMMessage[] = [];

    const heldTurn = await runConversationLoop({
      userMessage: "Show my emails",
      client: holdClient,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: async () => ({ success: false, held: true, heldCallId: "held-1" }),
      messages,
      persistHeldTurn: (_id, state) => {
        persisted = state;
      },
    });
    expect(heldTurn.held?.heldCallId).toBe("held-1");
    expect(heldTurn.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "held" },
    ]);
    expect(persisted).toBeDefined();

    // Resume after the user grants: the resolved outcome must REPLACE the
    // stale `held` record, not sit beside it — a leftover `held` on a
    // completed turn renders a duplicate tool line and a false
    // awaiting-confirmation hint in the CLI.
    const resumeClient = makeMockClient([textResponse("You have mail.")]);
    const resumedTurn = await runConversationLoop({
      userMessage: "",
      client: resumeClient,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
      resumeState: {
        state: persisted!,
        resolvedResult: {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: '{"messages":[1]}',
          is_error: false,
        },
        resolvedOutcome: "success",
      },
    });

    expect(resumedTurn.response).toBe("You have mail.");
    expect(resumedTurn.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_1", outcome: "success" },
    ]);
  });

  it("cascade resume: each resolved call replaces its own held record; the re-held parked call appends", async () => {
    // Turn 1: one assistant turn emits TWO calls; the first holds, the second
    // is parked behind it.
    const persistedStates: HeldTurnState[] = [];
    const holdClient = makeMockClient([
      {
        id: "msg_test",
        content: [
          { type: "tool_use", id: "tu_a", name: "gmail_list", input: { label: "INBOX" } },
          { type: "tool_use", id: "tu_b", name: "gmail_list", input: { label: "SENT" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const messages: LLMMessage[] = [];

    const heldTurn = await runConversationLoop({
      userMessage: "List inbox and sent",
      client: holdClient,
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: async () => ({ success: false, held: true, heldCallId: "held-a" }),
      messages,
      persistHeldTurn: (_id, state) => {
        persistedStates.push(state);
      },
    });
    expect(heldTurn.held?.heldCallId).toBe("held-a");

    // Resume 1: tu_a resolves success; the parked tu_b re-evaluates and holds
    // again. tu_a's record is replaced in place; tu_b's `held` is the only one.
    const cascadeTurn = await runConversationLoop({
      userMessage: "",
      client: makeMockClient([]),
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: async () => ({ success: false, held: true, heldCallId: "held-b" }),
      messages,
      persistHeldTurn: (_id, state) => {
        persistedStates.push(state);
      },
      resumeState: {
        state: persistedStates[0]!,
        resolvedResult: {
          type: "tool_result",
          tool_use_id: "tu_a",
          content: "{}",
          is_error: false,
        },
        resolvedOutcome: "success",
      },
    });
    expect(cascadeTurn.held?.heldCallId).toBe("held-b");
    expect(cascadeTurn.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_a", outcome: "success" },
      { name: "gmail_list", id: "tu_b", outcome: "held" },
    ]);

    // Resume 2: tu_b resolves too — its `held` record is replaced as well, so
    // the completed turn carries exactly one record per tool_use, no `held`.
    const finalTurn = await runConversationLoop({
      userMessage: "",
      client: makeMockClient([textResponse("all done")]),
      model: "test-model",
      maxTokens: 1024,
      tools: TOOLS,
      executeTool: noopExecute,
      messages,
      resumeState: {
        state: persistedStates[1]!,
        resolvedResult: {
          type: "tool_result",
          tool_use_id: "tu_b",
          content: "{}",
          is_error: false,
        },
        resolvedOutcome: "success",
      },
    });
    expect(finalTurn.response).toBe("all done");
    expect(finalTurn.toolCalls).toEqual([
      { name: "gmail_list", id: "tu_a", outcome: "success" },
      { name: "gmail_list", id: "tu_b", outcome: "success" },
    ]);
  });

  it("rolls back messages on LLM API failure", async () => {
    const client: LLMClient = {
      async createMessage(): Promise<LLMResponse> {
        throw new Error("API rate limited");
      },
    };
    const messages: LLMMessage[] = [];

    await expect(
      runConversationLoop({
        userMessage: "Hello",
        client,
        model: "test-model",
        maxTokens: 1024,
        tools: TOOLS,
        executeTool: noopExecute,
        messages,
      })
    ).rejects.toThrow("API rate limited");

    // Messages should be rolled back — no dangling user message
    expect(messages).toHaveLength(0);
  });
});
