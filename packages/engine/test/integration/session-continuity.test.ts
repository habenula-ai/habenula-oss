import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { workerFetch, post, stubFor } from "../helpers/http";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolResultBlock,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * the load-bearing coverage the shipped re-minting bug slipped
 * through: session continuity across the FULL HTTP path (worker.fetch), not the
 * DO's chat()/executeTool() directly. Before the cutover, handleChat/handleToolExecute
 * minted a fresh session-${Date.now()} per request, so a "for this session" grant
 * approved on one request never matched the next. These drive the real routes.
 *
 * The DO reached by worker.fetch is the by-name stub (index.ts getUserStub uses
 * idFromName(userId)), so we inject the mock LLM + credential into that stub
 * before fetching — that is what `stubFor` returns. Real DO, no platform mocks
 * (Hard Invariant #5).
 */

function toolUse(id: string): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label: "INBOX" } };
}

/** Mock LLM emitting a scripted response per call (tool_use list or final text). */
function scriptedLLM(
  script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>,
): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
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
}

/**
 * Enforce the real API's pairing rule on a mock client: every assistant
 * `tool_use` must be answered by a `tool_result` in the immediately-following
 * user message, else the request is rejected (the rule whose violation 400s
 * EVERY later turn). The plain scripted mocks are structurally blind to the
 * wedge class this catches — do not remove the validation.
 */
function pairingValidated(inner: LLMClient): LLMClient {
  return {
    async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
      const msgs = params.messages;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]!;
        if (m.role !== "assistant" || typeof m.content === "string") continue;
        const uses = m.content.filter(
          (b): b is LLMToolUseBlock => b.type === "tool_use",
        );
        if (uses.length === 0) continue;
        const next = msgs[i + 1];
        const answered =
          next && next.role === "user" && typeof next.content !== "string"
            ? next.content
                .filter((b): b is LLMToolResultBlock => b.type === "tool_result")
                .map((b) => b.tool_use_id)
            : [];
        for (const u of uses) {
          if (!answered.includes(u.id)) {
            throw new Error(
              `unanswered tool_use ${u.id} — the real API rejects this conversation`,
            );
          }
        }
      }
      return inner.createMessage(params);
    },
  };
}

type ChatJson = {
  response?: string;
  toolCalls?: unknown[];
  held?: { heldCallId: string };
};
type ResolveJson = { status: string };
// The narrowed /api/tools/execute wire: decision is
// top-level; the internal governance blob no longer ships.
type ExecJson = { decision: string };

describe("session continuity over the full HTTP path", () => {
  it("a 'for this session' grant approved on turn 1 authorizes the same action on turn 2 (POST /api/chat)", async () => {
    const userId = "continuity-chat-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(
        scriptedLLM([
          { tools: [toolUse("t1")] }, // turn 1: model calls the tool → held
          { text: "listed" }, // resume after the grant → tool executes → final text
          { tools: [toolUse("t2")] }, // turn 2: model calls the tool again
          { text: "listed again" }, // turn 2 executes → final text
        ]),
      );
    });

    // Turn 1 → the un-granted call is held.
    const turn1 = (await (
      await workerFetch(post("/api/chat", { userId, message: "list my inbox" }))
    ).json()) as ChatJson;
    expect(turn1.held?.heldCallId).toBeTruthy();

    // Approve a session-scoped grant over the real HTTP resolve route.
    const resolved = (await (
      await workerFetch(
        post("/api/resolve", {
          userId,
          heldCallId: turn1.held!.heldCallId,
          choice: "session",
        }),
      )
    ).json()) as ResolveJson;
    expect(resolved.status).toBe("resumed");

    // Turn 2, same action → authorized by the persisted session grant, NOT
    // re-held. This is the exact case the re-minting bug broke: pre-cutover,
    // turn 2 was a fresh session so the grant never matched and it held again.
    const turn2 = (await (
      await workerFetch(post("/api/chat", { userId, message: "list again" }))
    ).json()) as ChatJson;
    expect(turn2.held).toBeFalsy();
    expect(turn2.toolCalls?.length ?? 0).toBeGreaterThan(0);
  });

  it("two POST /api/tools/execute calls share one derived session (inverse of the per-request-mint bug)", async () => {
    const userId = "continuity-tools-user";
    const ciphertext = await seedCiphertext();
    // Seed a session grant scoped to the DO-derived active session, then two
    // execute calls must BOTH match it — proving they resolve to one session.
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: "onboarding",
      });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });

    // Neither body carries a sessionId — the boundary can't send one.
    const exec1 = (await (
      await workerFetch(
        post("/api/tools/execute", {
          userId,
          toolName: "mock_email_list",
          params: { label: "INBOX" },
        }),
      )
    ).json()) as ExecJson;
    const exec2 = (await (
      await workerFetch(
        post("/api/tools/execute", {
          userId,
          toolName: "mock_email_list",
          params: { label: "INBOX" },
        }),
      )
    ).json()) as ExecJson;

    // The session grant matched on BOTH calls → they share one session. Under
    // the old per-request mint, call 2's session differed and it would not have
    // matched a session-scoped grant.
    expect(exec1.decision).toBe("allow");
    expect(exec2.decision).toBe("allow");

    const sessions = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ session_id: string }>`
        SELECT DISTINCT session_id FROM audit_log WHERE tool_name = 'mock_email_list'
      `,
    ]);
    expect(sessions).toHaveLength(1);
  });

  it("quit with a held call does not wedge the next sitting — the orphaned tool_use is repaired", async () => {
    // The sweep (quit here; kill/timeout/superseded share the repair path)
    // deletes the held row but the in-memory conversation still ends with the
    // assistant's unanswered tool_use. Without chat()'s lazy repair, the
    // pairing-validating client rejects turn 2 AND every turn after it — a
    // permanent wedge, since the error rollback removes only the new user
    // message and resetConversation has no route.
    const userId = "continuity-quit-wedge-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(
        pairingValidated(
          scriptedLLM([
            { tools: [toolUse("t1")] }, // turn 1: un-granted call → held
            { text: "fresh sitting" }, // turn 2, after quit
          ]),
        ),
      );
    });

    const turn1 = (await (
      await workerFetch(post("/api/chat", { userId, message: "list my inbox" }))
    ).json()) as ChatJson;
    expect(turn1.held?.heldCallId).toBeTruthy();

    const quit = await workerFetch(post("/api/session/quit", { userId }));
    expect(quit.status).toBe(200);

    // Turn 2 runs in a fresh lazily-created session; the orphan from turn 1
    // was answered with a synthetic error tool_result, so the (validating)
    // client accepts the conversation.
    const turn2res = await workerFetch(
      post("/api/chat", { userId, message: "hello again" }),
    );
    expect(turn2res.status).toBe(200);
    const turn2 = (await turn2res.json()) as ChatJson;
    expect(turn2.held).toBeFalsy();
    expect(turn2.response).toBe("fresh sitting");
  });
});
