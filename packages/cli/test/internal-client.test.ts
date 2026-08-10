import { describe, it, expect } from "vitest";
import { ChatResponse, ResolveResponse, StatusResponse } from "@habenula-ai/contracts";
import { ApiError, EngineUnavailableError, type FetchFn } from "../src/api-client";
import { InternalClient, unauthorizedGuidance } from "../src/internal-client";
import type { InternalTokenSource } from "../src/config";
import { sseToolResult } from "./helpers/internal-wire";

/**
 * Pin a canned fixture to its wire schema before serving it, so these
 * hand-written bodies cannot drift from the contract the engine ships
 * mirroring api-client.test.ts.
 */
function wire<T>(schema: { parse(value: unknown): T }, body: T): T {
  return schema.parse(body);
}

interface RecordedCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

function makeFetch(
  responder: (call: RecordedCall) => { status?: number; text: string },
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    };
    calls.push(call);
    const { status = 200, text } = responder(call);
    return new Response(text, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  return { fetchFn, calls };
}

const config = {
  apiUrl: "http://api.test",
  userId: "test-user",
  internalMcpUrl: "http://api.test/internal/mcp",
  internalToken: "secret-token",
  humanTouch: false,
};

describe("InternalClient", () => {
  describe("send (chat)", () => {
    it("POSTs a tools/call send with the bearer token and parses the chat turn", async () => {
      const turn = wire(ChatResponse, {
        response: "hi there",
        toolCalls: [{ name: "email_list", id: "tu_1", outcome: "success" }],
        iterations: 2,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const { fetchFn, calls } = makeFetch(() => ({ text: sseToolResult(turn) }));
      const client = new InternalClient(config, fetchFn);

      const result = await client.chat("hello");

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        "http://api.test/internal/mcp?userId=test-user",
      );
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.headers?.Authorization).toBe("Bearer secret-token");
      expect(calls[0]!.headers?.Accept).toContain("text/event-stream");
      const sent = JSON.parse(calls[0]!.body!);
      expect(sent.method).toBe("tools/call");
      expect(sent.params).toEqual({
        name: "send",
        arguments: { message: "hello" },
      });
      expect(result.response).toBe("hi there");
      expect(result.iterations).toBe(2);
    });

    it("maps a busy turn to a 409 TURN_IN_PROGRESS ApiError", async () => {
      const { fetchFn } = makeFetch(() => ({
        text: sseToolResult({ busy: true }),
      }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.chat("hi")).rejects.toMatchObject({
        status: 409,
        errorCode: "TURN_IN_PROGRESS",
      });
    });

    it("omits the Authorization header when no token is configured", async () => {
      const { fetchFn, calls } = makeFetch(() => ({
        text: sseToolResult(
          wire(ChatResponse, {
            response: "ok",
            toolCalls: [],
            iterations: 1,
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ),
      }));
      const client = new InternalClient(
        { ...config, internalToken: undefined },
        fetchFn,
      );
      await client.chat("hi");
      expect(calls[0]!.headers?.Authorization).toBeUndefined();
    });
  });

  describe("resolve", () => {
    it("parses the resumed variant", async () => {
      const resumed = wire(ResolveResponse, {
        status: "resumed",
        result: {
          response: "done",
          toolCalls: [],
          iterations: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      });
      const { fetchFn, calls } = makeFetch(() => ({
        text: sseToolResult(resumed),
      }));
      const client = new InternalClient(config, fetchFn);

      const result = await client.resolve("held-1", "session");
      const sent = JSON.parse(calls[0]!.body!);
      expect(sent.params).toEqual({
        name: "resolve",
        arguments: { heldCallId: "held-1", choice: "session" },
      });
      expect(result.status).toBe("resumed");
    });

    it("maps not_found to a 404 ApiError", async () => {
      const { fetchFn } = makeFetch(() => ({
        text: sseToolResult({ status: "not_found" }),
      }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.resolve("gone", "deny")).rejects.toMatchObject({
        status: 404,
      });
    });

    it("maps busy to a 409 TURN_IN_PROGRESS ApiError", async () => {
      const { fetchFn } = makeFetch(() => ({
        text: sseToolResult({ status: "busy" }),
      }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.resolve("held-1", "task")).rejects.toMatchObject({
        status: 409,
        errorCode: "TURN_IN_PROGRESS",
      });
    });
  });

  describe("getStatus", () => {
    it("parses the aggregate snapshot from a status tool call", async () => {
      const snapshot = wire(StatusResponse, {
        session: null,
        grants: [],
        held: [],
        auditTail: null,
      });
      const { fetchFn, calls } = makeFetch(() => ({
        text: sseToolResult(snapshot),
      }));
      const client = new InternalClient(config, fetchFn);

      const result = await client.getStatus();
      const sent = JSON.parse(calls[0]!.body!);
      expect(sent.params).toEqual({ name: "status", arguments: {} });
      expect(result.session).toBeNull();
    });

    it("also accepts a plain-JSON (non-SSE) response body", async () => {
      const snapshot = wire(StatusResponse, {
        session: null,
        grants: [],
        held: [],
        auditTail: null,
      });
      const envelope = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(snapshot) }] },
      });
      const { fetchFn } = makeFetch(() => ({ text: envelope }));
      const client = new InternalClient(config, fetchFn);
      const result = await client.getStatus();
      expect(result.grants).toEqual([]);
    });
  });

  describe("errors", () => {
    it("maps a 401 to an actionable ApiError", async () => {
      const { fetchFn } = makeFetch(() => ({
        status: 401,
        text: JSON.stringify({ error: "unauthorized" }),
      }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.getStatus()).rejects.toMatchObject({
        status: 401,
        errorCode: "UNAUTHORIZED",
      });
    });

    it("the 401 message follows the config's internalTokenSource", async () => {
      const { fetchFn } = makeFetch(() => ({
        status: 401,
        text: JSON.stringify({ error: "unauthorized" }),
      }));
      const client = new InternalClient(
        { ...config, internalTokenSource: "withheld-unrecorded" as const },
        fetchFn,
      );
      await expect(client.getStatus()).rejects.toMatchObject({
        status: 401,
        message: unauthorizedGuidance("withheld-unrecorded"),
      });
    });

    it("surfaces a tool-level isError result as an ApiError", async () => {
      const { fetchFn } = makeFetch(() => ({
        text: sseToolResult({ error: "internal engine error" }, true),
      }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.chat("hi")).rejects.toBeInstanceOf(ApiError);
    });

    it("maps a JSON-RPC error envelope to an ApiError", async () => {
      const envelope = `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      })}\n\n`;
      const { fetchFn } = makeFetch(() => ({ text: envelope }));
      const client = new InternalClient(config, fetchFn);
      await expect(client.chat("hi")).rejects.toBeInstanceOf(ApiError);
    });

    it("classifies a rejected fetch as EngineUnavailableError(reject)", async () => {
      const fetchFn: FetchFn = async () => {
        throw new TypeError("fetch failed");
      };
      const client = new InternalClient(config, fetchFn);
      await expect(client.getStatus()).rejects.toMatchObject({
        kind: "reject",
      });
      await expect(client.getStatus()).rejects.toBeInstanceOf(
        EngineUnavailableError,
      );
    });
  });
});

/**
 * The five 401 guidance variants, one per token source: the fix a user needs
 * depends on which resolution happened, and each message must name the source
 * that disagreed (or the reason the file's token was withheld) rather than
 * always naming the export.
 */
describe("unauthorizedGuidance", () => {
  it("env: names the environment variable as the source that disagreed", () => {
    const line = unauthorizedGuidance("env");
    expect(line).toContain("HABENULA_INTERNAL_MCP_TOKEN");
    expect(line).toContain("environment");
  });

  it("file: names the config file's token as the source that disagreed", () => {
    const line = unauthorizedGuidance("file");
    expect(line).toContain("config file");
    expect(line).toContain("INTERNAL_MCP_TOKEN");
  });

  it("withheld-remote: says the file's token was withheld from a non-local target and names the export", () => {
    const line = unauthorizedGuidance("withheld-remote");
    expect(line).toContain("withheld");
    expect(line).toContain("not the local engine");
    expect(line).toContain("HABENULA_INTERNAL_MCP_TOKEN");
  });

  it("withheld-unrecorded: says no port is recorded and names a fix that exists", () => {
    const line = unauthorizedGuidance("withheld-unrecorded");
    expect(line).toContain("withheld");
    expect(line).toContain("no engine port");
    expect(line).toContain("HABENULA_PORT");
  });

  it("withheld-unproven: says the recorded port is not held by that engine", () => {
    const line = unauthorizedGuidance("withheld-unproven");
    expect(line).toContain("withheld");
    expect(line).toContain("holding the recorded port");
    expect(line).toContain("HABENULA_INTERNAL_MCP_TOKEN");
  });

  it("names no command the CLI does not have", () => {
    // A 401 message is the one place a user is already stuck; sending them to a
    // command that answers `unknown command` is a dead end, and in shipped OSS
    // copy it is a claim about a capability that is not there.
    for (const source of [
      "env",
      "file",
      "withheld-remote",
      "withheld-unrecorded",
      "withheld-unproven",
      "absent",
      undefined,
    ] as const) {
      // A backticked invocation, not the word: "your habenula config file" is
      // prose about the file, and is fine.
      expect(unauthorizedGuidance(source)).not.toMatch(/`habenula [a-z]/);
    }
  });

  it("absent (and an unset source) keep today's wording", () => {
    const absent = unauthorizedGuidance("absent");
    expect(absent).toContain(
      "set HABENULA_INTERNAL_MCP_TOKEN to match the engine's INTERNAL_MCP_TOKEN",
    );
    expect(unauthorizedGuidance(undefined)).toBe(absent);
  });

  it("covers every source in the union", () => {
    const sources: InternalTokenSource[] = [
      "env",
      "file",
      "withheld-remote",
      "withheld-unrecorded",
      "absent",
    ];
    const lines = sources.map((s) => unauthorizedGuidance(s));
    // Each variant is a distinct message.
    expect(new Set(lines).size).toBe(sources.length);
  });
});
