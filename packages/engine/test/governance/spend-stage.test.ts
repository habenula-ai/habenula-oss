import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { bindDoSql } from "../helpers/do-sql";
import * as spendLedgerData from "../../src/data/helpers/spend-ledger";
import type { EngineSql } from "../../src/data/helpers/types";
import {
  executeMockDeliveryQuote,
  QUOTE_TTL_MS,
  type MockQuoteResult,
} from "@habenula-ai/tools/services/mock/mock-delivery";
import { verifyChainRange } from "@habenula-ai/audit";

/**
 * The spending cap end to end against `mock_delivery` — the
 * acceptance matrix as tests. Every case runs the
 * real pipeline on a real DO: real quote ids, real holds, real ledger rows,
 * real audit entries. No platform mocks; the one forced failure (unreadable
 * ledger) is forced with real storage by dropping the table.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const USER = { userId: "spend-user", agentId: "agent-1" };

const deliveryCiphertext = () =>
  seedCiphertext({ scopes: ["delivery.read", "delivery.order"] });

/** Mint a real bound quote at `nowMs` (defaults to now). */
async function mintQuote(
  merchant: string,
  items: string[],
  nowMs?: number,
): Promise<MockQuoteResult> {
  const result = await executeMockDeliveryQuote(
    { merchant, items },
    nowMs ?? Date.now(),
  );
  if (!result.success) throw new Error(`quote failed: ${result.error}`);
  return result.data as MockQuoteResult;
}

/** Connect mock_delivery with delivery scopes and derive the session. */
async function setup(
  stub: ReturnType<typeof getStub>,
  opts: { grantOrderOn?: string[] } = {},
): Promise<{ sessionId: string }> {
  const ciphertext = await deliveryCiphertext();
  return runInDurableObject(stub, (instance) => {
    instance.connectService("mock_delivery", ciphertext);
    const sessionId = instance.resolveActiveSession(USER);
    for (const noun of opts.grantOrderOn ?? []) {
      instance.createSessionGrant("mock_delivery", "order", noun, sessionId);
    }
    return { sessionId };
  });
}

/** Seed one committed spend directly into the ledger. */
async function seedSpend(
  stub: ReturnType<typeof getStub>,
  sessionId: string,
  amountCents: number,
  key: string,
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const sql = bindDoSql(instance as unknown as { sql: EngineSql });
    spendLedgerData.insertSpendInTxn(sql, {
      id: crypto.randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      service: "mock_delivery",
      verb: "order",
      amountCents,
      quoteId: `seed-${key}`,
      idempotencyKey: key,
      auditEntryId: "seed-audit",
    });
  });
}

async function orderCall(
  stub: ReturnType<typeof getStub>,
  quoteId: string,
  idempotencyKey: string,
) {
  return runInDurableObject(stub, (instance) =>
    instance.executeTool({
      ...USER,
      toolName: "mock_delivery_order",
      toolParams: { quoteId, idempotencyKey },
    }),
  );
}

async function readLedger(stub: ReturnType<typeof getStub>) {
  return runInDurableObject(stub, (instance) => [
    ...instance.sql<{ amount_cents: number; quote_id: string; idempotency_key: string }>`
      SELECT amount_cents, quote_id, idempotency_key FROM spend_ledger
    `,
  ]);
}

describe("spend stage — acceptance matrix", () => {
  it("within both windows: the order dispatches, the ledger counts it, cost_usd carries the quote", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]); // $11.50 < $20

    const result = await orderCall(stub, q.quoteId, "k-1");

    expect(result.governance.decision).toBe("allow");
    expect(result.execution!.success).toBe(true);
    const ledger = await readLedger(stub);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount_cents).toBe(1150);
    expect(ledger[0]!.quote_id).toBe(q.quoteId);

    const rows = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ decision: string; outcome: string; cost_usd: number | null }>`
        SELECT decision, outcome, cost_usd FROM audit_log
        WHERE tool_name = 'mock_delivery_order' ORDER BY sequence_num
      `,
    ]);
    // Decision entry and outcome entry both carry the bound quote's amount.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.cost_usd === 11.5)).toBe(true);
    expect(rows[1]!.outcome).toBe("success");
  });

  it("an order priced over a window is held, never committed", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior"); // $15 spent; session cap $20
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]); // +$11.50 breaches

    const result = await orderCall(stub, q.quoteId, "k-1");

    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(result.held?.heldCallId).toBeTruthy();
    expect(result.governance.spendContext?.reason).toBe("over_limit");
    expect(result.governance.spendContext?.breaches).toEqual([
      { window: "session", limitCents: 2000, spentCents: 1500 },
    ]);
    // Held row carries the context; the seeded row is the only ledger row.
    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ spend_context: string | null }>`
        SELECT spend_context FROM held_tool_calls
      `,
    ]);
    expect(held).toHaveLength(1);
    expect(JSON.parse(held[0]!.spend_context!).reason).toBe("over_limit");
    expect(await readLedger(stub)).toHaveLength(1);
    // The pending decision entry records the amount it held for.
    const pending = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ cost_usd: number | null; parameters_metadata: string }>`
        SELECT cost_usd, parameters_metadata FROM audit_log
        WHERE tool_name = 'mock_delivery_order' AND decision = 'pending'
      `,
    ]);
    expect(pending[0]!.cost_usd).toBe(11.5);
    expect(JSON.parse(pending[0]!.parameters_metadata).spend.reason).toBe("over_limit");
  });

  it("approving a breach commits exactly one order, mints nothing; the next over-cap call asks again", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);

    const heldResult = await orderCall(stub, q.quoteId, "k-1");
    const heldCallId = heldResult.held!.heldCallId;

    const grantsBefore = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`,
    ]);

    const resolution = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "approve_once", userId: USER.userId }),
    );
    expect(resolution.status).toBe("resumed");

    // Exactly one committed order, and no policy entry was minted.
    const ledger = await readLedger(stub);
    expect(ledger.map((r) => r.idempotency_key).sort()).toEqual(["k-1", "prior"]);
    const grantsAfter = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`,
    ]);
    expect(grantsAfter[0]!.n).toBe(grantsBefore[0]!.n);

    // A second over-cap order asks again — approving one overage did not
    // raise the ceiling.
    const q2 = await mintQuote("golden-wok", ["veggie-fried-rice"]);
    const second = await orderCall(stub, q2.quoteId, "k-2");
    expect(second.governance.decision).toBe("pending");
    expect(second.governance.spendContext?.reason).toBe("over_limit");
  });

  it("an expired quote voids the approval — quote_expired, no order, no ledger row", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    // Minted far enough back that it is already past its TTL now: the hold
    // outlived the quote it parked (the 90-minute hold vs the 10-minute fare).
    const q = await mintQuote(
      "golden-wok",
      ["kung-pao-chicken"],
      Date.now() - QUOTE_TTL_MS - 60_000,
    );

    const heldResult = await orderCall(stub, q.quoteId, "k-1");
    expect(heldResult.governance.decision).toBe("pending");

    const resolution = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: heldResult.held!.heldCallId,
        choice: "approve_once",
        userId: USER.userId,
      }),
    );
    expect(resolution.status).toBe("resumed");
    if (resolution.status === "resumed") {
      expect(resolution.result.toolCalls.at(-1)?.outcome).toBe("error");
    }

    // The commit failed with the service's reason; nothing was counted.
    const outcome = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ outcome: string; error_message: string | null; cost_usd: number | null }>`
        SELECT outcome, error_message, cost_usd FROM audit_log
        WHERE tool_name = 'mock_delivery_order' AND decision = 'allow'
      `,
    ]);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]!.outcome).toBe("error");
    expect(outcome[0]!.error_message).toContain("quote_expired");
    // The attempted spend stays on the record (amount, outcome error)…
    expect(outcome[0]!.cost_usd).toBe(11.5);
    // …but the ledger never counted it.
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
  });

  it("an understated forged quote passes the cap check but can never move money", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    // Forge the payload down to 1¢, keeping the stale signature.
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
    const forged = `mockq_${forgedBody}.${sig}`;

    const result = await orderCall(stub, forged, "k-1");

    // The understated claim passes the cap check (allow, priced at 1¢)…
    expect(result.governance.decision).toBe("allow");
    // …but commit rejects the signature: no order, no ledger row.
    expect(result.execution!.success).toBe(false);
    expect(result.execution!.error).toContain("quote_invalid");
    expect(await readLedger(stub)).toHaveLength(0);
  });

  it("unreadable totals hold with totals_unavailable — never allow, never deny", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["spring-rolls"]);
    // Force the failstate with real storage.
    await runInDurableObject(stub, (instance) => {
      instance.sql`DROP TABLE spend_ledger`;
    });

    const result = await orderCall(stub, q.quoteId, "k-1");

    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(result.governance.spendContext?.reason).toBe("totals_unavailable");
  });

  it("an unpriced call (undecodable quote id) holds rather than dispatching", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["invalid-quote"] });

    const result = await orderCall(stub, "mockq_garbage", "k-1");

    expect(result.governance.decision).toBe("pending");
    expect(result.governance.spendContext?.reason).toBe("unpriced");
    expect(result.governance.spendContext?.amountCents).toBeNull();
  });

  it("a lowered cap binds the very next call — limits are never session-cached", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q1 = await mintQuote("golden-wok", ["spring-rolls"]); // $5.50
    const first = await orderCall(stub, q1.quoteId, "k-1");
    expect(first.governance.decision).toBe("allow");

    await runInDurableObject(stub, (instance) => {
      instance.writeSpendLimits({ sessionLimitCents: 600 }); // $6 cap, $5.50 spent
    });

    const q2 = await mintQuote("golden-wok", ["spring-rolls"]);
    const second = await orderCall(stub, q2.quoteId, "k-2");
    expect(second.governance.decision).toBe("pending");
    expect(second.governance.spendContext?.breaches[0]?.limitCents).toBe(600);
  });

  it("a spend hold rejects grant-minting choices engine-side; an ordinary hold rejects approve_once", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    const heldResult = await orderCall(stub, q.quoteId, "k-1");
    const spendHoldId = heldResult.held!.heldCallId;

    const before = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ grants: number; pending: string }>`
        SELECT (SELECT COUNT(*) FROM policy_entries) AS grants,
               (SELECT pending_audit_entry_id FROM held_tool_calls WHERE id = ${spendHoldId}) AS pending
      `,
    ]);

    // The grant-minting answers are refused: a session-scoped answer would
    // silently raise the ceiling, and permission already passed.
    for (const choice of ["task", "session"] as const) {
      const rejected = await runInDurableObject(stub, (instance) =>
        instance.resolveConfirmation({ heldCallId: spendHoldId, choice, userId: USER.userId }),
      );
      expect(rejected.status).toBe("invalid_choice");
    }

    // `tell_more` IS accepted — it mints nothing, mutates nothing, and leaves
    // the call parked, so the money prompt is not the one prompt where the
    // user cannot ask what the tool does.
    const info = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: spendHoldId,
        choice: "tell_more",
        userId: USER.userId,
      }),
    );
    expect(info.status).toBe("info");

    // Nothing dispatched, NOTHING MINTED, and the hold survives untouched —
    // a rejection must not close the hold's audit pair or mint a grant.
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
    const after = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ grants: number; pending: string; ctx: string | null }>`
        SELECT (SELECT COUNT(*) FROM policy_entries) AS grants,
               (SELECT pending_audit_entry_id FROM held_tool_calls WHERE id = ${spendHoldId}) AS pending,
               (SELECT spend_context FROM held_tool_calls WHERE id = ${spendHoldId}) AS ctx
      `,
    ]);
    expect(after[0]!.grants).toBe(before[0]!.grants);
    expect(after[0]!.pending).toBe(before[0]!.pending);
    expect(JSON.parse(after[0]!.ctx!).reason).toBe("over_limit");

    // Symmetric direction: approve_once on an ordinary (permission) hold.
    const ordinaryStub = getStub();
    const emailResult = await runInDurableObject(ordinaryStub, async (instance) => {
      instance.connectService("mock_email");
      return instance.executeTool({
        ...USER,
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
      });
    });
    const rejected = await runInDurableObject(ordinaryStub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: emailResult.held!.heldCallId,
        choice: "approve_once",
        userId: USER.userId,
      }),
    );
    expect(rejected.status).toBe("invalid_choice");
  });

  it("denying a spend hold commits nothing and spends the authorizing task grant", async () => {
    const stub = getStub();
    const ctx = await setup(stub);
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);

    // Un-granted order → permission hold → task answer → chained spend hold.
    const permissionHeld = await orderCall(stub, q.quoteId, "k-1");
    expect(permissionHeld.governance.spendContext).toBeUndefined();
    const heldCallId = permissionHeld.held!.heldCallId;
    const chained = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "task", userId: USER.userId }),
    );
    expect(chained.status).toBe("resumed");
    if (chained.status === "resumed") {
      expect(chained.result.held?.heldCallId).toBe(heldCallId);
    }

    const denial = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "deny", userId: USER.userId }),
    );
    expect(denial.status).toBe("resumed");
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
    // The task grant was already spent at the park, so a deny leaves nothing
    // live either way — the single-use answer cannot outlive its hold.
    const liveGrants = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM policy_entries
        WHERE source = 'task' AND consumed_at IS NULL
      `,
    ]);
    expect(liveGrants[0]!.n).toBe(0);
  });

  it("grant-resume chained hold: task answer re-parks the SAME row as a spend hold; approve_once dispatches exactly once and consumes the grant", async () => {
    const stub = getStub();
    const ctx = await setup(stub);
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);

    const permissionHeld = await orderCall(stub, q.quoteId, "k-1");
    const heldCallId = permissionHeld.held!.heldCallId;
    const firstPendingEntry = permissionHeld.held!.pendingAuditEntryId;

    const chained = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "task", userId: USER.userId }),
    );
    expect(chained.status).toBe("resumed");
    if (chained.status === "resumed") {
      expect(chained.result.held?.heldCallId).toBe(heldCallId);
      expect(chained.result.toolCalls.at(-1)?.outcome).toBe("held");
    }

    // The row re-parked under a NEW pending entry carrying spend context…
    const row = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ pending_audit_entry_id: string; spend_context: string | null }>`
        SELECT pending_audit_entry_id, spend_context FROM held_tool_calls WHERE id = ${heldCallId}
      `,
    ]);
    expect(row[0]!.pending_audit_entry_id).not.toBe(firstPendingEntry);
    expect(JSON.parse(row[0]!.spend_context!).reason).toBe("over_limit");

    // …and the superseded permission-hold entry is CLOSED, not orphaned: every
    // pending entry in the chain gets exactly one terminal.
    const superseded = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM audit_log WHERE decision_entry_id = ${firstPendingEntry}
      `,
    ]);
    expect(superseded[0]!.n).toBe(1);

    // The single-use task grant is spent AT THE PARK, not deferred to the
    // dispatch: left live across the parked window it could authorize a second
    // money-verb call while the user was still deciding — one answer, two
    // dispatches.
    const liveTaskGrants = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM policy_entries
        WHERE source = 'task' AND consumed_at IS NULL
      `,
    ]);
    expect(liveTaskGrants[0]!.n).toBe(0);

    // Approving still dispatches exactly once and counts the spend — the
    // approval rides the hold's own authority, not a policy entry.
    const approved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "approve_once", userId: USER.userId }),
    );
    expect(approved.status).toBe("resumed");
    expect((await readLedger(stub)).map((r) => r.idempotency_key).sort()).toEqual([
      "k-1",
      "prior",
    ]);

    // One grant, one dispatch: re-issuing the call re-enters confirmation.
    const q2 = await mintQuote("golden-wok", ["spring-rolls"]);
    const reissued = await orderCall(stub, q2.quoteId, "k-2");
    expect(reissued.governance.decision).toBe("pending");
    expect(reissued.governance.spendContext).toBeUndefined(); // permission hold, not spend
  });

  it("a within-cap grant resume dispatches without a chained hold", async () => {
    const stub = getStub();
    await setup(stub);
    const q = await mintQuote("golden-wok", ["spring-rolls"]); // $5.50, nothing spent

    const permissionHeld = await orderCall(stub, q.quoteId, "k-1");
    const resolution = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: permissionHeld.held!.heldCallId,
        choice: "session",
        userId: USER.userId,
      }),
    );
    expect(resolution.status).toBe("resumed");
    if (resolution.status === "resumed") {
      expect(resolution.result.held).toBeUndefined();
      expect(resolution.result.toolCalls.at(-1)?.outcome).toBe("success");
    }
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["k-1"]);
  });

  it("a replayed idempotency key neither orders twice nor counts twice; a reused key under a new quote counts", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["spring-rolls"]);

    const first = await orderCall(stub, q.quoteId, "k-1");
    const replay = await orderCall(stub, q.quoteId, "k-1");
    expect(first.execution!.success).toBe(true);
    expect(replay.execution!.success).toBe(true);
    // Same derived order id, one ledger row, unchanged sums.
    expect((replay.execution!.data as { orderId: string }).orderId).toBe(
      (first.execution!.data as { orderId: string }).orderId,
    );
    expect(await readLedger(stub)).toHaveLength(1);

    // Reused key under a DIFFERENT quote: a new spend, counted.
    const q2 = await mintQuote("golden-wok", ["hot-and-sour-soup"]);
    const reused = await orderCall(stub, q2.quoteId, "k-1");
    expect(reused.execution!.success).toBe(true);
    expect(await readLedger(stub)).toHaveLength(2);
  });

  it("a commission-origin breach is never committed — the hold sweeps with the session", async () => {
    const stub = getStub();
    const ctx = await setup(stub);
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);

    // Park, answer permission (task) → chained spend hold; then no human is
    // present. The session expires unanswered and the reaper sweeps.
    const permissionHeld = await orderCall(stub, q.quoteId, "k-1");
    const heldCallId = permissionHeld.held!.heldCallId;
    await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "task", userId: USER.userId }),
    );

    await runInDurableObject(stub, (instance) => {
      const old = new Date(Date.now() - 91 * 60 * 1000).toISOString();
      instance.sql`UPDATE session_state SET started_at = ${old} WHERE session_id = ${ctx.sessionId}`;
      instance.reapExpiredSessions();
    });

    const held = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM held_tool_calls`,
    ]);
    expect(held[0]!.n).toBe(0);
    // Nothing was dispatched and nothing counted beyond the seed.
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
    const allowOutcomes = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM audit_log
        WHERE tool_name = 'mock_delivery_order' AND decision = 'allow'
      `,
    ]);
    expect(allowOutcomes[0]!.n).toBe(0);
  });

  it("both windows read one ledger, and the hash chain verifies over a populated cost_usd", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    await orderCall(stub, q.quoteId, "k-1");

    // An ordinary verb's entries still write null cost.
    await runInDurableObject(stub, async (instance) => {
      const sessionId = instance.resolveActiveSession(USER);
      instance.createSessionGrant("mock_delivery", "search", "all", sessionId);
      return instance.executeTool({
        ...USER,
        toolName: "mock_delivery_search",
        toolParams: {},
      });
    });

    const rows = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ tool_name: string; cost_usd: number | null }>`
        SELECT tool_name, cost_usd FROM audit_log WHERE tool_name LIKE 'mock_delivery%'
      `,
    ]);
    for (const row of rows) {
      if (row.tool_name === "mock_delivery_order") {
        expect(row.cost_usd).toBe(11.5);
      } else {
        expect(row.cost_usd).toBeNull();
      }
    }

    // The chain verifies over the populated column (Hard Invariant 3):
    // read the full chain page and recompute every hash.
    const page = await runInDurableObject(stub, (instance) =>
      instance.listAuditEntries({ limit: 100 }),
    );
    const verdict = verifyChainRange([...page.entries].reverse());
    expect(verdict.entriesChecked).toBeGreaterThan(0);
    expect(verdict.breaks).toHaveLength(0);

    // Both windows sum the same single ledger.
    const sums = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const sessionId = instance.resolveActiveSession(USER);
      return {
        session: spendLedgerData.sumSessionSpendCents(sql, sessionId),
        month: spendLedgerData.sumMonthSpendCents(sql, "2000-01-01T00:00:00.000Z"),
      };
    });
    expect(sums.session).toBe(1150);
    expect(sums.month).toBe(1150);
  });
});

// --- Regressions from the pre-landing review ---------------------------------

describe("spend stage — review regressions", () => {
  it("a ledger fault never rolls back the outcome entry for a dispatch that ran", async () => {
    const stub = getStub();
    await setup(stub, { grantOrderOn: ["golden-wok"] });
    const q = await mintQuote("golden-wok", ["spring-rolls"]);
    // The failstate the design ships `totals_unavailable` for — and the human
    // answer to that hold is approve, which dispatches and then writes.
    await runInDurableObject(stub, (instance) => {
      instance.sql`DROP TABLE spend_ledger`;
    });

    const held = await orderCall(stub, q.quoteId, "k-1");
    expect(held.governance.spendContext?.reason).toBe("totals_unavailable");

    const resolution = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: held.held!.heldCallId,
        choice: "approve_once",
        userId: USER.userId,
      }),
    );
    expect(resolution.status).toBe("resumed");

    // Hard Invariant #3: the dispatch has a terminal outcome entry carrying
    // its amount, so the uncounted spend is recoverable from the audit row.
    const rows = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ outcome: string; cost_usd: number | null; error_message: string | null }>`
        SELECT outcome, cost_usd, error_message FROM audit_log
        WHERE tool_name = 'mock_delivery_order' AND decision = 'allow'
        ORDER BY sequence_num
      `,
    ]);
    const success = rows.filter((r) => r.outcome === "success");
    expect(success).toHaveLength(1);
    expect(success[0]!.cost_usd).toBe(5.5);
    // …and the ledger gap is recorded explicitly, not left as an absence.
    const gap = rows.filter((r) => r.error_message?.includes("spend_ledger write failed"));
    expect(gap).toHaveLength(1);
    expect(gap[0]!.cost_usd).toBe(5.5);
  });

  it("a corrupt spend_context fails closed — it never decays into a grant-mintable hold", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    const heldCallId = (await orderCall(stub, q.quoteId, "k-1")).held!.heldCallId;
    // The setup seeds one session grant, so the property is that the rejected
    // resolves mint no ADDITIONAL grant.
    const grantsBefore = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`,
    ]);

    for (const corrupt of ["{not json", "3", "true", '{"reason":"nope","amountCents":1,"breaches":[]}']) {
      await runInDurableObject(stub, (instance) => {
        instance.sql`UPDATE held_tool_calls SET spend_context = ${corrupt} WHERE id = ${heldCallId}`;
      });
      const rejected = await runInDurableObject(stub, (instance) =>
        instance.resolveConfirmation({ heldCallId, choice: "session", userId: USER.userId }),
      );
      expect(rejected.status).toBe("invalid_choice");
    }
    // No grant was minted and nothing was dispatched.
    const grantsAfter = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM policy_entries`,
    ]);
    expect(grantsAfter[0]!.n).toBe(grantsBefore[0]!.n);
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
    // It still renders AS a spending hold, with the amounts withheld rather
    // than shipped as undefined into the confirmation surface.
    const record = await runInDurableObject(stub, (instance) => instance.readStatus());
    expect(record.held[0]?.spend).toEqual({
      amountCents: null,
      reason: "unpriced",
      breaches: [],
    });
  });

  it("the choice restriction binds on a crash-recovery row too", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    const heldCallId = (await orderCall(stub, q.quoteId, "k-1")).held!.heldCallId;

    // Force the dispatched marker: the recovery branch must not be a way
    // around the hold-kind restriction.
    await runInDurableObject(stub, (instance) => {
      const row = [
        ...instance.sql<{ turn_state: string }>`
          SELECT turn_state FROM held_tool_calls WHERE id = ${heldCallId}
        `,
      ][0]!;
      const parsed = JSON.parse(row.turn_state) as { state: Record<string, unknown> };
      parsed.state.dispatched = true;
      instance.sql`UPDATE held_tool_calls SET turn_state = ${JSON.stringify(parsed)} WHERE id = ${heldCallId}`;
    });

    const refused = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "session", userId: USER.userId }),
    );
    expect(refused.status).toBe("invalid_choice");
  });

  it("both windows can breach at once and both are carried into the hold", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    await runInDurableObject(stub, (instance) => {
      instance.writeSpendLimits({ monthLimitCents: 1600 });
    });
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);

    const result = await orderCall(stub, q.quoteId, "k-1");
    expect(result.governance.spendContext?.breaches).toEqual([
      { window: "session", limitCents: 2000, spentCents: 1500 },
      { window: "month", limitCents: 1600, spentCents: 1500 },
    ]);
  });

  it("the month window excludes a spend from the previous calendar month", async () => {
    const stub = getStub();
    const ctx = await setup(stub);
    // Derived from the engine's own boundary rule, so this is deterministic on
    // any calendar date — including the 1st at 00:00 UTC.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonth = new Date(monthStart.getTime() - 1).toISOString();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      spendLedgerData.insertSpendInTxn(sql, {
        id: crypto.randomUUID(),
        sessionId: ctx.sessionId,
        createdAt: lastMonth,
        service: "mock_delivery",
        verb: "order",
        amountCents: 4900,
        quoteId: "seed-last-month",
        idempotencyKey: "last-month",
        auditEntryId: "seed-audit",
      });
    });

    // $49 last month must not consume this month's $50 ceiling.
    const settings = await runInDurableObject(stub, (instance) =>
      instance.readSpendSettings(),
    );
    expect(settings.monthSpentCents).toBe(0);
  });

  it("the model's status view never carries limits or running totals", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    await orderCall(stub, q.quoteId, "k-1");

    const forModel = await runInDurableObject(stub, (instance) =>
      instance.readStatusForModel(),
    );
    // The reason survives; the ceiling and the headroom do not — an agent that
    // learns them can size every order to stay just under the cap.
    expect(forModel.held[0]?.spend?.reason).toBe("over_limit");
    expect(forModel.held[0]?.spend?.breaches).toEqual([]);
    expect(JSON.stringify(forModel)).not.toContain("limitCents");
    expect(JSON.stringify(forModel)).not.toContain("spentCents");

    // The human-facing read still carries them.
    const forHuman = await runInDurableObject(stub, (instance) => instance.readStatus());
    expect(forHuman.held[0]?.spend?.breaches).toHaveLength(1);
  });

  it("a cap lowered while the order is parked binds the approval", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken"]);
    const heldCallId = (await orderCall(stub, q.quoteId, "k-1")).held!.heldCallId;

    // The user lowers the monthly cap while deciding.
    await runInDurableObject(stub, (instance) => {
      instance.writeSpendLimits({ monthLimitCents: 100 });
    });

    const resolution = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "approve_once", userId: USER.userId }),
    );
    // Re-parked against the new limit rather than dispatched: the shipped
    // promise is that a lowered cap binds the next spend check.
    expect(resolution.status).toBe("resumed");
    if (resolution.status === "resumed") {
      expect(resolution.result.held?.heldCallId).toBe(heldCallId);
    }
    expect((await readLedger(stub)).map((r) => r.idempotency_key)).toEqual(["prior"]);
    const ctxRow = await runInDurableObject(stub, (instance) => [
      ...instance.sql<{ spend_context: string | null }>`
        SELECT spend_context FROM held_tool_calls WHERE id = ${heldCallId}
      `,
    ]);
    expect(
      JSON.parse(ctxRow[0]!.spend_context!).breaches.some(
        (b: { window: string; limitCents: number }) =>
          b.window === "month" && b.limitCents === 100,
      ),
    ).toBe(true);
  });

  it("the confirmation names what is being bought", async () => {
    const stub = getStub();
    const ctx = await setup(stub, { grantOrderOn: ["golden-wok"] });
    await seedSpend(stub, ctx.sessionId, 1500, "prior");
    const q = await mintQuote("golden-wok", ["kung-pao-chicken", "spring-rolls"]);
    await orderCall(stub, q.quoteId, "k-1");

    const record = await runInDurableObject(stub, (instance) => instance.readStatus());
    // Merchant display name and the items, not a slug and an opaque handle.
    expect(record.held[0]?.spend?.summary).toBe(
      "Golden Wok — Kung pao chicken, Spring rolls (4)",
    );
  });
});
