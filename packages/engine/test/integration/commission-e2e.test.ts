/**
 * The demo as a test: an
 * external client commissions a goal over the wire, the runtime takes
 * governed actions holding on each un-granted one, the user approves in the
 * CLI (POST /api/resolve — the same route the CLI drives), and the client
 * reads the terminal status by its ONE stable handle across a double hold.
 * The result payload is run-level metadata only — never content.
 */
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import type { UserAgent } from "../../src/agent/user-agent";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

const USER = "commission-e2e-user";

function toolUse(id: string, label: string): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label } };
}

/** Script: hold on INBOX → after grant, hold on SENT (cascade) → final text. */
function scriptedLLM(): LLMClient {
  let call = 0;
  return {
    async createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      call++;
      if (call === 1) {
        return {
          id: "m1",
          content: [toolUse("tu-1", "INBOX")],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      if (call === 2) {
        return {
          id: "m2",
          content: [toolUse("tu-2", "SENT")],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return {
        id: "m3",
        content: [{ type: "text", text: "both mailboxes listed" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await SELF.fetch(
    `http://localhost/mcp?userId=${encodeURIComponent(USER)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    },
  );
  const text = await res.text();
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1]! : text;
  const body = JSON.parse(payload) as {
    result: { content: { text: string }[] };
  };
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
}

async function resolveViaCli(
  heldCallId: string,
  choice: string,
): Promise<Response> {
  return SELF.fetch("http://localhost/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER, heldCallId, choice }),
  });
}

describe("commission end-to-end", () => {
  it("double-hold run keeps one stable handle to a metadata-only terminal", async () => {
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(USER));
    const heldIdAt = async () =>
      runInDurableObject(stub, (instance) =>
        (instance as unknown as UserAgent).heldCallId(),
      );
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email", await seedCiphertext());
      agent.setLLMClient(scriptedLLM());
    });

    // 1. the client commissions a goal over MCP
    const commissioned = await mcpCall("habenula_commission", {
      goal: "list both mailboxes and confirm they were listed",
    });
    expect(commissioned.status).toBe("awaiting_confirmation");
    const runId = commissioned.runId as string;

    // 2. the user approves hold #1 in the CLI (task grant covers INBOX once)
    const firstHeld = await heldIdAt();
    const r1 = await resolveViaCli(firstHeld!, "task");
    expect(r1.status).toBe(200);
    const r1body = (await r1.json()) as {
      status: string;
      result: { held?: { heldCallId: string } };
    };
    // the resume cascaded into hold #2 (SENT is un-granted)
    expect(r1body.status).toBe("resumed");
    expect(r1body.result.held).toBeDefined();

    // 3. same handle still reports awaiting — the stable-handle property
    expect(await mcpCall("habenula_result", { runId })).toMatchObject({
      runId,
      status: "awaiting_confirmation",
    });

    // 4. the user approves hold #2; the run completes
    const secondHeld = await heldIdAt();
    expect(secondHeld).not.toBe(firstHeld);
    const r2 = await resolveViaCli(secondHeld!, "session");
    expect(((await r2.json()) as { status: string }).status).toBe("resumed");

    // 5. the client reads the terminal by the SAME handle; payload is
    //    metadata-only — status plus the per-action breakdown and awaited
    //    slot keys, never tool-output content, credentials, or conversation.
    const finalView = await mcpCall("habenula_result", { runId });
    expect(finalView).toMatchObject({ runId, status: "completed" });
    expect(Object.keys(finalView as object).sort()).toEqual([
      "awaitedSlotKeys",
      "runId",
      "status",
      "statusDetail",
    ]);
  });
});
