import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";
import { seedCiphertext } from "../helpers/seed-credential";
import { workerFetch, post, get, stubFor } from "../helpers/http";
import type {
  ChatResponse,
  KillResponse,
  StatusResponse,
} from "@habenula-ai/contracts";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

/**
 * Kill over the full HTTP path — the companion to kill-switch-invariant.test.ts,
 * which drives `killSwitch()` on the DO directly.
 *
 * Kill is boundary-load-bearing because everything it acts on was created by
 * earlier requests: the grants, the parked call, and the live session. It has to
 * reach the same session those requests derived, or it sweeps an empty one and
 * reports success while the real state survives. So this drives the whole arc
 * over the routes — a granted turn, a parked turn, `POST /api/kill`, then a read
 * and a further turn — and never supplies a `sessionId`.
 *
 * The invariant suite stays the thorough one: transaction composition, the
 * mid-resolve race, idempotency, and the deny-floor assertions all belong on the
 * DO's own surface.
 */

/**
 * A scripted LLM. Each entry is either a `mock_email_list` call on one label
 * (the derived noun) or a final text. The last entry repeats.
 */
function scriptedLLM(script: Array<{ label?: string; text?: string }>): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.label) {
        return {
          id: `msg_${i}`,
          content: [
            {
              type: "tool_use",
              id: `toolu_${i}`,
              name: "mock_email_list",
              input: { label: step.label },
            },
          ],
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

describe("kill over the full HTTP path", () => {
  it("sweeps the hold and the grant earlier requests created, so the next turn must ask again", async () => {
    const userId = "http-kill-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(
        scriptedLLM([
          { label: "INBOX" }, // turn 1 → held
          { text: "listed" }, // resume after the session grant
          { label: "ARCHIVE" }, // turn 2 → a different noun, so held again
          { label: "INBOX" }, // post-kill turn → the swept grant no longer covers it
        ]),
      );
    });

    // Request 1: the un-granted call parks.
    const turn1 = (await (
      await workerFetch(post("/api/chat", { userId, message: "list inbox" }))
    ).json()) as ChatResponse;
    expect(turn1.held?.heldCallId).toBeTruthy();

    // Request 2: grant it for the session, which executes the parked call.
    const resolved = await workerFetch(
      post("/api/resolve", {
        userId,
        heldCallId: turn1.held!.heldCallId,
        choice: "session",
      }),
    );
    expect(resolved.status).toBe(200);

    // Request 3: a call on a different noun parks, so a live hold and a live
    // grant coexist at kill time.
    const turn2 = (await (
      await workerFetch(post("/api/chat", { userId, message: "now the archive" }))
    ).json()) as ChatResponse;
    expect(turn2.held?.heldCallId).toBeTruthy();

    // The aggregate read sees both, over the same session.
    const before = (await (
      await workerFetch(get("/api/status", { userId }))
    ).json()) as StatusResponse;
    expect(before.session).not.toBeNull();
    expect(before.grants.length).toBeGreaterThan(0);
    expect(before.held).not.toBeNull();

    // Request 4: kill.
    const killRes = await workerFetch(post("/api/kill", { userId }));
    expect(killRes.status).toBe(200);
    const killed = (await killRes.json()) as KillResponse;
    expect(killed.killed).toBe(true);

    // Only the deny floor survives, the hold is swept, and the session the
    // earlier requests derived is the one that ended.
    const after = await runInDurableObject(stubFor(userId), (instance) => ({
      policy: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`],
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`],
      sessionEnd: [
        ...instance.sql<{ error_message: string | null }>`
          SELECT error_message FROM audit_log WHERE tool_name = 'session.end'
        `,
      ],
      services: [
        ...instance.sql<{ service: string }>`SELECT service FROM connected_services`,
      ],
    }));
    expect(after.policy).toHaveLength(1);
    expect(after.policy[0]!.id).toBe(WILDCARD_DENY_ID);
    expect(after.held).toHaveLength(0);
    expect(after.sessionEnd).toHaveLength(1);
    expect(after.sessionEnd[0]!.error_message).toBe("kill");
    // Kill acts on governance state only — the connection survives it, so the
    // user resumes without re-running OAuth.
    expect(after.services).toHaveLength(1);

    // Request 5: a turn after the kill repeats the action the session grant used
    // to cover. It parks for confirmation instead of executing — the grant is
    // really gone, on the session the routes derive. Kill leaves the
    // `default-deny` floor standing, and a floor match asks rather than refuses,
    // so "held again" is the observable proof, not a hard deny.
    const afterTurn = (await (
      await workerFetch(post("/api/chat", { userId, message: "list inbox again" }))
    ).json()) as ChatResponse;
    expect(afterTurn.held?.heldCallId).toBeTruthy();
    expect(afterTurn.toolCalls.at(-1)?.outcome).toBe("held");

    // And it parked in a NEW session: kill ended the one the first four requests
    // shared, so the slot was free.
    const starts = await runInDurableObject(stubFor(userId), (instance) => [
      ...instance.sql<{ session_id: string }>`
        SELECT session_id FROM audit_log WHERE tool_name = 'session.start'
      `,
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.session_id).not.toBe(starts[1]!.session_id);
  });
});
