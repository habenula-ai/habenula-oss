import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  computeEntryHash,
  frameField,
  GENESIS_SENTINEL,
} from "@habenula-ai/audit";

function baseParams() {
  return {
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    toolName: "email_list_messages",
    service: "email",
    verb: "list",
    noun: "inbox",
    decision: "allow" as const,
    parametersMetadata: { label: { type: "string", length: 5 } },
    outcome: "success" as const,
    latencyMs: 42,
  };
}

describe("writeAuditEntry", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("writes a genesis entry with correct fields", async () => {
    const stub = getStub();

    const result = await runInDurableObject(stub, (instance) => {
      return instance.writeAuditEntry({
        ...baseParams(),
        epochId: "2026-04-07",
        timestamp: "2026-04-07T12:00:00Z",
      });
    });

    expect(result.sequenceNum).toBe(0);
    expect(result.epochId).toBe("2026-04-07");
    expect(result.id).toBeTruthy();
    expect(result.hash).toBeTruthy();

    // Verify stored in DB
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        prev_hash: string;
        epoch_prev_hash: string | null;
      }>`SELECT prev_hash, epoch_prev_hash FROM audit_log WHERE id = ${result.id}`;
    });

    expect(rows[0]!.prev_hash).toBe(GENESIS_SENTINEL);
    expect(rows[0]!.epoch_prev_hash).toBeNull();
  });

  it("chains 10 entries within an epoch with verifiable hashes", async () => {
    const stub = getStub();

    const results = await runInDurableObject(stub, (instance) => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push(
          instance.writeAuditEntry({
            ...baseParams(),
            epochId: "2026-04-07",
            timestamp: `2026-04-07T12:00:0${i}Z`,
          })
        );
      }
      return entries;
    });

    expect(results).toHaveLength(10);

    // Verify sequence numbers increment
    for (let i = 0; i < 10; i++) {
      expect(results[i]!.sequenceNum).toBe(i);
    }

    // Read all entries back and verify hash chain
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        id: string;
        epoch_id: string;
        sequence_num: number;
        prev_hash: string;
        hash: string;
        timestamp: string;
        user_id: string;
        agent_id: string;
        session_id: string;
        service: string;
        verb: string;
        noun: string;
        tool_name: string;
        parameters_metadata: string;
        decision: string;
        outcome: string;
        error_message: string | null;
        decision_entry_id: string | null;
        latency_ms: number;
        cost_usd: number | null;
        origin: string;
      }>`SELECT * FROM audit_log ORDER BY sequence_num ASC`;
    });

    expect(rows).toHaveLength(10);

    // Verify first entry is genesis
    expect(rows[0]!.prev_hash).toBe(GENESIS_SENTINEL);

    // Verify each entry's hash matches recomputed hash
    for (let i = 0; i < 10; i++) {
      const row = rows[i]!;
      const expectedHash = computeEntryHash({
        epochId: row.epoch_id,
        sequenceNum: row.sequence_num,
        prevHash: row.prev_hash,
        id: row.id,
        timestamp: row.timestamp,
        userId: row.user_id,
        agentId: row.agent_id,
        sessionId: row.session_id,
        origin: row.origin,
        service: row.service,
        verb: row.verb,
        noun: row.noun,
        toolName: row.tool_name,
        parametersMetadata: row.parameters_metadata,
        decision: row.decision,
        outcome: row.outcome,
        errorMessage: row.error_message,
        decisionEntryId: row.decision_entry_id,
        latencyMs: row.latency_ms,
        costUsd: row.cost_usd,
      });
      expect(row.hash).toBe(expectedHash);

      // Verify chain linkage (entry N's prev_hash = entry N-1's hash)
      if (i > 0) {
        expect(row.prev_hash).toBe(rows[i - 1]!.hash);
      }
    }
  });

  it("detects tampering — chain breaks from tampered entry forward", async () => {
    const stub = getStub();

    // Write 5 entries
    await runInDurableObject(stub, (instance) => {
      for (let i = 0; i < 5; i++) {
        instance.writeAuditEntry({
          ...baseParams(),
          epochId: "2026-04-07",
          timestamp: `2026-04-07T12:00:0${i}Z`,
        });
      }
    });

    // Tamper with entry at sequence_num = 2
    await runInDurableObject(stub, (instance) => {
      instance.sql`UPDATE audit_log SET hash = 'tampered' WHERE sequence_num = 2`;
    });

    // Verify chain: entries 0-1 valid, entry 2 hash wrong, entries 3-4 prev_hash wrong
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        id: string;
        epoch_id: string;
        sequence_num: number;
        prev_hash: string;
        hash: string;
        timestamp: string;
        user_id: string;
        agent_id: string;
        session_id: string;
        service: string;
        verb: string;
        noun: string;
        tool_name: string;
        parameters_metadata: string;
        decision: string;
        outcome: string;
        error_message: string | null;
        decision_entry_id: string | null;
        latency_ms: number;
        cost_usd: number | null;
        origin: string;
      }>`SELECT * FROM audit_log ORDER BY sequence_num ASC`;
    });

    // Entry 2's stored hash was tampered — doesn't match recomputed
    const entry2 = rows[2]!;
    expect(entry2.hash).toBe("tampered");

    const recomputedHash = computeEntryHash({
      epochId: entry2.epoch_id,
      sequenceNum: entry2.sequence_num,
      prevHash: entry2.prev_hash,
      id: entry2.id,
      timestamp: entry2.timestamp,
      userId: entry2.user_id,
      agentId: entry2.agent_id,
      sessionId: entry2.session_id,
      origin: entry2.origin,
      service: entry2.service,
      verb: entry2.verb,
      noun: entry2.noun,
      toolName: entry2.tool_name,
      parametersMetadata: entry2.parameters_metadata,
      decision: entry2.decision,
      outcome: entry2.outcome,
      errorMessage: entry2.error_message,
      decisionEntryId: entry2.decision_entry_id,
      latencyMs: entry2.latency_ms,
      costUsd: entry2.cost_usd,
    });
    expect(entry2.hash).not.toBe(recomputedHash);

    // Entry 3's prev_hash was written BEFORE tampering, so it holds the
    // original correct hash of entry 2. After tampering, entry 2's stored
    // hash ("tampered") no longer matches entry 3's prev_hash — chain broken.
    expect(rows[3]!.prev_hash).not.toBe(entry2.hash);
  });

  it("links epochs — new epoch genesis references previous epoch final hash", async () => {
    const stub = getStub();

    // Write 3 entries in epoch 1
    const epoch1Results = await runInDurableObject(stub, (instance) => {
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(
          instance.writeAuditEntry({
            ...baseParams(),
            epochId: "2026-04-07",
            timestamp: `2026-04-07T12:00:0${i}Z`,
          })
        );
      }
      return results;
    });

    const epoch1FinalHash = epoch1Results[2]!.hash;

    // Write first entry in epoch 2
    const epoch2First = await runInDurableObject(stub, (instance) => {
      return instance.writeAuditEntry({
        ...baseParams(),
        epochId: "2026-04-08",
        timestamp: "2026-04-08T12:00:00Z",
      });
    });

    expect(epoch2First.sequenceNum).toBe(0);
    expect(epoch2First.epochId).toBe("2026-04-08");

    // Verify epoch_prev_hash links back to epoch 1's final entry
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ epoch_prev_hash: string | null; prev_hash: string }>`
        SELECT epoch_prev_hash, prev_hash FROM audit_log
        WHERE epoch_id = '2026-04-08' AND sequence_num = 0
      `;
    });

    expect(rows[0]!.epoch_prev_hash).toBe(epoch1FinalHash);
    expect(rows[0]!.prev_hash).toBe(GENESIS_SENTINEL);
  });

  it("produces deterministic hashes for same inputs", () => {
    const fields = {
      epochId: "2026-04-07",
      sequenceNum: 0,
      prevHash: GENESIS_SENTINEL,
      id: "test-id-123",
      timestamp: "2026-04-07T12:00:00Z",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
      origin: "human",
      service: "email",
      verb: "list",
      noun: "inbox",
      toolName: "email_list_messages",
      parametersMetadata: '{"label":{"type":"string","length":5}}',
      decision: "allow",
      outcome: "success",
      errorMessage: null,
      decisionEntryId: null,
      latencyMs: 42,
      costUsd: null,
    };

    const hash1 = computeEntryHash(fields);
    const hash2 = computeEntryHash(fields);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

 it("length-prefixes fields so a '|' cannot shift a field boundary", () => {
    const base = {
      epochId: "2026-04-07",
      sequenceNum: 0,
      prevHash: GENESIS_SENTINEL,
      id: "test-id-123",
      timestamp: "2026-04-07T12:00:00Z",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
      origin: "human",
      service: "email",
      verb: "list",
      toolName: "email_list_messages",
      parametersMetadata: '{"label":{"type":"string","length":5}}',
      decision: "allow",
      outcome: "success",
      errorMessage: null,
      decisionEntryId: null,
      latencyMs: 42,
      costUsd: null,
    };

    // Two entries that differ only in where a '|' sits across the
    // noun -> toolName boundary. `noun` is LLM-controlled, so this is a value
    // an agent (or a prompt-injected one) can produce.
    const a = computeEntryHash({ ...base, noun: "a|b", toolName: "c" });
    const b = computeEntryHash({ ...base, noun: "a", toolName: "b|c" });

    // Premise: under the old `fields.join("|")` encoding these two distinct
    // tuples produced a byte-identical hash input, so their hashes collided.
    // `noun` and `toolName` are adjacent in the hash tuple and every other field
    // is identical across the two entries, so joining just those two faithfully
    // models the full-tuple collision the old encoding produced.
    const pipeJoin = (noun: string, toolName: string) =>
      [noun, toolName].join("|");
    expect(pipeJoin("a|b", "c")).toBe(pipeJoin("a", "b|c"));

    // Length-prefixed framing keeps them distinct.
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toMatch(/^[a-f0-9]{64}$/);
  });

 it("framing stays injective when a value contains digits and a ':'", () => {
    const base = {
      epochId: "2026-04-07",
      sequenceNum: 0,
      prevHash: GENESIS_SENTINEL,
      id: "test-id-123",
      timestamp: "2026-04-07T12:00:00Z",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
      origin: "human",
      service: "email",
      verb: "list",
      parametersMetadata: '{"label":{"type":"string","length":5}}',
      decision: "allow",
      outcome: "success",
      errorMessage: null,
      decisionEntryId: null,
      latencyMs: 42,
      costUsd: null,
    };

    // The framing delimiter is ':' and the length is decimal digits, so a value
    // that itself contains a digit followed by ':' mimics a "<len>:" header —
    // the new format's own adversarial surface. These two tuples put the same
    // raw characters "2:hix" on either side of the noun -> toolName boundary,
    // split at different points.
    const a = computeEntryHash({ ...base, noun: "2:hi", toolName: "x" });
    const b = computeEntryHash({ ...base, noun: "2", toolName: ":hix" });

    // A delimiter-free concatenation would collide on these — both sides join
    // to "2:hix" across the boundary. It is the length prefix, not any choice
    // of separator, that keeps them distinct.
    const bareJoin = (noun: string, toolName: string) => noun + toolName;
    expect(bareJoin("2:hi", "x")).toBe(bareJoin("2", ":hix"));

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toMatch(/^[a-f0-9]{64}$/);
  });

  // A fully-specified entry reused by the golden vectors and the adjacent-pair
  // sweep below. Changing any value here changes the golden hashes.
  const goldenEntry = {
    epochId: "2026-04-07",
    sequenceNum: 0,
    prevHash: GENESIS_SENTINEL,
    id: "test-id-123",
    timestamp: "2026-04-07T12:00:00Z",
    userId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    origin: "human",
    service: "email",
    verb: "list",
    noun: "inbox",
    toolName: "email_list_messages",
    parametersMetadata: '{"label":{"type":"string","length":5}}',
    decision: "allow",
    outcome: "success",
    errorMessage: null,
    decisionEntryId: null,
    latencyMs: 42,
    costUsd: null,
  };

 it("pins the hash format with a golden vector", () => {
    // The known digest for a fixed entry. If the framing, field order, or the
    // empty-field coalescing (`?? ""`) ever drifts within an epoch, this fails —
    // the epoch's existing hashes would silently stop being reproducible.
    expect(computeEntryHash(goldenEntry)).toBe(
      "03bce569eab8560a0a5ed4a2b42536708616adfd4585399bbd4d947c027d0e28",
    );
  });

 it("frames field length in UTF-8 bytes, matching the hashed encoding", () => {
    // "é😀" is 6 UTF-8 bytes but 3 UTF-16 code units and 2 code points. The
    // frame length must count the bytes SHA-256 actually consumes so a verifier
    // in any language reproduces the chain by measuring bytes — no JS-specific
    // String.length quirk to replicate.
    expect(frameField("é😀")).toBe("6:é😀");
    expect(frameField("")).toBe("0:");
    expect(frameField(42)).toBe("2:42");

    // Locked end to end: an entry with a multi-byte noun hashes to a value that
    // only reproduces under byte-length framing. Counting UTF-16 units or code
    // points would frame "é😀" as "3:…" / "2:…" and change this digest.
    expect(computeEntryHash({ ...goldenEntry, noun: "é😀" })).toBe(
      "2362f867af5ce489aac90f8342df9ab1f03b3250422c03457f22ea0b6884ffc0",
    );
  });

  // Every adjacent pair of freely-settable string fields in the hash tuple.
  // Under the old `join("|")` a '|' could slide across any of these boundaries
  // and collide; length-prefixing must keep each pair distinct. The two
  // hand-written tests above cover noun -> toolName; this generalises the
  // property to the whole tuple.
  const adjacentStringPairs: ReadonlyArray<readonly [string, string]> = [
    ["prevHash", "id"],
    ["id", "timestamp"],
    ["timestamp", "userId"],
    ["userId", "agentId"],
    ["agentId", "sessionId"],
    ["sessionId", "origin"],
    ["origin", "service"],
    ["service", "verb"],
    ["verb", "noun"],
    ["noun", "toolName"],
    ["toolName", "parametersMetadata"],
    ["parametersMetadata", "decision"],
    ["decision", "outcome"],
    ["outcome", "errorMessage"],
    ["errorMessage", "decisionEntryId"],
  ];

  it.each(adjacentStringPairs)(
    "keeps the %s -> %s boundary unambiguous when a '|' straddles it",
    (left, right) => {
      const mk = (overrides: Record<string, string>) =>
        computeEntryHash({
          ...goldenEntry,
          ...overrides,
        } as Parameters<typeof computeEntryHash>[0]);

      // Bare concat collides: "x|" + "y" === "x" + "|y". Framing must not.
      const a = mk({ [left]: "x|", [right]: "y" });
      const b = mk({ [left]: "x", [right]: "|y" });

      expect(a).not.toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
      expect(b).toMatch(/^[a-f0-9]{64}$/);
    },
  );

 it("folds error_message, session_id, and user_id into the hash", () => {
    const base = {
      epochId: "2026-04-07",
      sequenceNum: 0,
      prevHash: GENESIS_SENTINEL,
      id: "test-id-123",
      timestamp: "2026-04-07T12:00:00Z",
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "session-1",
      origin: "human",
      service: "email",
      verb: "send",
      noun: "inbox",
      toolName: "email_send",
      parametersMetadata: "{}",
      decision: "deny",
      outcome: "error",
      errorMessage: "Denied by user",
      decisionEntryId: null,
      latencyMs: 42,
      costUsd: null,
    };
    const baseline = computeEntryHash(base);

    // Each field is load-bearing and was previously outside the hash: an editor
    // with row-level write access could rewrite any of them undetected. Flipping
    // each must now change the hash.
    expect(computeEntryHash({ ...base, errorMessage: "Approved by user" })).not.toBe(baseline);
    expect(computeEntryHash({ ...base, sessionId: "session-2" })).not.toBe(baseline);
    expect(computeEntryHash({ ...base, userId: "user-2" })).not.toBe(baseline);

    // Documented, harmless collapse: a null and an empty error_message frame
    // identically (`0:`) — both denote "no message" and neither is a meaningful
    // value an incident review would rely on.
    expect(computeEntryHash({ ...base, errorMessage: null })).toBe(
      computeEntryHash({ ...base, errorMessage: "" }),
    );
  });

 it("keeps a session.end reason (stored only in error_message) tamper-evident", async () => {
    const stub = getStub();

    // Mirrors writeSessionEnd: decision='deny'/outcome='timeout' are fixed
    // placeholders for every end path; the real reason lives only in
    // error_message. Previously it was outside the hash, so 'kill' could be
    // rewritten to 'quit' — erasing that a kill switch fired — undetected.
    const written = await runInDurableObject(stub, (instance) => {
      return instance.writeAuditEntry({
        ...baseParams(),
        toolName: "session.end",
        service: "session",
        verb: "end",
        noun: "-",
        decision: "deny",
        outcome: "timeout",
        errorMessage: "kill",
        epochId: "2026-04-07",
        timestamp: "2026-04-07T12:00:00Z",
      });
    });

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        epoch_id: string;
        sequence_num: number;
        prev_hash: string;
        id: string;
        timestamp: string;
        user_id: string;
        agent_id: string;
        session_id: string;
        origin: string;
        service: string;
        verb: string;
        noun: string;
        tool_name: string;
        parameters_metadata: string;
        decision: string;
        outcome: string;
        error_message: string | null;
        decision_entry_id: string | null;
        latency_ms: number;
        cost_usd: number | null;
        hash: string;
      }>`SELECT * FROM audit_log WHERE id = ${written.id}`;
    });
    const row = rows[0]!;

    const recompute = (errorMessage: string | null) =>
      computeEntryHash({
        epochId: row.epoch_id,
        sequenceNum: row.sequence_num,
        prevHash: row.prev_hash,
        id: row.id,
        timestamp: row.timestamp,
        userId: row.user_id,
        agentId: row.agent_id,
        sessionId: row.session_id,
        origin: row.origin,
        service: row.service,
        verb: row.verb,
        noun: row.noun,
        toolName: row.tool_name,
        parametersMetadata: row.parameters_metadata,
        decision: row.decision,
        outcome: row.outcome,
        errorMessage,
        decisionEntryId: row.decision_entry_id,
        latencyMs: row.latency_ms,
        costUsd: row.cost_usd,
      });

    // Honest recompute matches the stored hash; rewriting the end reason to
    // 'quit' (same outcome placeholder) no longer does — the tamper is caught.
    expect(recompute("kill")).toBe(row.hash);
    expect(recompute("quit")).not.toBe(row.hash);
  });
});
