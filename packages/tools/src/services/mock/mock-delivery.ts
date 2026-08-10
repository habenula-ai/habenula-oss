// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
import {
  decodeQuotePayload,
  decodeQuotedAmountCents,
  describeQuotedOrder,
  executeMockDeliveryOrder,
  executeMockDeliveryQuote,
  executeMockDeliverySearch,
  MAX_CART_ITEMS,
} from "./mock-delivery-data.js";

/**
 * Belt for the package convention that executors return `{ success: false,
 * error }` rather than throw: no throw path is reachable today (the quote
 * payload is ASCII by construction, so `btoa` cannot reject it), but a seeded
 * merchant id gaining a non-Latin1 character would change that silently.
 */
async function guarded(
  run: () => Promise<ToolExecutionResult> | ToolExecutionResult,
): Promise<ToolExecutionResult> {
  try {
    return await run();
  } catch (err) {
    return {
      success: false,
      error: `internal_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export * from "./mock-delivery-data.js";

/**
 * `mock_delivery` — the food-delivery-shaped mock paid service. A full
 * reference service on the `mock_email` pattern:
 * it connects through the existing `mock` OAuth provider, mints a real
 * credential, and dispatches through the real pipeline — only the merchant is
 * simulated. Tools are written longhand (the slack/github precedent; no
 * shared factory fits a delivery shape).
 *
 * The merchant is the governed noun for every verb, and grants name
 * merchants exactly (policy matching is exact-match; allow entries refuse
 * wildcards). The quote → bind → commit sequence is structural: `order`
 * takes only a quote id, so it cannot construct its own price —
 * the same property Uber's required `fare_id` provides.
 */

const MOCK_DELIVERY_READ_SCOPES = ["delivery.read"];

/**
 * The browse noun: the merchant filter, or the `all` sentinel when browsing
 * everything (precedent: the GitHub owner sentinel `@me`). The seeded
 * merchant set is closed and no merchant is named "all", so the sentinel
 * cannot collide. Emptiness is checked before coercion so a missing filter
 * governs under `all`, never the literal "undefined".
 */
function searchNoun(params: Record<string, unknown>): string {
  const merchant = params.merchant;
  if (typeof merchant !== "string" || merchant === "") {
    return "all";
  }
  return merchant.toLowerCase();
}

/**
 * The merchant noun for the priced verbs: the named merchant, lowercased, or
 * the `invalid-merchant` sentinel for a missing/empty one — which matches no
 * grant and no seeded merchant, so the call fails closed to a confirmation
 * whose executor then rejects the merchant anyway.
 */
function merchantNoun(params: Record<string, unknown>): string {
  const merchant = params.merchant;
  if (typeof merchant !== "string" || merchant === "") {
    return "invalid-merchant";
  }
  return merchant.toLowerCase();
}

const NO_CREDENTIAL: ToolExecutionResult = {
  success: false,
  error: "No credential found for service: mock_delivery",
};

export const MOCK_DELIVERY_SEARCH: Tool = {
  service: "mock_delivery",
  verb: "search",
  description:
    "Browse the mock food-delivery sandbox: seeded merchants and their menus " +
    "with prices. Optionally takes a merchant id to show just that menu. " +
    "No real merchants and no real money anywhere in this service.",
  requiredScopes: MOCK_DELIVERY_READ_SCOPES,
  inputSchema: {
    type: "object",
    properties: {
      merchant: {
        type: "string",
        description:
          "Merchant id to narrow to (e.g. tartine-bakery). Omit to list every merchant.",
      },
    },
  },
  nounExtractor: searchNoun,
  execute: async (params, ctx) => {
    if (!ctx.credential) return NO_CREDENTIAL;
    return guarded(() => executeMockDeliverySearch(params));
  },
};

export const MOCK_DELIVERY_QUOTE: Tool = {
  service: "mock_delivery",
  verb: "quote",
  description:
    "Price a cart at a mock-delivery merchant. Returns the exact total in " +
    "cents, a quote id, and an expiry — the quote BINDS the price: placing " +
    "the order charges exactly this total or fails, never a re-priced " +
    "amount. Quotes expire after a few minutes; an expired quote must be " +
    "re-quoted. Costs nothing to call.",
  requiredScopes: MOCK_DELIVERY_READ_SCOPES,
  inputSchema: {
    type: "object",
    properties: {
      merchant: {
        type: "string",
        description: "Merchant id the cart is priced at (e.g. golden-wok).",
      },
      items: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_CART_ITEMS,
        description:
          "Menu item ids from this merchant's menu; repeat an id to order it more than once. " +
          `At most ${MAX_CART_ITEMS} items per order.`,
      },
    },
    required: ["merchant", "items"],
  },
  nounExtractor: merchantNoun,
  execute: async (params, ctx) => {
    if (!ctx.credential) return NO_CREDENTIAL;
    return guarded(() => executeMockDeliveryQuote(params));
  },
};

/**
 * The order noun: the merchant, decoded synchronously from the quote id's
 * payload — the order call itself names no merchant, so
 * the governed noun is the one the bound quote committed to. An undecodable
 * id yields the `invalid-quote` sentinel: it matches no grant and no seeded
 * merchant, and such a call can never commit anyway (the executor rejects it).
 */
function orderNoun(params: Record<string, unknown>): string {
  const quoteId = typeof params.quoteId === "string" ? params.quoteId : "";
  return decodeQuotePayload(quoteId)?.merchant ?? "invalid-quote";
}

/**
 * The money verb. The `spend` field is what classifies it —
 * the spending cap keys off the field's presence, so the cap and the verb are
 * inseparable by construction. The tool takes only a quote id and an
 * idempotency key: it cannot construct its own price, which makes the
 * quote → bind → commit sequence structural (the property Uber's required
 * `fare_id` provides).
 */
export const MOCK_DELIVERY_ORDER: Tool = {
  service: "mock_delivery",
  verb: "order",
  description:
    "Place an order at a mock-delivery merchant by committing a quote from " +
    "mock_delivery_quote. THIS SPENDS (sandbox) MONEY: it charges exactly " +
    "the quoted total, or fails — an expired quote fails with quote_expired " +
    "and must be re-quoted. Requires the quoteId and a caller-chosen " +
    "idempotencyKey; retrying with the same pair returns the same order " +
    "instead of charging twice.",
  requiredScopes: ["delivery.order"],
  spend: {
    quotedAmountCents: decodeQuotedAmountCents,
    describe: describeQuotedOrder,
    // The ledger's dedupe identity: stable across a retry of this commit,
    // distinct for a new one (a new quote, or a new caller-chosen key).
    commitKeys: (params) => ({
      quoteId: typeof params.quoteId === "string" ? params.quoteId : "",
      idempotencyKey:
        typeof params.idempotencyKey === "string" ? params.idempotencyKey : "",
    }),
  },
  inputSchema: {
    type: "object",
    properties: {
      quoteId: {
        type: "string",
        description: "The bound quote id from mock_delivery_quote (mockq_…).",
      },
      idempotencyKey: {
        type: "string",
        description:
          "A caller-chosen key making this order retry-safe; reuse it only to retry this exact order.",
      },
    },
    required: ["quoteId", "idempotencyKey"],
  },
  nounExtractor: orderNoun,
  execute: async (params, ctx) => {
    if (!ctx.credential) return NO_CREDENTIAL;
    return guarded(() => executeMockDeliveryOrder(params));
  },
};

/**
 * The mock_delivery service: declarative data only, OAuth machinery on the
 * `mock` provider (whose consent page renders any mock service's name and
 * scopes). The `order` verb — the money verb — lands together with the spend
 * stage that governs it: a spend-capable tool with no
 * ceiling must never exist on main, even between merges.
 */
export const mockDelivery: ServiceDefinition = {
  service: "mock_delivery",
  connect: {
    type: "oauth",
    provider: "mock",
    scopes: ["delivery.read", "delivery.order"],
  },
  tools: [MOCK_DELIVERY_SEARCH, MOCK_DELIVERY_QUOTE, MOCK_DELIVERY_ORDER],
};
