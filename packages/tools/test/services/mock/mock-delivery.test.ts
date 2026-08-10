import { describe, it, expect } from "vitest";
import {
  ALWAYS_DECLINES_MERCHANT,
  MOCK_DELIVERY_ORDER,
  MOCK_DELIVERY_QUOTE,
  MOCK_DELIVERY_SEARCH,
  MOCK_MERCHANTS,
  MAX_CART_ITEMS,
  QUOTE_ID_PREFIX,
  QUOTE_TTL_MS,
  SURGE_BUCKET_MS,
  SURGE_MERCHANT,
  decodeQuotePayload,
  decodeQuotedAmountCents,
  executeMockDeliveryOrder,
  fnv1a64Hex,
  executeMockDeliveryQuote,
  executeMockDeliverySearch,
  mockDelivery,
  surgeMultiplierPercent,
  verifyQuoteId,
  type MockOrderResult,
  type MockQuoteResult,
} from "../../../src/services/mock/mock-delivery";
import type { StoredCredential } from "@habenula-ai/credentials";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

const CREDENTIAL = { accessToken: "mock" } as unknown as StoredCredential;

/** The module's private base64url encoding, re-stated once for forgeries. */
function b64url(json: string): string {
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Split a real quote id into its (body, sig) parts for tampering. */
function splitId(quoteId: string): { body: string; sig: string } {
  const [body, sig] = quoteId.slice(QUOTE_ID_PREFIX.length).split(".");
  return { body: body!, sig: sig! };
}

async function quote(
  params: Record<string, unknown>,
  nowMs: number = NOW,
): Promise<MockQuoteResult> {
  const result = await executeMockDeliveryQuote(params, nowMs);
  expect(result.success).toBe(true);
  return result.data as MockQuoteResult;
}

describe("executeMockDeliverySearch", () => {
  it("returns every seeded merchant with priced menus", () => {
    const result = executeMockDeliverySearch({});
    expect(result.success).toBe(true);
    const { merchants } = result.data as { merchants: typeof MOCK_MERCHANTS };
    expect(merchants).toHaveLength(MOCK_MERCHANTS.length);
    for (const m of merchants) {
      expect(m.menu.length).toBeGreaterThan(0);
      for (const item of m.menu) {
        expect(Number.isSafeInteger(item.priceCents)).toBe(true);
        expect(item.priceCents).toBeGreaterThan(0);
      }
    }
  });

  it("narrows to one merchant; an unknown filter narrows to nothing", () => {
    const one = executeMockDeliverySearch({ merchant: "tartine-bakery" });
    expect((one.data as { merchants: unknown[] }).merchants).toHaveLength(1);
    const none = executeMockDeliverySearch({ merchant: "no-such-place" });
    expect((none.data as { merchants: unknown[] }).merchants).toHaveLength(0);
  });
});

describe("executeMockDeliveryQuote", () => {
  it("prices a cart, binds it into a signed quote id, and stamps the TTL", async () => {
    const q = await quote({
      merchant: "tartine-bakery",
      items: ["sourdough-loaf", "cold-brew"],
    });
    expect(q.totalCents).toBe(650 + 450);
    expect(q.merchant).toBe("tartine-bakery");
    expect(Date.parse(q.expiresAt)).toBe(NOW + QUOTE_TTL_MS);

    const payload = decodeQuotePayload(q.quoteId);
    expect(payload).not.toBeNull();
    expect(payload!.totalCents).toBe(q.totalCents);
    expect(payload!.merchant).toBe("tartine-bakery");
    expect(payload!.expiresAt).toBe(NOW + QUOTE_TTL_MS);

    // The signature verifies for the untouched id.
    expect(await verifyQuoteId(q.quoteId)).toEqual(payload);
  });

  it("a repeated item id is counted twice", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["spring-rolls", "spring-rolls"] });
    expect(q.totalCents).toBe(1100);
  });

  it("rejects an unknown merchant, an unknown item, and an empty cart", async () => {
    const unknownMerchant = await executeMockDeliveryQuote({
      merchant: "no-such-place",
      items: ["x"],
    });
    expect(unknownMerchant).toEqual({
      success: false,
      error: "unknown_merchant: no-such-place",
    });

    const unknownItem = await executeMockDeliveryQuote({
      merchant: "golden-wok",
      items: ["sourdough-loaf"],
    });
    expect(unknownItem).toEqual({
      success: false,
      error: "unknown_item: sourdough-loaf",
    });

    const empty = await executeMockDeliveryQuote({ merchant: "golden-wok", items: [] });
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("empty_cart");

    // Missing merchant reports the (none) fallback, not "undefined".
    const noMerchant = await executeMockDeliveryQuote({ items: ["x"] });
    expect(noMerchant.success).toBe(false);
    expect(noMerchant.error).toContain("unknown_merchant: (none)");

    // A non-array items value is an empty cart, not a crash.
    const notArray = await executeMockDeliveryQuote({
      merchant: "golden-wok",
      items: "cold-brew",
    });
    expect(notArray.success).toBe(false);
    expect(notArray.error).toContain("empty_cart");

    // A non-string entry fails LOUDLY — silently dropping it would bind a
    // quote for a smaller cart than the model believes it ordered.
    const nonString = await executeMockDeliveryQuote({
      merchant: "golden-wok",
      items: ["spring-rolls", 2],
    });
    expect(nonString.success).toBe(false);
    expect(nonString.error).toContain("unknown_item");

    // The cart cap: every real provider bounds carts, so the template does.
    const huge = await executeMockDeliveryQuote({
      merchant: "golden-wok",
      items: Array(MAX_CART_ITEMS + 1).fill("spring-rolls"),
    });
    expect(huge.success).toBe(false);
    expect(huge.error).toContain("cart_too_large");
    const atCap = await quote({
      merchant: "golden-wok",
      items: Array(MAX_CART_ITEMS).fill("spring-rolls"),
    });
    expect(atCap.totalCents).toBe(550 * MAX_CART_ITEMS);
  });

  it("merchant matching is case-folded to agree with the governed noun", async () => {
    const q = await quote({ merchant: "Golden-Wok", items: ["spring-rolls"] });
    expect(q.merchant).toBe("golden-wok");
    const one = executeMockDeliverySearch({ merchant: "Tartine-Bakery" });
    expect((one.data as { merchants: unknown[] }).merchants).toHaveLength(1);
  });

  it("fnv1a64Hex matches known vectors and the items hash is order-independent", async () => {
    // FNV-1a 64 offset basis (empty input) and the standard "a" vector.
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325");
    expect(fnv1a64Hex("a")).toBe("af63dc4c8601ec8c");
    const ab = await quote({ merchant: "golden-wok", items: ["spring-rolls", "kung-pao-chicken"] });
    const ba = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken", "spring-rolls"] });
    expect(decodeQuotePayload(ab.quoteId)!.itemsHash).toBe(
      decodeQuotePayload(ba.quoteId)!.itemsHash,
    );
  });

  it("a tampered payload fails signature verification but still decodes (sync amount extractor)", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    // Understate the price: re-encode the payload with a cheaper total but
    // keep the original signature — the cap-bypass attempt.
    const { body, sig } = splitId(q.quoteId);
    const json = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
    json.totalCents = 1;
    const forged = `${QUOTE_ID_PREFIX}${b64url(JSON.stringify(json))}.${sig}`;

    // The pipeline-side decode reads the claimed amount (it can pass the cap
    // check)…
    expect(decodeQuotePayload(forged)!.totalCents).toBe(1);
    // …but commit's verification rejects it — a forged quote never moves money.
    expect(await verifyQuoteId(forged)).toBeNull();
  });

  it("one signed quote is exactly ONE id string — non-canonical variants of a valid id die", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    const { body, sig } = splitId(q.quoteId);
    // atob skips whitespace and a loose split ignores trailing segments, so
    // without the canonical gate each of these would still verify — giving
    // one quote unlimited distinct id strings, and the order stage keys order
    // identity and ledger uniqueness on the raw string.
    const variants = [
      `${QUOTE_ID_PREFIX}${body.slice(0, 4)} ${body.slice(4)}.${sig}`, // space
      `${QUOTE_ID_PREFIX}${body.slice(0, 4)}\n${body.slice(4)}.${sig}`, // newline
      `${q.quoteId}.junk`, // extra dot segment
      `${QUOTE_ID_PREFIX}${body}.${sig.toUpperCase()}`, // non-canonical sig hex
      `${QUOTE_ID_PREFIX}${body}.${sig.slice(0, 8)}`, // truncated sig
    ];
    for (const variant of variants) {
      expect(decodeQuotePayload(variant)).toBeNull();
      expect(await verifyQuoteId(variant)).toBeNull();
    }
    // The canonical id itself still decodes and verifies.
    expect(decodeQuotePayload(q.quoteId)).not.toBeNull();
    expect(await verifyQuoteId(q.quoteId)).not.toBeNull();
  });

  it("the decoder rejects non-positive totals and unsafe or non-finite expiries", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    const { body, sig } = splitId(q.quoteId);
    const base = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
    const forgeries = [
      { ...base, totalCents: 0 },
      { ...base, totalCents: -500 }, // a negative claim would shrink the windows
      { ...base, totalCents: 2 ** 53 },
      { ...base, expiresAt: -1 },
      { ...base, expiresAt: 2 ** 53 }, // unsafe — and JSON 1e999 parses to Infinity
    ];
    for (const forged of forgeries) {
      const id = `${QUOTE_ID_PREFIX}${b64url(JSON.stringify(forged))}.${sig}`;
      expect(decodeQuotePayload(id)).toBeNull();
    }
    // JSON.parse("1e999") is Infinity — the immortal-quote forgery.
    const immortalJson = JSON.stringify(base).replace(
      `"expiresAt":${String(base.expiresAt)}`,
      '"expiresAt":1e999',
    );
    const immortal = `${QUOTE_ID_PREFIX}${b64url(immortalJson)}.${sig}`;
    expect(decodeQuotePayload(immortal)).toBeNull();
  });

  it("garbage never decodes: wrong prefix, bad base64, wrong shape", () => {
    expect(decodeQuotePayload("not-a-quote")).toBeNull();
    expect(decodeQuotePayload("mockq_!!!.deadbeef")).toBeNull();
    const wrongShape = b64url(JSON.stringify({ hello: "world" }));
    expect(decodeQuotePayload(`${QUOTE_ID_PREFIX}${wrongShape}.deadbeefdeadbeef`)).toBeNull();
  });

  it("surge pricing: deterministic within a bucket, different across the boundary", async () => {
    const inBucket = Math.floor(NOW / SURGE_BUCKET_MS) * SURGE_BUCKET_MS;
    const a = await quote({ merchant: SURGE_MERCHANT, items: ["tuna-roll"] }, inBucket);
    const b = await quote({ merchant: SURGE_MERCHANT, items: ["tuna-roll"] }, inBucket + 1);
    expect(a.totalCents).toBe(b.totalCents);

    const nextBucket = await quote(
      { merchant: SURGE_MERCHANT, items: ["tuna-roll"] },
      inBucket + SURGE_BUCKET_MS,
    );
    expect(nextBucket.totalCents).not.toBe(a.totalCents);
    // The multiplier alternates 100/150 — both prices derive from the base.
    const prices = [a.totalCents, nextBucket.totalCents].sort((x, y) => x - y);
    expect(prices).toEqual([900, 1350]);
  });

  it("non-surge merchants never surge", async () => {
    const even = await quote({ merchant: "golden-wok", items: ["spring-rolls"] }, 0);
    const odd = await quote(
      { merchant: "golden-wok", items: ["spring-rolls"] },
      SURGE_BUCKET_MS,
    );
    expect(even.totalCents).toBe(550);
    expect(odd.totalCents).toBe(550);
  });

  it("surgeMultiplierPercent alternates 100/150 by bucket", () => {
    expect(surgeMultiplierPercent(0)).toBe(100);
    expect(surgeMultiplierPercent(SURGE_BUCKET_MS)).toBe(150);
    expect(surgeMultiplierPercent(2 * SURGE_BUCKET_MS)).toBe(100);
  });
});

describe("mock_delivery tools", () => {
  it("declares the service, verbs, scopes, and connect arm the spec names", () => {
    expect(mockDelivery.service).toBe("mock_delivery");
    expect(mockDelivery.connect).toEqual({
      type: "oauth",
      provider: "mock",
      scopes: ["delivery.read", "delivery.order"],
    });
    expect(mockDelivery.tools.map((t) => t.verb)).toEqual([
      "search",
      "quote",
      "order",
    ]);
    expect(MOCK_DELIVERY_SEARCH.requiredScopes).toEqual(["delivery.read"]);
    expect(MOCK_DELIVERY_QUOTE.requiredScopes).toEqual(["delivery.read"]);
    expect(MOCK_DELIVERY_ORDER.requiredScopes).toEqual(["delivery.order"]);
  });

  it("only the money verb carries the spend field — its presence IS the verb class", () => {
    expect(MOCK_DELIVERY_SEARCH.spend).toBeUndefined();
    expect(MOCK_DELIVERY_QUOTE.spend).toBeUndefined();
    expect(MOCK_DELIVERY_ORDER.spend).toBeDefined();
  });

  it("search governs under the merchant filter or the `all` sentinel", () => {
    expect(MOCK_DELIVERY_SEARCH.nounExtractor({})).toBe("all");
    expect(MOCK_DELIVERY_SEARCH.nounExtractor({ merchant: "" })).toBe("all");
    expect(MOCK_DELIVERY_SEARCH.nounExtractor({ merchant: "Tartine-Bakery" })).toBe(
      "tartine-bakery",
    );
  });

  it("quote governs under the merchant, with a collision-proof invalid sentinel", () => {
    expect(MOCK_DELIVERY_QUOTE.nounExtractor({ merchant: "Golden-Wok" })).toBe(
      "golden-wok",
    );
    expect(MOCK_DELIVERY_QUOTE.nounExtractor({})).toBe("invalid-merchant");
    expect(MOCK_DELIVERY_QUOTE.nounExtractor({ merchant: "" })).toBe("invalid-merchant");
  });

  it("order governs under the quote's bound merchant, or the invalid-quote sentinel", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["spring-rolls"] });
    expect(MOCK_DELIVERY_ORDER.nounExtractor({ quoteId: q.quoteId })).toBe("golden-wok");
    expect(MOCK_DELIVERY_ORDER.nounExtractor({})).toBe("invalid-quote");
    expect(MOCK_DELIVERY_ORDER.nounExtractor({ quoteId: "garbage" })).toBe("invalid-quote");
  });

  it("executors require the mock credential, like every connected service", async () => {
    const noCred = await MOCK_DELIVERY_SEARCH.execute({}, { userId: "u" });
    expect(noCred.success).toBe(false);
    expect(noCred.error).toContain("No credential");

    const withCred = await MOCK_DELIVERY_QUOTE.execute(
      { merchant: ALWAYS_DECLINES_MERCHANT, items: ["patty-melt"] },
      { userId: "u", credential: CREDENTIAL },
    );
    // Quoting at the declines merchant works — only commit declines there.
    expect(withCred.success).toBe(true);
  });
});

describe("executeMockDeliveryOrder", () => {
  async function order(
    params: Record<string, unknown>,
    nowMs: number = NOW,
  ): Promise<MockOrderResult> {
    const result = await executeMockDeliveryOrder(params, nowMs);
    expect(result.success).toBe(true);
    return result.data as MockOrderResult;
  }

  it("commits exactly the signed quote's total — the quote binds the price", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    const o = await order({ quoteId: q.quoteId, idempotencyKey: "k-1" });
    expect(o.chargedCents).toBe(q.totalCents);
    expect(o.merchant).toBe("golden-wok");
    expect(o.orderId).toMatch(/^mocko_/);
  });

  it("an expired quote voids the commit — never a silent re-price", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["spring-rolls"] });
    const result = await executeMockDeliveryOrder(
      { quoteId: q.quoteId, idempotencyKey: "k-1" },
      NOW + QUOTE_TTL_MS,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("quote_expired");
  });

  it("a tampered or fabricated quote id commits nothing", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    const [prefixAndBody, sig] = q.quoteId.split(".");
    const body = prefixAndBody!.slice("mockq_".length);
    const json = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/")),
    ) as Record<string, unknown>;
    json.totalCents = 1;
    const forgedBody = btoa(JSON.stringify(json))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    for (const bad of [`mockq_${forgedBody}.${sig}`, "mockq_garbage", "", "not-a-quote"]) {
      const result = await executeMockDeliveryOrder({
        quoteId: bad,
        idempotencyKey: "k-1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("quote_invalid");
    }
  });

  it("a missing idempotency key is rejected before anything else", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["spring-rolls"] });
    const result = await executeMockDeliveryOrder({ quoteId: q.quoteId });
    expect(result.success).toBe(false);
    expect(result.error).toContain("idempotencyKey");
  });

  it("the always-declines merchant fails every commit — distinguishable from the cap", async () => {
    const q = await quote({
      merchant: ALWAYS_DECLINES_MERCHANT,
      items: ["patty-melt"],
    });
    const result = await executeMockDeliveryOrder(
      { quoteId: q.quoteId, idempotencyKey: "k-1" },
      NOW,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("merchant_declined");
  });

  it("replay-safety is structural: same key + same quote returns the SAME order", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["spring-rolls"] });
    const first = await order({ quoteId: q.quoteId, idempotencyKey: "k-1" });
    const retried = await order({ quoteId: q.quoteId, idempotencyKey: "k-1" });
    expect(retried.orderId).toBe(first.orderId);
  });

  it("a reused key under a DIFFERENT quote derives a NEW order — not a replay", async () => {
    const a = await quote({ merchant: "golden-wok", items: ["spring-rolls"] });
    const b = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    const first = await order({ quoteId: a.quoteId, idempotencyKey: "k-1" });
    const second = await order({ quoteId: b.quoteId, idempotencyKey: "k-1" });
    expect(second.orderId).not.toBe(first.orderId);
  });

  it("decodeQuotedAmountCents reads the bound total sync; garbage reads null (unpriced)", async () => {
    const q = await quote({ merchant: "golden-wok", items: ["kung-pao-chicken"] });
    expect(decodeQuotedAmountCents({ quoteId: q.quoteId })).toBe(q.totalCents);
    expect(decodeQuotedAmountCents({})).toBeNull();
    expect(decodeQuotedAmountCents({ quoteId: "garbage" })).toBeNull();
  });
});
