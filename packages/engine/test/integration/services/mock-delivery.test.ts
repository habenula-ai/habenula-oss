import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../../helpers/seed-credential";
import type { MockQuoteResult } from "@habenula-ai/tools/services/mock/mock-delivery";
import {
  decodeQuotePayload,
  MOCK_MERCHANTS,
} from "@habenula-ai/tools/services/mock/mock-delivery";

/**
 * mock_delivery through the real pipeline: connect
 * over the mock provider's credential path, then dispatch `search` and
 * `quote` through executeTool — real governance, real audit, real scope
 * gate. No money verb exists yet; browse and price are the whole surface.
 */
describe("mock_delivery integration", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  /** The delivery scopes ride the fixture's overrides, not a widened default
   * (the plan's rule — other services' fixtures stay untouched). */
  const deliveryCiphertext = () =>
    seedCiphertext({ scopes: ["delivery.read", "delivery.order"] });

  const baseParams = {
    userId: "user-1",
    agentId: "agent-1",
    epochId: "2026-07-10",
    timestamp: "2026-07-10T12:00:00Z",
  };

  it("granted search lists the seeded merchants under the `all` sentinel noun", async () => {
    const stub = getStub();
    const ciphertext = await deliveryCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_delivery", ciphertext);
      const sessionId = instance.resolveActiveSession(baseParams);
      instance.createSessionGrant("mock_delivery", "search", "all", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        toolName: "mock_delivery_search",
        toolParams: {},
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.noun).toBe("all");
    expect(result.execution!.success).toBe(true);
    const data = result.execution!.data as { merchants: typeof MOCK_MERCHANTS };
    expect(data.merchants).toHaveLength(MOCK_MERCHANTS.length);
  });

  it("granted quote returns a bound, decodable quote through the pipeline", async () => {
    const stub = getStub();
    const ciphertext = await deliveryCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_delivery", ciphertext);
      const sessionId = instance.resolveActiveSession(baseParams);
      instance.createSessionGrant("mock_delivery", "quote", "golden-wok", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        toolName: "mock_delivery_quote",
        toolParams: { merchant: "golden-wok", items: ["kung-pao-chicken", "spring-rolls"] },
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.governance.noun).toBe("golden-wok");
    expect(result.execution!.success).toBe(true);
    const quote = result.execution!.data as MockQuoteResult;
    // kung-pao-chicken (1150) + spring-rolls (550), per the seeded menu.
    expect(quote.totalCents).toBe(1150 + 550);
    // The id is self-describing: the payload the cap will price from
    // decodes synchronously and carries the same bound total.
    expect(decodeQuotePayload(quote.quoteId)!.totalCents).toBe(1150 + 550);
  });

  it("an ungranted quote parks pending — confirmation, not hard deny", async () => {
    const stub = getStub();
    const ciphertext = await deliveryCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_delivery", ciphertext);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        toolName: "mock_delivery_quote",
        toolParams: { merchant: "tartine-bakery", items: ["cold-brew"] },
      }),
    );

    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(result.held?.heldCallId).toBeTruthy();
  });

  it("a credential without the delivery scopes fails the scope precondition", async () => {
    const stub = getStub();
    // The default fixture's scopes are email-shaped — no delivery.*.
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_delivery", ciphertext);
      const sessionId = instance.resolveActiveSession(baseParams);
      instance.createSessionGrant("mock_delivery", "search", "all", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseParams,
        toolName: "mock_delivery_search",
        toolParams: {},
      }),
    );

    // The house assertion for this gate (slack/grant-isolation precedent):
    // a plain deny with the needs_authorization reason and no dispatch —
    // "didn't succeed" alone would also pass on an unrelated pending park.
    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.execution).toBeUndefined();
  });
});
