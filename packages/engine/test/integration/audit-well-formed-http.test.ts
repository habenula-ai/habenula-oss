import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { workerFetch, post, stubFor } from "../helpers/http";
import { verifyChainRange } from "@habenula-ai/audit";
import { UNRECOGNIZED_TOOL_NAME } from "@habenula-ai/contracts";
import type { ChatResponse } from "@habenula-ai/contracts";
import type { LLMClient, LLMCreateParams, LLMResponse } from "../../src/llm/types";

/**
 * The audit chain survives a model-emitted tool name that has no UTF-8
 * encoding, driven through `POST /api/chat` — the surface this actually
 * reaches in the default configuration.
 *
 * The DO-level guard in test/data/audit-log.test.ts covers the row writer. It
 * is not sufficient on its own, and the history is the argument: the direct
 * `POST /api/tools/execute` route that first exposed this is now debug-gated
 * and answers 404, so a suite that only drove that route would report the
 * defect closed while the live path stayed open. The model authors the
 * `tool_use` name, nothing upstream constrains its code units, and on a
 * commission run the goal text steering the model is authored elsewhere.
 *
 * The failure this guards is silent by construction: the wire shows a
 * sanitized name, the response is a clean 200, and the only evidence is a row
 * nobody reads until `habenula log verify` reports the whole chain BROKEN —
 * a verdict indistinguishable from tampering, and unrepairable, because the
 * bytes that were hashed were never stored.
 */
describe("Audit chain over the HTTP path: a model-emitted unpaired surrogate", () => {
  const HIGH = "\ud800";
  const HOSTILE_TOOL_NAME = `a${HIGH}b`;

  /** Answers one tool call by the given name, then narrates and stops. */
  function llmEmitting(toolName: string): LLMClient {
    let calls = 0;
    return {
      async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
        calls++;
        if (calls === 1) {
          return {
            id: "msg_01",
            content: [{ type: "tool_use", id: "toolu_01", name: toolName, input: {} }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          id: "msg_02",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 5 },
        };
      },
    };
  }

  it("records the call and leaves the chain verifying", async () => {
    const userId = "well-formed-chain-user";
    const stub = stubFor(userId);
    await runInDurableObject(stub, (instance) => {
      instance.setLLMClient(llmEmitting(HOSTILE_TOOL_NAME));
    });

    const res = await workerFetch(post("/api/chat", { userId, message: "do the thing" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatResponse;

    // The name is unregistered, so the call is refused and the wire carries
    // the sanitized token. Nothing in this response hints at what was written.
    expect(body.toolCalls?.[0]?.name).toBe(UNRECOGNIZED_TOOL_NAME);

    const stored = await runInDurableObject(stub, (instance) =>
      instance.sql<{ tool_name: string }>`
        SELECT tool_name FROM audit_log WHERE tool_name LIKE 'a%b'
      `,
    );
    // The forensic record keeps the model's name, conditioned — the raw text
    // is what could not be stored, not the fact that the model chose it.
    // A literal, not `wellFormed(input)`: comparing the writer's output
    // against the writer's own function would pass however wrong it became.
    expect(stored.length).toBe(1);
    expect(stored[0]!.tool_name).toBe("a�b");

    const page = await runInDurableObject(stub, (instance) =>
      instance.listAuditEntries({ limit: 100 }),
    );
    const verdict = verifyChainRange([...page.entries].reverse());
    expect(verdict.entriesChecked).toBeGreaterThan(1);
    expect(verdict.breaks).toEqual([]);
  });

  it("keeps verifying across a later turn, so one bad name does not poison the rest of the log", async () => {
    // The original report's sharpest edge: the break is not confined to the
    // offending entry. Every later entry chains off a hash that can no longer
    // be recomputed, so the log never recovers. A second clean turn is what
    // proves the chain moved on.
    const userId = "well-formed-chain-user-2";
    const stub = stubFor(userId);
    await runInDurableObject(stub, (instance) => {
      instance.setLLMClient(llmEmitting(HOSTILE_TOOL_NAME));
    });
    expect((await workerFetch(post("/api/chat", { userId, message: "first" }))).status).toBe(200);

    await runInDurableObject(stub, (instance) => {
      instance.setLLMClient(llmEmitting("gmail_list"));
    });
    expect((await workerFetch(post("/api/chat", { userId, message: "second" }))).status).toBe(200);

    const page = await runInDurableObject(stub, (instance) =>
      instance.listAuditEntries({ limit: 100 }),
    );
    const verdict = verifyChainRange([...page.entries].reverse());
    expect(verdict.entriesChecked).toBeGreaterThan(2);
    expect(verdict.breaks).toEqual([]);
  });
});
