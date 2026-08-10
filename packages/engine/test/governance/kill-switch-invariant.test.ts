import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "@habenula-ai/governance";
import type { PolicyAction } from "@habenula-ai/governance";
import { WILDCARD_DENY_ID } from "@habenula-ai/governance";
import { seedCiphertext } from "../helpers/seed-credential";
import * as pe from "../../src/data/helpers/policy-entries";
import * as htc from "../../src/data/helpers/held-tool-calls";
import { bindDoSql } from "../helpers/do-sql";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Kill-switch invariant + deny-floor assertion.
 *
 * Runs against a real DO under @cloudflare/vitest-pool-workers (Hard
 * Invariant 5 — no mocks of platform primitives).
 */
describe("Kill-switch invariant + deny floor", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  function makeAction(overrides?: Partial<PolicyAction>): PolicyAction {
    return {
      agent: "test-agent",
      service: "mock_email",
      verb: "list",
      noun: "inbox",
      toolName: "mock_email_list",
      params: { label: "INBOX" },
      ...overrides,
    };
  }

  // Scenario 1: kill switch clears everything except the deny floor.
  it("kill switch leaves only the deny floor", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
      instance.createTaskGrant("mock_email", "send", "outbox", "session-1");
    });

    await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
    });

    const remaining = await runInDurableObject(stub, (instance) => {
      return [
        ...instance.sql<{ id: string }>`SELECT id FROM policy_entries`,
      ];
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(WILDCARD_DENY_ID);
  });

  // kill sweeps held calls and writes
  // session.end, but the deny-all sweep no longer touches connections — the
  // connection row and its credential column survive a kill.
  it("kill sweeps held calls and writes session.end but preserves connections + credentials", async () => {
    const stub = getStub();
    const userId = "kill-invariant-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.resolveActiveSession({ userId, agentId: "agent-1" });
      // Park a held call (un-granted connected action → pending/hold).
      await instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: "agent-1",
      });
    });

    // Pre-kill: a held call exists.
    const heldBefore = await runInDurableObject(stub, (instance) =>
      [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
    );
    expect(heldBefore).toBe(1);

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    const after = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      services: [...instance.sql<{ service: string }>`SELECT service FROM connected_services`].length,
      credential: [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'mock_email'
      `][0]?.credential ?? null,
      sessionEnd: [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE tool_name = 'session.end'
      `],
    }));

    expect(after.held).toBe(0); // every held call cleared
    expect(after.services).toBe(1); // connection survives the kill
    expect(after.credential).not.toBeNull(); // credential survives the kill
    expect(after.sessionEnd).toHaveLength(1); // session.end written
    expect(after.sessionEnd[0]!.error_message).toBe("kill"); // reason kill
  });

  // Scenario 1c: kill honors the mid-resolve invariant. A `dispatched`
  // held call is mid-flight — the tool was sent and the resolve path writes its
  // real allow/deny outcome once the dispatch settles — so TX2 must NOT append a
  // deny/timeout outcome over it. Doing so would record a false denial (a
  // second, contradictory terminal outcome) for a call that executed. This pins
  // the `dispatched` arm of turnStateHasResolution — the more important race for
  // an emergency kill, and the window where the resolve path's real outcome has
  // not landed yet (the reaper test pins the `answered` arm). The row is still
  // swept by TX1.
  it("kill skips the timeout outcome for a mid-resolve held call (resolve path owns it)", async () => {
    const stub = getStub();
    const userId = "kill-mid-resolve-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.resolveActiveSession({ userId, agentId: "agent-1" });
      await instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId,
        agentId: "agent-1",
      });
      // Mark the parked call mid-flight: `dispatched: true` is the exact marker
      // resolveConfirmation commits before awaiting the tool dispatch (one held
      // call per DO → no WHERE).
      instance.sql`UPDATE held_tool_calls SET turn_state = ${JSON.stringify({ dispatched: true })}`;
    });

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    const after = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      fabricatedTimeout: [...instance.sql<{ outcome: string }>`
        SELECT outcome FROM audit_log
        WHERE tool_name = 'mock_email_list' AND outcome = 'timeout'
      `].length,
      sessionEnd: [...instance.sql<{ error_message: string | null }>`
        SELECT error_message FROM audit_log WHERE tool_name = 'session.end'
      `],
    }));

    expect(after.held).toBe(0); // row still swept by TX1 — nothing survives
    expect(after.fabricatedTimeout).toBe(0); // no false denial over the executed call
    expect(after.sessionEnd).toHaveLength(1);
    expect(after.sessionEnd[0]!.error_message).toBe("kill");
  });

  // kill ends the ACTIVE session (already true on main —
  // killSwitch marks every un-ended row ended). Pinned here so the
  // single-active derive can rely on kill freeing the slot: after a kill,
  // status reports no session and a fresh launch is not refused.
  it("kill ends the active session — the slot is free for a fresh start", async () => {
    const stub = getStub();
    const userId = "kill-frees-slot-user";
    const killedId = await runInDurableObject(stub, (instance) =>
      instance.resolveActiveSession({ userId, agentId: "agent-1" }),
    );

    await runInDurableObject(stub, (instance) => instance.killSwitch());

    expect(
      await runInDurableObject(stub, (instance) => instance.getActiveSession()),
    ).toBeNull();

    const next = await runInDurableObject(stub, (instance) =>
      instance.startSession({ userId, agentId: "agent-1" }),
    );
    expect(next.status).toBe("started"); // not refused against the killed session
    expect(next.activeSession.sessionId).not.toBe(killedId);
  });

  // Scenario 2: after kill, every action evaluates to deny.
  it("denies all representative actions after kill", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.createSessionGrant("mock_email", "list", "inbox", "session-1");
    });

    await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
    });

    const entries = await runInDurableObject(stub, (instance) => {
      return instance.queryPolicyEntries("session-1");
    });

    const actions: PolicyAction[] = [
      makeAction({ service: "mock_email", verb: "list", noun: "inbox" }),
      makeAction({ service: "calendar", verb: "write", noun: "primary" }),
      makeAction({ service: "*", verb: "*", noun: "*" }),
      makeAction({ service: "unknown", verb: "read", noun: "thing" }),
    ];

    for (const action of actions) {
      expect(evaluatePolicy(entries, action).decision).toBe("deny");
    }
  });

  // Scenario 3: kill switch is idempotent.
  it("is idempotent across repeated calls", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email");
      instance.createTaskGrant("mock_email", "send", "outbox", "session-1");
    });

    const first = await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
      return [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`];
    });

    const second = await runInDurableObject(stub, (instance) => {
      instance.killSwitch();
      return [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`];
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(WILDCARD_DENY_ID);
  });

  // TX1's two
  // delete helpers (policy_entries, held_tool_calls) commit all-or-nothing.
  // Reachable at the data-helper layer (unlike a spy on the protected `ctx`
  // through killSwitch() itself): a throw injected inside the same
  // transactionSync composition killSwitch uses must roll both tables back.
  it("TX1 delete composition rolls both tables back on failure, together on success", async () => {
    const stub = getStub();
    const seed = (sql: EngineSql) => {
      pe.insertSessionGrant(sql, {
        id: "grant-1",
        sessionId: "s-1",
        service: "gmail",
        verb: "read",
        noun: "inbox",
        decision: "allow",
        createdAt: "2026-07-01T10:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      htc.insertHeldToolCall(sql, "h-1", "s-1", "audit-1", "2026-07-01T10:00:00.000Z");
    };

    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      const storage = (
        instance as unknown as { ctx: { storage: DurableObjectStorage } }
      ).ctx.storage;
      seed(sql);

      expect(() =>
        storage.transactionSync(() => {
          pe.deletePolicyEntriesExcept(sql, WILDCARD_DENY_ID);
          htc.deleteAllHeldToolCalls(sql);
          throw new Error("injected failure after both deletes");
        }),
      ).toThrow("injected failure");

      // Neither delete committed: the grant AND the held call both survive.
      expect(
        pe.selectActivePolicyEntries(sql, "s-1").map((r) => r.id),
      ).toContain("grant-1");
      expect(htc.readHeldCall(sql, "h-1")).not.toBeNull();

      // The same composition without a failure clears both tables together.
      storage.transactionSync(() => {
        pe.deletePolicyEntriesExcept(sql, WILDCARD_DENY_ID);
        htc.deleteAllHeldToolCalls(sql);
      });
      expect(
        pe.selectActivePolicyEntries(sql, "s-1").map((r) => r.id),
      ).toEqual([WILDCARD_DENY_ID]);
      expect(htc.selectHeldCalls(sql)).toHaveLength(0);
    });
  });

  // Scenario 5: a freshly created DO passes the deny-floor assertion.
  it("assertDenyFloor passes on a fresh DO", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      // migrate() already ran in the constructor; calling again must not throw.
      expect(() => instance.assertDenyFloor()).not.toThrow();
    });
  });

  // Scenario 6: a tampered floor row makes the assertion throw loudly.
  it("assertDenyFloor throws when the floor row is tampered", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.sql`
        UPDATE policy_entries SET decision = 'allow' WHERE id = ${WILDCARD_DENY_ID}
      `;
      expect(() => instance.assertDenyFloor()).toThrow(/Deny floor corrupted/);
    });
  });

  // Scenario 6b: a missing floor row also throws.
  it("assertDenyFloor throws when the floor row is missing", async () => {
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.sql`DELETE FROM policy_entries WHERE id = ${WILDCARD_DENY_ID}`;
      expect(() => instance.assertDenyFloor()).toThrow(/is missing/);
    });
  });
});
