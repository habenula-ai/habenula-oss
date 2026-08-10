import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/**
 * Storage shape for held calls and sessions — schema only, no behavior.
 *
 * These assert that `held_tool_calls`, `session_state` and
 * `policy_entries.consumed_at` exist with their final shape, and that the
 * audit `decision`/`outcome` CHECK enums admit `pending` and `timeout` while
 * rejecting out-of-domain writes. Hold and resolve *behavior* is covered by
 * the suites that exercise it; this file pins the columns and constraints
 * those suites depend on.
 */
describe("additive schema", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("creates held_tool_calls and session_state tables on construction", async () => {
    const stub = getStub();

    const tables = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('held_tool_calls', 'session_state')
        ORDER BY name
      `;
    });

    const names = tables.map((t) => t.name);
    expect(names).toContain("held_tool_calls");
    expect(names).toContain("session_state");
  });

  it("held_tool_calls has the in-flight turn-state columns, all NOT NULL", async () => {
    const stub = getStub();

    const cols = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string; notnull: number }>`
        SELECT name, "notnull" FROM pragma_table_info('held_tool_calls') ORDER BY name
      `;
    });

    const byName = new Map(cols.map((c) => [c.name, c]));
    // The resume path is load-bearing: every column the held record needs to
    // reconstruct a turn must be present and non-nullable.
    for (const required of [
      "id",
      "session_id",
      "pending_audit_entry_id",
      "turn_state",
      "held_at",
    ]) {
      expect(byName.has(required)).toBe(true);
      expect(byName.get(required)!.notnull).toBe(1);
    }
  });

  it("session_state anchors started_at and owning agent, all NOT NULL", async () => {
    const stub = getStub();

    const cols = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string; notnull: number }>`
        SELECT name, "notnull" FROM pragma_table_info('session_state') ORDER BY name
      `;
    });

    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const required of ["session_id", "started_at", "agent_id"]) {
      expect(byName.has(required)).toBe(true);
      expect(byName.get(required)!.notnull).toBe(1);
    }
  });

  it("policy_entries gains a nullable consumed_at column", async () => {
    const stub = getStub();

    const col = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ name: string; notnull: number }>`
        SELECT name, "notnull" FROM pragma_table_info('policy_entries')
        WHERE name = 'consumed_at'
      `;
    });

    expect(col).toHaveLength(1);
    // Nullable: a row created before it is ever consumed has consumed_at = NULL.
    expect(col[0]!.notnull).toBe(0);
  });

  it("admits decision = 'pending' in the audit log", async () => {
    const stub = getStub();

    const rows = await runInDurableObject(stub, (instance) => {
      instance.sql`
        INSERT INTO audit_log (
          id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
          timestamp, user_id, agent_id, session_id,
          tool_name, service, verb, noun,
          decision, parameters_metadata, parameters_content,
          outcome, error_message, latency_ms, cost_usd
        ) VALUES (
          'pending-001', '2026-06-24', 0, 'GENESIS', 'h0', NULL,
          '2026-06-24T12:00:00Z', 'user-1', 'agent-1', 'session-1',
          'email_send_message', 'email', 'send', 'message',
          'pending', '{}', NULL,
          'success', NULL, 0, NULL
        )
      `;
      return instance.sql<{ decision: string }>`
        SELECT decision FROM audit_log WHERE id = 'pending-001'
      `;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe("pending");
  });

  it("admits outcome = 'timeout' in the audit log", async () => {
    // `timeout` is reserved for the session.end / held-timeout path.
    // A typo in the enum (e.g. 'timeotu') would still pass the rejection tests
    // below but silently break that path — so positively assert it is accepted.
    const stub = getStub();

    const rows = await runInDurableObject(stub, (instance) => {
      instance.sql`
        INSERT INTO audit_log (
          id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
          timestamp, user_id, agent_id, session_id,
          tool_name, service, verb, noun,
          decision, parameters_metadata, parameters_content,
          outcome, error_message, latency_ms, cost_usd
        ) VALUES (
          'timeout-001', '2026-06-24', 0, 'GENESIS', 'h0', NULL,
          '2026-06-24T12:00:00Z', 'user-1', 'agent-1', 'session-1',
          'session.end', 'session', 'end', '-',
          'deny', '{}', NULL,
          'timeout', NULL, 0, NULL
        )
      `;
      return instance.sql<{ outcome: string }>`
        SELECT outcome FROM audit_log WHERE id = 'timeout-001'
      `;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("timeout");
  });

  it("rejects an out-of-domain audit decision via the CHECK constraint", async () => {
    const stub = getStub();

    await expect(
      runInDurableObject(stub, (instance) => {
        instance.sql`
          INSERT INTO audit_log (
            id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
            timestamp, user_id, agent_id, session_id,
            tool_name, service, verb, noun,
            decision, parameters_metadata, parameters_content,
            outcome, error_message, latency_ms, cost_usd
          ) VALUES (
            'bad-decision', '2026-06-24', 0, 'GENESIS', 'h0', NULL,
            '2026-06-24T12:00:00Z', 'user-1', 'agent-1', 'session-1',
            'email_send_message', 'email', 'send', 'message',
            'maybe', '{}', NULL,
            'success', NULL, 0, NULL
          )
        `;
      }),
      // Assert it is the CHECK constraint that fires, not some incidental error
      // (PK collision, hash-chain, etc.) — these inserts are otherwise valid.
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("rejects an out-of-domain audit outcome via the CHECK constraint", async () => {
    const stub = getStub();

    await expect(
      runInDurableObject(stub, (instance) => {
        instance.sql`
          INSERT INTO audit_log (
            id, epoch_id, sequence_num, prev_hash, hash, epoch_prev_hash,
            timestamp, user_id, agent_id, session_id,
            tool_name, service, verb, noun,
            decision, parameters_metadata, parameters_content,
            outcome, error_message, latency_ms, cost_usd
          ) VALUES (
            'bad-outcome', '2026-06-24', 0, 'GENESIS', 'h0', NULL,
            '2026-06-24T12:00:00Z', 'user-1', 'agent-1', 'session-1',
            'email_send_message', 'email', 'send', 'message',
            'allow', '{}', NULL,
            'exploded', NULL, 0, NULL
          )
        `;
      }),
    ).rejects.toThrow(/CHECK|constraint/i);
  });
});
