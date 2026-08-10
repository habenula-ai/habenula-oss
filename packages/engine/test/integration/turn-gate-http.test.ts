/**
 * The turn gate at the HTTP boundary: a busy refusal
 * ships as the shared ErrorResponse envelope at 409 with
 * error_code TURN_IN_PROGRESS — never a result variant. This is the exact
 * shape the ApiClient.resolve()/chat error paths key on, and the
 * full-path test the wiring-blind-spot rule
 * requires for handler↔DO marshaling. The happy 200/resumed and 404 wire
 * mappings live in http-contract.test.ts; this file owns only the busy→409 map.
 *
 * Determinism: the turn that holds the gate is started IN the DO
 * on a controllableLLM whose call hangs until release(). The DO is
 * single-threaded, so the gate is held the instant the (un-awaited) call
 * returns — before the second request is issued. The second request then
 * crosses the real HTTP boundary and hits a provably-held gate. No HOLD_MS
 * timer and no polling race, so full-suite load can no longer reorder it.
 */
import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asTurn } from "../helpers/turn";
import { controllableLLM, textResponse, toolUseResponse } from "../helpers/llm";
import type { UserAgent } from "../../src/agent/user-agent";

/**
 * Deterministic tests do no in-test waiting; this budget is pure headroom so a
 * saturated full suite (heavy import contention) can't time out the
 * sub-second bodies below on the default 5s deadline.
 */
const GATE_TEST_TIMEOUT_MS = 10_000;

function postResolve(
  userId: string,
  heldCallId: string,
  choice: string,
): Promise<Response> {
  return SELF.fetch("http://localhost/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, heldCallId, choice }),
  });
}

function postChat(userId: string, message: string): Promise<Response> {
  return SELF.fetch("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, message }),
  });
}

/** White-box read of the turn-gate marker: asserts the gate is held before we
 * issue the second request, enforcing that resolveConfirmation/chat set it
 * synchronously (a future await before the set would reintroduce the race). */
function gateHeld(instance: unknown): boolean {
  return (instance as { turnInFlight: boolean }).turnInFlight;
}

describe("turn gate over the HTTP boundary", () => {
  it("maps a concurrent second resolve to 409 TURN_IN_PROGRESS on the wire", { timeout: GATE_TEST_TIMEOUT_MS }, async () => {
    const userId = "resolve-409-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // call 1 parks the hold; call 2 (the deny-resume) hangs, holding the gate.
      const llm = controllableLLM([toolUseResponse(), null]);
      agent.setLLMClient(llm.client);

      const held = asTurn(await agent.chat({ message: "list inbox", userId }));
      const heldCallId = held.held!.heldCallId;

      // First resolve runs in-DO and parks on the hung resume LLM. Single-
      // threaded, so the gate is held the instant this un-awaited call returns.
      const first = agent.resolveConfirmation({ heldCallId, choice: "deny", userId });
      expect(gateHeld(instance)).toBe(true);

      // The concurrent second resolve crosses the real HTTP boundary while the
      // resume is mid-flight — the path this test exists to cover — and must map
      // the DO's busy status to a 409 TURN_IN_PROGRESS error envelope.
      const second = await postResolve(userId, heldCallId, "deny");
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error_code: string };
      expect(body.error_code).toBe("TURN_IN_PROGRESS");

      // Releasing the LLM lets the first resolve finish and reopens the gate.
      llm.release(textResponse("resumed"));
      const done = await first;
      expect(done.status).toBe("resumed");
      expect(gateHeld(instance)).toBe(false);
    });
  });

  it("maps a mid-flight second chat to 409 TURN_IN_PROGRESS, then recovers", { timeout: GATE_TEST_TIMEOUT_MS }, async () => {
    const userId = "chat-409-user";
    const stub = env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      // The first turn's LLM call hangs, holding the gate; release() answers it.
      const llm = controllableLLM([null]);
      agent.setLLMClient(llm.client);

      const first = agent.chat({ message: "one", userId });
      expect(gateHeld(instance)).toBe(true);

      const second = await postChat(userId, "two");
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string; error_code: string };
      expect(body.error_code).toBe("TURN_IN_PROGRESS");
      expect(body.error).toContain("turn is already in progress");

      llm.release(textResponse("first turn"));
      const firstResult = asTurn(await first);
      expect(firstResult.response).toBe("first turn");
      expect(gateHeld(instance)).toBe(false);
    });
  });
});
