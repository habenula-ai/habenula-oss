// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seeded data and executors for `mock_delivery` — the food-delivery-shaped
 * mock paid service. No external network, no stored
 * state: executors cannot hold state (`ExecuteContext` is
 * `{ userId, credential? }` and module state does not survive the isolate),
 * so everything a commit later needs lives in the quote id itself —
 * `mockq_<base64url payload>.<sig>` — signed so tampering and fabrication
 * are rejected at commit. Quote TOTALS are
 * deterministic for a given cart and time bucket; quote IDS are not (each
 * carries a fresh nonce).
 *
 * The failure modes here are the cap's correctness dependencies, built from
 * real providers' documented behavior. Browse-and-price ships
 * quote expiry and the surge merchant's price change; duplicate idempotency
 * keys and the always-declines merchant are commit-time modes exercised by
 * the `order` verb, which lands together with the spending cap.
 */
import type { ToolExecutionResult } from "../../tools/types.js";

/**
 * Quote lifetime: minutes, not seconds —
 * the TTL must exceed ordinary confirmation latency or "Approve this order"
 * would fail at commit on the main path, turning the designed exception into
 * the norm. 10 minutes keeps expiry demoable inside one session.
 */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

/** Every commit at this merchant fails `merchant_declined` — the decline that
 * is NOT the cap, so the two controls are distinguishable. */
export const ALWAYS_DECLINES_MERCHANT = "declined-diner";

/** This merchant's quote total varies by a time-bucketed multiplier, so a
 * re-quote can return a different price — the price-change failure mode with
 * no storage. */
export const SURGE_MERCHANT = "surge-sushi";

/** Surge buckets: within one bucket a re-quote returns the same TOTAL (the
 * id still differs — fresh nonce); across a bucket boundary the multiplier
 * (100% ↔ 150%) flips. */
export const SURGE_BUCKET_MS = 5 * 60 * 1000;

export interface MockMenuItem {
  id: string;
  name: string;
  priceCents: number;
}

export interface MockMerchant {
  merchant: string;
  /** Human-readable name for the confirmation surface. */
  displayName: string;
  description: string;
  menu: MockMenuItem[];
}

/**
 * The closed, enumerable merchant set (fits the closed-enum noun posture).
 * Menus price a typical 2–3 item cart at $12–18,
 * so one ordinary order clears the shipped windows and a second order in the
 * same session prompts.
 */
export const MOCK_MERCHANTS: MockMerchant[] = [
  {
    merchant: "tartine-bakery",
    displayName: "Tartine Bakery",
    description: "Bakery and cafe — pastries, loaves, and coffee.",
    menu: [
      { id: "sourdough-loaf", name: "Sourdough loaf", priceCents: 650 },
      { id: "morning-bun", name: "Morning bun", priceCents: 550 },
      { id: "quiche-slice", name: "Quiche slice", priceCents: 700 },
      { id: "cold-brew", name: "Cold brew", priceCents: 450 },
    ],
  },
  {
    merchant: "golden-wok",
    displayName: "Golden Wok",
    description: "Chinese takeout — mains, rice, and sides.",
    menu: [
      { id: "kung-pao-chicken", name: "Kung pao chicken", priceCents: 1150 },
      { id: "veggie-fried-rice", name: "Veggie fried rice", priceCents: 850 },
      { id: "spring-rolls", name: "Spring rolls (4)", priceCents: 550 },
      { id: "hot-and-sour-soup", name: "Hot and sour soup", priceCents: 500 },
    ],
  },
  {
    merchant: SURGE_MERCHANT,
    displayName: "Surge Sushi",
    description:
      "Sushi bar — busy-hours pricing: quoted totals can carry a surge multiplier, so re-quoting may return a different price.",
    menu: [
      { id: "salmon-nigiri-set", name: "Salmon nigiri set", priceCents: 1400 },
      { id: "tuna-roll", name: "Tuna roll", priceCents: 900 },
      { id: "miso-soup", name: "Miso soup", priceCents: 350 },
    ],
  },
  {
    merchant: ALWAYS_DECLINES_MERCHANT,
    displayName: "Declined Diner",
    description:
      "Diner (sandbox): browsing and quoting work, but every order is declined by the merchant's payment processor.",
    menu: [
      { id: "patty-melt", name: "Patty melt", priceCents: 1050 },
      { id: "house-fries", name: "House fries", priceCents: 450 },
      { id: "root-beer-float", name: "Root beer float", priceCents: 500 },
    ],
  },
];

/**
 * The service's error-code vocabulary, exported so every PRODUCER references
 * one definition (the engine and both packages' suites match on these).
 * Tests deliberately assert the literal strings, not these constants — a test
 * importing the constant would keep passing if the wire vocabulary silently
 * changed, and pinning that vocabulary is the tests' job. The three commit
 * codes are declared here with the merchants that exercise them; the `order`
 * verb that produces them lands together with the spending cap.
 */
export const UNKNOWN_MERCHANT = "unknown_merchant";
export const EMPTY_CART = "empty_cart";
export const UNKNOWN_ITEM = "unknown_item";
export const CART_TOO_LARGE = "cart_too_large";
export const QUOTE_EXPIRED = "quote_expired";
export const QUOTE_INVALID = "quote_invalid";
export const MERCHANT_DECLINED = "merchant_declined";

/** Upper bound on cart size — every real delivery provider bounds carts, so
 * the reference shape does too (and an LLM-authored `items` array is
 * otherwise the one size-unbounded input in this service). */
export const MAX_CART_ITEMS = 50;

/** Upper bound on the quote's human-readable summary, so the id stays small. */
export const SUMMARY_MAX_CHARS = 120;

/**
 * "Golden Wok — Kung pao chicken, Spring rolls (4) ×2" — the line the
 * confirmation prompt shows so the user can see the order, not just its price.
 * Built from the SEEDED menu (never from raw model input), so it is trusted
 * chrome at render, and truncated to keep the quote id bounded.
 */
function cartSummary(merchant: MockMerchant, items: string[]): string {
  const counts = new Map<string, number>();
  for (const id of items) counts.set(id, (counts.get(id) ?? 0) + 1);
  const parts: string[] = [];
  for (const [id, count] of counts) {
    const item = merchant.menu.find((m) => m.id === id);
    if (!item) continue;
    parts.push(count > 1 ? `${item.name} \u00d7${count}` : item.name);
  }
  const full = `${merchant.displayName} — ${parts.join(", ")}`;
  return full.length > SUMMARY_MAX_CHARS
    ? `${full.slice(0, SUMMARY_MAX_CHARS - 1)}\u2026`
    : full;
}

/** Bound LLM-authored strings echoed back in error messages: the engine
 * fences tool results, but an unbounded echo is still context ballast. */
function echo(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

function lookupMerchant(merchant: string): MockMerchant | null {
  return MOCK_MERCHANTS.find((m) => m.merchant === merchant) ?? null;
}

/**
 * The surge multiplier in percent for a given instant — integer math end to
 * end (never REAL). Alternates 100/150 by time bucket, so the
 * price-change failure mode is reachable by waiting out a bucket, with no
 * stored state.
 */
export function surgeMultiplierPercent(nowMs: number): number {
  return Math.floor(nowMs / SURGE_BUCKET_MS) % 2 === 0 ? 100 : 150;
}

/** Module-constant signing key: the mock's threat model is tampering by the
 * model between quote and commit, not a real adversary — the signature makes
 * fabricated or edited quote ids detectable, and nothing more. */
const QUOTE_SIGNING_KEY = "habenula-mock-delivery-quote-v1";

/** Truncated-hex SHA-256 via Web Crypto — async is fine everywhere it is
 * used (quote mint and commit verify); only the payload DECODE must be sync
 * (the pipeline's amount extractor), and decoding needs no crypto. */
async function signPayload(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${payload}.${QUOTE_SIGNING_KEY}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** FNV-1a 64-bit over UTF-8, as hex — a sync, dependency-free digest for the
 * items hash (tamper detection rides the signature, not this). */
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * base64url over the UTF-8 BYTES of the payload, not over its code units:
 * `btoa` throws on any character outside Latin-1, and the payload now carries
 * a human-readable summary (em dash, ×, and any accented merchant name), so a
 * raw `btoa(json)` would reject a perfectly ordinary order.
 */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string | null {
  try {
    const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The self-describing quote payload — everything commit needs, in the id.
 *
 * Quotes are deliberately MULTI-USE while unexpired: the same signed quote
 * may be committed under different idempotency keys, and each commit
 * independently re-enters the cap check and is counted by the ledger — the
 * governance properties hold per-commit, not per-quote. (The `nonce` exists
 * to make every minted id unique, not to enforce single-use.) A real
 * provider enforces single-use server-side — Uber's `fare_id` is consumed by
 * its request — so the port inherits single-use from the provider for free.
 */
export interface QuotePayload {
  merchant: string;
  /**
   * A short human-readable summary of what is being bought, carried so the
   * confirmation surface can show it: a user must never be asked to authorize
   * a charge they cannot inspect. The items hash proves the cart did not
   * change; this names it. Bounded at mint so the id stays small.
   */
  summary: string;
  itemsHash: string;
  totalCents: number;
  /** Epoch ms. */
  expiresAt: number;
  nonce: string;
}

export const QUOTE_ID_PREFIX = "mockq_";

/** Mint a signed quote id: `mockq_<base64url payload>.<sig>`. */
async function encodeQuoteId(payload: QuotePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const sig = await signPayload(json);
  return `${QUOTE_ID_PREFIX}${b64urlEncode(json)}.${sig}`;
}

const B64URL_BODY = /^[A-Za-z0-9_-]+$/;
const SIG_HEX = /^[0-9a-f]{16}$/;

/**
 * Split a quote id into its canonical (body, sig) parts, or null. Canonical
 * form is load-bearing: `atob` skips whitespace and a loose `split(".")`
 * would ignore trailing segments, so without this gate one signed quote has
 * unlimited distinct id STRINGS that all verify — and downstream identity
 * (order-id derivation, the ledger's (idempotency_key, quote_id) uniqueness)
 * keys on the raw string. One signed quote must be exactly one id string.
 */
function splitQuoteId(quoteId: string): { body: string; sig: string } | null {
  if (!quoteId.startsWith(QUOTE_ID_PREFIX)) return null;
  const parts = quoteId.slice(QUOTE_ID_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig || !B64URL_BODY.test(body) || !SIG_HEX.test(sig)) return null;
  return { body, sig };
}

/**
 * Decode a quote id's payload — sync, no crypto, no signature check
 * (the pipeline's amount extractor must be synchronous).
 * Returns null for anything non-canonical or outside the payload shape,
 * including a non-positive or unsafe `totalCents` and a non-positive or
 * unsafe `expiresAt` (JSON `1e999` parses to Infinity, which would otherwise
 * mint an immortal quote) — the extractor never reports an amount the cap
 * arithmetic cannot rank.
 *
 * The self-describing, client-decodable id is a MOCK-ONLY affordance:
 * executors are stateless, so the payload must ride in the id. A real
 * provider's quote id is server-side opaque, so a real service's amount
 * extractor reads a quote record persisted at quote time — this
 * decode-from-the-id shape is the one part of the reference service that
 * does NOT transfer. Likewise the signature: the key is a published module
 * constant, so verification is tamper-evidence for the model-edits-the-id
 * flow, not a security boundary — a real paid service keys its quote
 * integrity from a secret binding or provider-side state, never from source.
 */
export function decodeQuotePayload(quoteId: string): QuotePayload | null {
  const parts = splitQuoteId(quoteId);
  if (parts === null) return null;
  const json = b64urlDecode(parts.body);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.merchant !== "string" ||
    typeof p.summary !== "string" ||
    p.summary.length > SUMMARY_MAX_CHARS ||
    typeof p.itemsHash !== "string" ||
    typeof p.totalCents !== "number" ||
    !Number.isSafeInteger(p.totalCents) ||
    p.totalCents <= 0 ||
    typeof p.expiresAt !== "number" ||
    !Number.isSafeInteger(p.expiresAt) ||
    p.expiresAt <= 0 ||
    typeof p.nonce !== "string"
  ) {
    return null;
  }
  return {
    merchant: p.merchant,
    summary: p.summary,
    itemsHash: p.itemsHash,
    totalCents: p.totalCents,
    expiresAt: p.expiresAt,
    nonce: p.nonce,
  };
}

/** Verify a quote id's signature against its payload — commit's gate. */
export async function verifyQuoteId(quoteId: string): Promise<QuotePayload | null> {
  const parts = splitQuoteId(quoteId);
  if (parts === null) return null;
  const json = b64urlDecode(parts.body);
  if (json === null) return null;
  if ((await signPayload(json)) !== parts.sig) return null;
  return decodeQuotePayload(quoteId);
}

export interface MockQuoteResult {
  quoteId: string;
  totalCents: number;
  /** ISO timestamp the quote dies at. */
  expiresAt: string;
  merchant: string;
}

/**
 * Price a cart against a merchant and mint the bound quote (the
 * quote BINDS the price — committing this id charges exactly this total).
 * `items` are menu item ids; repeat an id to order it twice.
 */
export async function executeMockDeliveryQuote(
  params: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ToolExecutionResult> {
  // Normalized once, the same fold the noun extractor applies — the string
  // the audit log governs is the string acted on.
  const merchantName =
    typeof params.merchant === "string" ? params.merchant.toLowerCase() : "";
  const merchant = lookupMerchant(merchantName);
  if (!merchant) {
    return {
      success: false,
      error: `${UNKNOWN_MERCHANT}: ${merchantName ? echo(merchantName) : "(none)"}`,
    };
  }
  const rawItems = Array.isArray(params.items) ? params.items : [];
  if (rawItems.length === 0) {
    return { success: false, error: `${EMPTY_CART}: items must name at least one menu item id` };
  }
  if (rawItems.length > MAX_CART_ITEMS) {
    return { success: false, error: `${CART_TOO_LARGE}: at most ${MAX_CART_ITEMS} items per order` };
  }
  let totalCents = 0;
  for (const id of rawItems) {
    // A non-string entry fails LOUDLY: silently dropping it would mint a
    // bound quote for a smaller cart than the model believes it ordered.
    if (typeof id !== "string") {
      return { success: false, error: `${UNKNOWN_ITEM}: items must be menu item id strings` };
    }
    const item = merchant.menu.find((m) => m.id === id);
    if (!item) {
      return { success: false, error: `${UNKNOWN_ITEM}: ${echo(id)}` };
    }
    totalCents += item.priceCents;
  }
  const items = rawItems as string[];
  if (merchant.merchant === SURGE_MERCHANT) {
    totalCents = Math.round((totalCents * surgeMultiplierPercent(nowMs)) / 100);
  }
  const payload: QuotePayload = {
    merchant: merchant.merchant,
    summary: cartSummary(merchant, items),
    itemsHash: fnv1a64Hex([...items].sort().join("|")),
    totalCents,
    expiresAt: nowMs + QUOTE_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const result: MockQuoteResult = {
    quoteId: await encodeQuoteId(payload),
    totalCents,
    expiresAt: new Date(payload.expiresAt).toISOString(),
    merchant: merchant.merchant,
  };
  return { success: true, data: result };
}

/**
 * The pipeline's amount extractor (Tool.spend.quotedAmountCents): the bound
 * total claimed by the quote id, or null when the id does not decode — the
 * engine holds an unpriced call rather than guessing. Sync, no crypto: a
 * forged payload can state any amount here and pass the cap check, but the
 * commit's signature verification means it can never move money.
 */
export function decodeQuotedAmountCents(
  params: Record<string, unknown>,
): number | null {
  const quoteId = typeof params.quoteId === "string" ? params.quoteId : "";
  return decodeQuotePayload(quoteId)?.totalCents ?? null;
}

/**
 * The order's human-readable summary, for the confirmation prompt. Sync, like
 * the amount decode, and read from the signed payload the quote committed to —
 * so it describes the cart the commit will charge for, not model prose.
 */
export function describeQuotedOrder(
  params: Record<string, unknown>,
): string | null {
  const quoteId = typeof params.quoteId === "string" ? params.quoteId : "";
  return decodeQuotePayload(quoteId)?.summary ?? null;
}

export const ORDER_ID_PREFIX = "mocko_";

/**
 * Derive the order id from the idempotency key and quote id together, so
 * replay-safety is structural rather than remembered:
 * a retried commit (same key, same quote) RETURNS the same order; the same
 * key under a different quote derives a NEW order — not a replay, and the
 * ledger counts it.
 */
export function deriveOrderId(idempotencyKey: string, quoteId: string): string {
  return `${ORDER_ID_PREFIX}${fnv1a64Hex(`${idempotencyKey}:${quoteId}`)}`;
}

export interface MockOrderResult {
  orderId: string;
  chargedCents: number;
  merchant: string;
}

/**
 * Commit a quote — the money verb's executor. Charges exactly the signed
 * quote's total or fails (the quote BINDS the price):
 *  - `quote_invalid` — the id is malformed, fabricated, or tampered (the
 *    signature does not verify). Nothing commits.
 *  - `quote_expired` — the quote outlived its TTL. The approval it carried is
 *    void; the agent must re-quote and the new price re-enters the cap check
 *    from the top. Never a silent re-price.
 *  - `merchant_declined` — the always-declines merchant's every commit. The
 *    decline that is NOT the cap, so the two controls are distinguishable.
 */
export async function executeMockDeliveryOrder(
  params: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<ToolExecutionResult> {
  const quoteId = typeof params.quoteId === "string" ? params.quoteId : "";
  const idempotencyKey =
    typeof params.idempotencyKey === "string" ? params.idempotencyKey : "";
  if (idempotencyKey === "") {
    return { success: false, error: `${QUOTE_INVALID}: idempotencyKey is required` };
  }
  const payload = await verifyQuoteId(quoteId);
  if (payload === null) {
    return { success: false, error: `${QUOTE_INVALID}: quote id missing, malformed, or tampered` };
  }
  if (nowMs >= payload.expiresAt) {
    return { success: false, error: `${QUOTE_EXPIRED}: re-quote and re-enter the spending check` };
  }
  if (payload.merchant === ALWAYS_DECLINES_MERCHANT) {
    return { success: false, error: `${MERCHANT_DECLINED}: the merchant's payment processor declined the order` };
  }
  const result: MockOrderResult = {
    orderId: deriveOrderId(idempotencyKey, quoteId),
    chargedCents: payload.totalCents,
    merchant: payload.merchant,
  };
  return { success: true, data: result };
}

/**
 * Browse the seeded merchants and menus, optionally narrowed to one merchant.
 * An unknown filter narrows to nothing rather than erroring — the same
 * posture as mock_email's search (data returned never exceeds the noun).
 */
export function executeMockDeliverySearch(
  params: Record<string, unknown>,
): ToolExecutionResult {
  // Same case fold as the noun extractor, so the governed noun and the
  // filtered set always agree.
  const filter = typeof params.merchant === "string" && params.merchant !== ""
    ? params.merchant.toLowerCase()
    : null;
  const merchants = filter
    ? MOCK_MERCHANTS.filter((m) => m.merchant === filter)
    : MOCK_MERCHANTS;
  return { success: true, data: { merchants } };
}
