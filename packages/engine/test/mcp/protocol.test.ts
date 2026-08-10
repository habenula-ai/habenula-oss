/**
 * Protocol-level coverage of the inbound MCP surface (the spike gate,
 * kept as the surface's regression suite and as
 * the regression net for the future `agents` SDK bump).
 *
 * Drives `/mcp` through the real Worker fetch as raw JSON-RPC over Streamable
 * HTTP — no SDK client, so the assertions are on the wire protocol itself:
 * initialize handshake, tools/list, tools/call. The tool surface assertion is
 * the closed-interface enforcement check: only the
 * commission verbs are ever registered.
 */
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_URI,
  ENGINE_VERSION,
} from "../../src/mcp/commission-server";
import { bindDoSql } from "../helpers/do-sql";
import type { UserAgent } from "../../src/agent/user-agent";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

/** An LLM that emits a single ungranted list tool-use — parks awaiting_confirmation. */
function listLLM(): LLMClient {
  const tool: LLMToolUseBlock = {
    type: "tool_use",
    id: "tu-mcp",
    name: "mock_email_list",
    input: { label: "INBOX" },
  };
  return {
    async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      return {
        id: "m1",
        content: [tool],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * POST one JSON-RPC message to /mcp and parse the response body, which the
 * Streamable HTTP transport may frame as plain JSON or as an SSE stream
 * (`data:` lines). A session id captured from a prior response is echoed
 * back, so the test is correct in both stateless and session-ful modes.
 */
async function rpc(
  message: Record<string, unknown>,
  sessionId?: string,
  userId?: string,
): Promise<{ body: JsonRpcResponse | null; sessionId?: string; status: number }> {
  const url = userId
    ? `http://localhost/mcp?userId=${encodeURIComponent(userId)}`
    : "http://localhost/mcp";
  const res = await SELF.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  let body: JsonRpcResponse | null = null;
  if (text.trim().length > 0) {
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1]! : text;
    body = JSON.parse(payload) as JsonRpcResponse;
  }
  return { body, sessionId: nextSession, status: res.status };
}

function initializeMessage(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      // The pinned MCP spec revision. The server may negotiate; the
      // assertion below checks what comes back, not what we send.
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "0.0.0" },
    },
  };
}

describe("published data-slot vocabulary", () => {
  it("every slot key matches the placeholder charset", async () => {
    const { listTools } = await import("@habenula-ai/tools");
    const keys = listTools().flatMap((t) => (t.dataSlots ?? []).map((d) => d.key));
    for (const key of keys) {
      // {{data.<key>}} substitution only recognizes this shape — a key
      // outside it would be accepted at the boundary but never substitute.
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe("inbound MCP surface — Streamable HTTP protocol", () => {
  it("answers the initialize handshake as the habenula server", async () => {
    const { body, status } = await rpc(initializeMessage(1));
    expect(status).toBe(200);
    expect(body?.error).toBeUndefined();
    const result = body?.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
    };
    expect(result.serverInfo.name).toBe("habenula");
    expect(result.serverInfo.version).toBe(ENGINE_VERSION);
    expect(typeof result.protocolVersion).toBe("string");
  });

  it("lists exactly the commission verb surface — the closed-interface check", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      init.sessionId,
    );
    expect(body?.error).toBeUndefined();
    const tools = (body?.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    // The closed surface: the commission verbs, never a downstream tool
    // — a later change adds the input-only,
    // own-task-scoped `habenula_provide` and, later, `habenula_cancel` /
    // `habenula_amend` — all input-only and own-task-scoped, still no
    // approve/kill/policy/tool reach.
    expect(tools.sort()).toEqual([
      "habenula_amend",
      "habenula_cancel",
      "habenula_commission",
      "habenula_provide",
      "habenula_result",
      "habenula_status",
    ]);
  });

  it("executes tools/call habenula_status and returns liveness metadata", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "habenula_status", arguments: {} },
      },
      init.sessionId,
    );
    expect(body?.error).toBeUndefined();
    const content = (
      body?.result as { content: { type: string; text: string }[] }
    ).content;
    expect(JSON.parse(content[0]!.text)).toEqual({
      running: true,
      version: ENGINE_VERSION,
    });
  });

  it("serves the capability manifest as a resource — services, verbs, slots", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: CAPABILITIES_URI },
      },
      init.sessionId,
    );
    expect(body?.error).toBeUndefined();
    const contents = (
      body?.result as { contents: { text: string }[] }
    ).contents;
    const manifest = JSON.parse(contents[0]!.text) as {
      services: {
        service: string;
        connected: boolean;
        verbs: { verb: string; dataSlots: { key: string }[] }[];
      }[];
    };
    const mock = manifest.services.find((s) => s.service === "mock_email")!;
    expect(mock.connected).toBe(false);
    expect(mock.verbs[0]!.verb).toBe("list");
    expect(mock.verbs[0]!.dataSlots.map((d) => d.key)).toEqual(["mailbox"]);
    // No tool names, no schemas: the property is NON-INVOCABILITY, not
    // secrecy — `service_verb` reconstruction is trivial and harmless, since
    // nothing reconstructed is callable on this surface. The assertion pins
    // that the manifest never becomes a callable-looking catalog.
    expect(contents[0]!.text).not.toContain("mock_email_list");
    expect(contents[0]!.text).not.toContain("inputSchema");
  });

  it("rejects an oversized goal and oversized data at the boundary", async () => {
    const init = await rpc(initializeMessage(1));
    const bigGoal = await rpc(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "habenula_commission",
          arguments: { goal: "g".repeat(4001) },
        },
      },
      init.sessionId,
    );
    const goalResult = bigGoal.body?.result as
      | { isError?: boolean }
      | undefined;
    // zod max() rejection surfaces as a tool error or JSON-RPC error
    expect(goalResult?.isError === true || bigGoal.body?.error !== undefined).toBe(
      true,
    );

    const bigData = await rpc(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "habenula_commission",
          arguments: { goal: "g", data: { mailbox: "x".repeat(16001) } },
        },
      },
      init.sessionId,
    );
    const dataResult = bigData.body?.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(dataResult.isError).toBe(true);
    expect(dataResult.content[0]!.text).toContain("exceed");
  });

  it("rejects an unknown data key at the boundary, naming the vocabulary", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "habenula_commission",
          arguments: { goal: "list stuff", data: { recipient: "a@b.c" } },
        },
      },
      init.sessionId,
    );
    const result = body?.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as {
      unknownKeys: string[];
      publishedKeys: string[];
    };
    expect(payload.unknownKeys).toEqual(["recipient"]);
    expect(payload.publishedKeys).toContain("mailbox");
  });

  it("habenula_provide rejects an unknown data key at the boundary, naming the vocabulary", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "habenula_provide",
          arguments: { taskId: "any", data: { recipient: "a@b.c" } },
        },
      },
      init.sessionId,
    );
    const result = body?.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as {
      unknownKeys: string[];
      publishedKeys: string[];
    };
    expect(payload.unknownKeys).toEqual(["recipient"]);
  });

  it("runs a zero-action commission to completed and reads it back by handle", async () => {
    const userId = "protocol-commission-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    const textOnly: LLMClient = {
      async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
        return {
          id: "m1",
          content: [{ type: "text", text: "nothing needed doing" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as UserAgent).setLLMClient(textOnly);
    });

    const init = await rpc(initializeMessage(1), undefined, userId);
    const call = await rpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "habenula_commission",
          arguments: { goal: "check whether anything needs doing" },
        },
      },
      init.sessionId,
      userId,
    );
    const commissioned = JSON.parse(
      (call.body?.result as { content: { text: string }[] }).content[0]!.text,
    ) as { runId: string; status: string };
    expect(commissioned.status).toBe("completed");

    const read = await rpc(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "habenula_result",
          arguments: { runId: commissioned.runId },
        },
      },
      init.sessionId,
      userId,
    );
    const view = JSON.parse(
      (read.body?.result as { content: { text: string }[] }).content[0]!.text,
    ) as { runId: string; status: string };
    // A later change widens the result to the finer, metadata-only shape: the
    // per-action breakdown and awaited slot keys, both null for a zero-action run.
    expect(view).toEqual({
      runId: commissioned.runId,
      status: "completed",
      statusDetail: null,
      awaitedSlotKeys: null,
    });

    const missing = await rpc(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "habenula_result", arguments: { runId: "absent" } },
      },
      init.sessionId,
      userId,
    );
    expect(
      JSON.parse(
        (missing.body?.result as { content: { text: string }[] }).content[0]!
          .text,
      ),
    ).toEqual({ status: "not_found" });
  });

  it("rejects a call to an unregistered tool name", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "gmail_list", arguments: {} },
      },
      init.sessionId,
    );
    // Whether surfaced as a JSON-RPC error or an isError tool result, the
    // downstream tool must not be callable through this surface.
    const asError = body?.error !== undefined;
    const asToolError =
      (body?.result as { isError?: boolean } | undefined)?.isError === true;
    expect(asError || asToolError).toBe(true);
  });

  it("habenula_cancel cancels an own commissioned task", async () => {
    const userId = "protocol-cancel-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    let taskId = "";
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      agent.setLLMClient(listLLM());
      const out = await agent.commissionGoal({
        goal: "list inbox",
        userId,
        agentId: "onboarding",
      });
      expect(out.status).toBe("awaiting_confirmation");
      taskId = (out as { runId: string }).runId;
    });

    const init = await rpc(initializeMessage(1), undefined, userId);
    const call = await rpc(
      {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "habenula_cancel", arguments: { taskId } },
      },
      init.sessionId,
      userId,
    );
    const result = JSON.parse(
      (call.body?.result as { content: { text: string }[] }).content[0]!.text,
    ) as { status: string };
    expect(result.status).toBe("cancelled");
  });

  it("habenula_cancel refuses a cross-origin (human) task, indistinguishably from unknown", async () => {
    const userId = "protocol-cancel-xorigin";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      const now = "2026-07-06T10:00:00.000Z";
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('human-x', 'human', 'a human task', NULL, 'awaiting_confirmation', 's-x', ${now}, ${now})
      `;
    });

    const init = await rpc(initializeMessage(1), undefined, userId);
    const callFor = async (taskId: string, id: number) => {
      const call = await rpc(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "habenula_cancel", arguments: { taskId } },
        },
        init.sessionId,
        userId,
      );
      return call.body?.result as { isError?: boolean; content: { text: string }[] };
    };

    // A cross-origin task and a task that does not exist must be INDISTINGUISHABLE:
    // two different shapes would let an external client enumerate which task ids
    // exist in the user's DO and which are outside its scope.
    const crossOrigin = await callFor("human-x", 21);
    const unknown = await callFor("no-such-task-id", 22);
    expect(crossOrigin.content[0]!.text).toBe(unknown.content[0]!.text);
    expect(JSON.parse(crossOrigin.content[0]!.text)).toEqual({ status: "not_found" });
    expect(crossOrigin.isError).toBe(unknown.isError);

    // And the refusal did not mutate the task it was not allowed to touch.
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      const status = [
        ...sql<{ status: string }>`SELECT status FROM commission_runs WHERE id = 'human-x'`,
      ][0]!.status;
      expect(status).toBe("awaiting_confirmation");
    });
  });

  it("habenula_amend refuses a cross-origin (human) task, indistinguishably from unknown", async () => {
    const userId = "protocol-amend-xorigin";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      const now = "2026-07-06T10:00:00.000Z";
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('human-a', 'human', 'a human task', NULL, 'needs_input', 's-a', ${now}, ${now})
      `;
    });

    const init = await rpc(initializeMessage(1), undefined, userId);
    const amendFor = async (taskId: string, id: number) => {
      const call = await rpc(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "habenula_amend", arguments: { taskId, data: { to: "x@y.z" } } },
        },
        init.sessionId,
        userId,
      );
      return call.body?.result as { isError?: boolean; content: { text: string }[] };
    };

    const crossOrigin = await amendFor("human-a", 30);
    const unknown = await amendFor("no-such-task-id", 31);
    expect(crossOrigin.content[0]!.text).toBe(unknown.content[0]!.text);
    expect(JSON.parse(crossOrigin.content[0]!.text)).toEqual({ status: "not_found" });

    // The human-origin task's data was not touched.
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      const data = [
        ...sql<{ data: string | null }>`SELECT data FROM commission_runs WHERE id = 'human-a'`,
      ][0]!.data;
      expect(data).toBeNull();
    });
  });

  it("habenula_amend rejects an unknown data key at the boundary, naming the vocabulary", async () => {
    const init = await rpc(initializeMessage(1));
    const { body } = await rpc(
      {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "habenula_amend",
          arguments: { taskId: "any", data: { recipient: "a@b.c" } },
        },
      },
      init.sessionId,
    );
    const result = body?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as { unknownKeys: string[] };
    expect(payload.unknownKeys).toEqual(["recipient"]);
  });

  it("habenula_amend re-supplies data on an own parked task (persists, no resume)", async () => {
    const userId = "protocol-amend-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    let taskId = "";
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // An underspecified send parks needs_input awaiting the `to` slot.
      agent.setLLMClient({
        async createMessage(): Promise<LLMResponse> {
          return {
            id: "m1",
            content: [
              {
                type: "tool_use",
                id: "tu-amend",
                name: "mock_email_send",
                input: { to: ["{{data.to}}"], subject: "Hi", body: "Hello" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      });
      const out = await agent.commissionGoal({
        goal: "email the report to {{data.to}}",
        userId,
        agentId: "onboarding",
      });
      expect(out.status).toBe("needs_input");
      taskId = (out as { runId: string }).runId;
    });

    const init = await rpc(initializeMessage(1), undefined, userId);
    const call = await rpc(
      {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "habenula_amend",
          arguments: { taskId, data: { to: "fixed@acme.test" } },
        },
      },
      init.sessionId,
      userId,
    );
    const result = JSON.parse(
      (call.body?.result as { content: { text: string }[] }).content[0]!.text,
    ) as { taskId: string; status: string };
    // Amend persists the data and leaves the task parked (provide is the resume verb).
    expect(result).toEqual({ taskId, status: "needs_input" });
  });
});
