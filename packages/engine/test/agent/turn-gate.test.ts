/**
 * The turn-in-flight gate: one
 * loop-running turn per DO across every origin. Chat mid-turn is refused
 * busy; a concurrent second resolve mid-resume is refused busy (the gate
 * opens after loadHeldCall + parse guards, so the answered retry-resume
 * branch is covered); and the marker clears on every exit — completion,
 * parking as a held call, and a thrown turn (the wedge test: a persisted or
 * leaked marker would refuse every future turn forever).
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { asTurn } from "../helpers/turn";
import { controllableLLM, textResponse, toolUseResponse } from "../helpers/llm";
import type { UserAgent } from "../../src/agent/user-agent";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

describe("turn-in-flight gate", () => {
  it("refuses a second chat while a turn is mid-flight, then admits after release", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const llm = controllableLLM([null, textResponse("done")]);
      agent.setLLMClient(llm.client);

      const first = agent.chat({ message: "one", userId: "u" });
      // first turn is parked on the hanging LLM call; the marker is set
      const second = await agent.chat({ message: "two", userId: "u" });
      expect(second).toEqual({ busy: true });

      llm.release(textResponse("first done"));
      expect(asTurn(await first).response).toBe("first done");

      // marker released on completion — a third turn runs normally
      const third = asTurn(await agent.chat({ message: "three", userId: "u" }));
      expect(third.response).toBe("done");
    });
  });

  it("clears the marker on a thrown turn — the wedge test", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      const llm = controllableLLM([null, textResponse("recovered")]);
      agent.setLLMClient(llm.client);

      const first = agent.chat({ message: "one", userId: "u" });
      llm.fail(new Error("transient LLM failure"));
      await expect(first).rejects.toThrow("transient LLM failure");

      // A leaked marker would return { busy: true } here forever.
      const second = asTurn(await agent.chat({ message: "two", userId: "u" }));
      expect(second.response).toBe("recovered");
    });
  });

  it("releases the marker when a turn parks as a held call", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      const llm = controllableLLM([toolUseResponse()]);
      agent.setLLMClient(llm.client);

      const first = asTurn(await agent.chat({ message: "list", userId: "u" }));
      expect(first.held).toBeDefined();

      // Not busy: the marker released the instant the turn parked. The
      // outstanding-held guard answers instead (its response names the wait).
      const second = asTurn(await agent.chat({ message: "again", userId: "u" }));
      expect(second.held?.heldCallId).toBe(first.held!.heldCallId);
      expect(second.response).toContain("awaiting your confirmation");
    });
  });

  it("refuses a concurrent second resolve while a resume is mid-flight", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as UserAgent;
      agent.connectService("mock_email");
      // call 1: park the hold; call 2 (the deny-resume): hang.
      const llm = controllableLLM([toolUseResponse(), null]);
      agent.setLLMClient(llm.client);

      const held = asTurn(await agent.chat({ message: "list", userId: "u" }));
      const heldCallId = held.held!.heldCallId;

      const firstResolve = agent.resolveConfirmation({
        heldCallId,
        choice: "deny",
        userId: "u",
      });
      // the deny has been recorded and the resume is awaiting the hung LLM —
      // a second resolve (any choice, including tell_more) is refused busy
      const secondResolve = await agent.resolveConfirmation({
        heldCallId,
        choice: "tell_more",
        userId: "u",
      });
      expect(secondResolve).toEqual({ status: "busy" });

      llm.release(textResponse("understood"));
      const done = await firstResolve;
      expect(done.status).toBe("resumed");
    });
  });
});
