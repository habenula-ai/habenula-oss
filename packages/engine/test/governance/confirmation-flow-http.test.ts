import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { bindDoSql } from "../helpers/do-sql";
import { workerFetch, post, stubFor } from "../helpers/http";
import { PHASE0_AGENT_ID } from "../../src/agent/phase0";
import * as spendLedgerData from "../../src/data/helpers/spend-ledger";
import {
  executeMockDeliveryQuote,
  type MockQuoteResult,
} from "@habenula-ai/tools/services/mock/mock-delivery";
import type { EngineSql } from "../../src/data/helpers/types";
import { RESOLVE_CHOICES } from "@habenula-ai/contracts";
import type { ChatResponse, ResolveResponse } from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * The confirmation flow over the full HTTP path — the companion to
 * confirmation-flow.test.ts, which drives the DO's methods directly.
 *
 * The DO-direct suite is the thorough one and stays that way: it covers the
 * primitives in isolation with a `sessionId` it supplies itself. What it cannot
 * see is a defect in the handler↔DO marshaling above it, and a hold is
 * boundary-load-bearing in a specific way — the hold is minted on one request
 * and answered on a later one, so the two requests must resolve to the same
 * session or the grant, the ledger window, and the parked call all land in
 * different places. That is the shape of the defect that reached `main`. These
 * cases enter through `POST /api/chat` and `POST /api/resolve`, and never pass a
 * `sessionId` — the routes have no field for one.
 *
 * `session` continuity has its own file (integration/session-continuity.test.ts);
 * this covers the other three answers plus the spending hold.
 *
 * Real DO, real Worker fetch, injected mock LLM — no platform mocks
 * (Hard Invariant #5).
 */

/** A single tool_use block calling mock_email_list. */
function toolUse(id: string, label = "INBOX"): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label } };
}

/** A mock LLM emitting a scripted response per call, recording what it saw. */
function scriptedLLM(script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>): {
  client: LLMClient;
  captured: LLMCreateParams[];
} {
  const captured: LLMCreateParams[] = [];
  let i = 0;
  const client: LLMClient = {
    async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
      captured.push(JSON.parse(JSON.stringify(params)) as LLMCreateParams);
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools && step.tools.length > 0) {
        return {
          id: `msg_${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${i}`,
        content: [{ type: "text", text: step.text ?? "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
  return { client, captured };
}

async function chat(userId: string, message: string): Promise<ChatResponse> {
  const res = await workerFetch(post("/api/chat", { userId, message }));
  expect(res.status).toBe(200);
  return (await res.json()) as ChatResponse;
}

async function resolve(
  userId: string,
  heldCallId: string,
  choice: (typeof RESOLVE_CHOICES)[number],
): Promise<ResolveResponse> {
  const res = await workerFetch(
    post("/api/resolve", { userId, heldCallId, choice }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ResolveResponse;
}

describe("confirmation flow over the full HTTP path", () => {
  it("'deny' mints nothing and tells the LLM only the minimal string", async () => {
    const userId = "http-resolve-deny-user";
    const { client, captured } = scriptedLLM([
      { tools: [toolUse("toolu_1")] }, // held
      { text: "ok, denied then" }, // resume after the deny
    ]);
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email"); // credential-less: nothing executes
      instance.setLLMClient(client);
    });

    const first = await chat(userId, "list inbox");
    expect(first.held?.heldCallId).toBeTruthy();

    const resolved = await resolve(userId, first.held!.heldCallId, "deny");
    expect(resolved.status).toBe("resumed");

    // No grant was minted by the deny.
    const grants = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ id: string }>`
        SELECT id FROM policy_entries WHERE source IN ('session','task')
      `,
    ]);
    expect(grants).toHaveLength(0);

    // The held call is cleared, not left parked for a second answer.
    const held = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(held).toHaveLength(0);

    // The resume tool_result the LLM saw is the fixed minimal string — no
    // held-call id, no session internals, and outside the untrusted fence.
    const json = JSON.stringify(captured[captured.length - 1]!.messages);
    expect(json).toContain("Denied by user");
    expect(json).not.toContain(first.held!.heldCallId);
    expect(json).not.toContain("habenula-untrusted-output");
  });

  it("'task' is consumed on use, so a later turn on the same session holds again", async () => {
    const userId = "http-resolve-task-user";
    const ciphertext = await seedCiphertext(); // the resume executes the tool
    const { client } = scriptedLLM([
      { tools: [toolUse("toolu_1")] }, // turn 1 → held
      { text: "first done" }, // resume → executes → final text
      { tools: [toolUse("toolu_2")] }, // turn 2 calls the same tool again
    ]);
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(client);
    });

    const first = await chat(userId, "list inbox");
    const resolved = await resolve(userId, first.held!.heldCallId, "task");
    expect(resolved.status).toBe("resumed");
    if (resolved.status === "resumed") {
      expect(resolved.result.toolCalls).toEqual([
        { name: "mock_email_list", id: "toolu_1", outcome: "success" },
      ]);
    }

    // The single-use grant is spent — no live task grant survives the execute.
    const liveTaskGrants = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ id: string }>`
        SELECT id FROM policy_entries WHERE source = 'task' AND consumed_at IS NULL
      `,
    ]);
    expect(liveTaskGrants).toHaveLength(0);

    // A second turn over the route finds no live grant → holds again.
    const second = await chat(userId, "list inbox again");
    expect(second.held?.heldCallId).toBeTruthy();

    // Both turns ran in ONE session, so "holds again" means the grant was
    // consumed — not that turn 2 landed in a fresh session where no grant had
    // ever been minted. Without this the assertion above passes under the very
    // defect it is meant to catch.
    const sessions = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ session_id: string }>`
        SELECT DISTINCT session_id FROM audit_log WHERE tool_name = 'mock_email_list'
      `,
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("'tell_more' leaves the call parked, and the same id still resolves on a later request", async () => {
    const userId = "http-resolve-tell-more-user";
    const ciphertext = await seedCiphertext();
    const { client } = scriptedLLM([
      { tools: [toolUse("toolu_1")] }, // held
      { text: "You have mail." }, // resume after the grant
    ]);
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(client);
    });

    const first = await chat(userId, "list inbox");
    const heldCallId = first.held!.heldCallId;

    const info = await resolve(userId, heldCallId, "tell_more");
    expect(info.status).toBe("info");
    if (info.status === "info") {
      expect(info.metadata.service).toBe("mock_email");
      expect(info.metadata.verb).toBe("list");
      expect(info.metadata.description).toBeTruthy();
    }

    // Still parked after the read-only answer.
    const stillHeld = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`,
    ]);
    expect(stillHeld).toHaveLength(1);

    // A THIRD request answers the same hold. The id minted on request 1 is
    // still addressable after request 2 — the hold belongs to the session, not
    // to a request.
    const granted = await resolve(userId, heldCallId, "session");
    expect(granted.status).toBe("resumed");
    if (granted.status === "resumed") {
      expect(granted.result.response).toBe("You have mail.");
      expect(granted.result.held).toBeUndefined();
    }
  });

  it("a spending hold is answered with 'approve_once': one order commits, no grant is minted", async () => {
    const userId = "http-resolve-spend-user";
    const ciphertext = await seedCiphertext({
      scopes: ["delivery.read", "delivery.order"],
    });
    const quote = await mintQuote("golden-wok", ["kung-pao-chicken"]); // $11.50
    const { client } = scriptedLLM([
      {
        tools: [
          {
            type: "tool_use",
            id: "toolu_order",
            name: "mock_delivery_order",
            input: { quoteId: quote.quoteId, idempotencyKey: "k-http-1" },
          },
        ],
      },
      { text: "ordered" }, // the resume's final text
    ]);

    // Policy allows the order; the SPEND stage is what holds it. The prior
    // spend is seeded on the session the routes derive, so the $20 session cap
    // is already $15 down and this $11.50 order breaches it.
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_delivery", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: PHASE0_AGENT_ID,
      });
      instance.createSessionGrant("mock_delivery", "order", "golden-wok", sessionId);
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      spendLedgerData.insertSpendInTxn(sql, {
        id: crypto.randomUUID(),
        sessionId,
        createdAt: new Date().toISOString(),
        service: "mock_delivery",
        verb: "order",
        amountCents: 1500,
        quoteId: "seed-prior",
        idempotencyKey: "prior",
        auditEntryId: "seed-audit",
      });
      instance.setLLMClient(client);
    });

    const first = await chat(userId, "order the kung pao chicken");
    expect(first.held?.heldCallId).toBeTruthy();

    // The hold carries the spend reason, and nothing was committed yet.
    const heldRows = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ spend_context: string | null }>`
        SELECT spend_context FROM held_tool_calls
      `,
    ]);
    expect(heldRows).toHaveLength(1);
    expect(JSON.parse(heldRows[0]!.spend_context!).reason).toBe("over_limit");

    const grantsBefore = await countPolicyEntries(userId);

    const resolved = await resolve(userId, first.held!.heldCallId, "approve_once");
    expect(resolved.status).toBe("resumed");

    // Exactly one new committed order, on the SAME session the cap was
    // measured against — a resolve that derived a different session would have
    // found an empty window and never held in the first place.
    const ledger = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ idempotency_key: string; amount_cents: number }>`
        SELECT idempotency_key, amount_cents FROM spend_ledger
      `,
    ]);
    expect(ledger.map((r) => r.idempotency_key).sort()).toEqual([
      "k-http-1",
      "prior",
    ]);

    // approve_once mints nothing — it dispatches the one parked order.
    expect(await countPolicyEntries(userId)).toBe(grantsBefore);
  });
});

/** Mint a real bound quote from the mock delivery service. */
async function mintQuote(
  merchant: string,
  items: string[],
): Promise<MockQuoteResult> {
  const result = await executeMockDeliveryQuote({ merchant, items }, Date.now());
  if (!result.success) throw new Error(`quote failed: ${result.error}`);
  return result.data as MockQuoteResult;
}

async function countPolicyEntries(userId: string): Promise<number> {
  const rows = await runInDurableObject(stubFor(userId), (instance) => [
    ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`,
  ]);
  return rows[0]!.n;
}
