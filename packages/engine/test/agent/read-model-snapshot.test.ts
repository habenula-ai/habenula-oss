import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { GovernanceSnapshotResponse } from "@habenula-ai/contracts";
import { bindDoSql } from "../helpers/do-sql";
import { seedCiphertext, makeStoredCredential } from "../helpers/seed-credential";
import { insertSessionState } from "../../src/data/helpers/session-state";
import { insertHeldToolCall } from "../../src/data/helpers/held-tool-calls";
import { insertCommissionRun } from "../../src/data/helpers/commission-runs";
import { insertOAuthState } from "../../src/data/helpers/oauth-state";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * `readModelSnapshot` / `GET /api/dev/model` DO method: the
 * atomic visual-model snapshot. Real DO, nothing mocked (Hard Invariant #5);
 * the LLM is an injected script.
 *
 * The load-bearing cases are the sanitization negatives: the serialized
 * snapshot must never contain credential material or `oauth_state` secrets —
 * those tables surface as counts only, and `connected_services` surfaces
 * presence, not ciphertext.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

function toolUse(id: string, label = "INBOX"): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label } };
}

function scriptedLLM(
  script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>,
): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools && step.tools.length > 0) {
        return {
          id: `msg_${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${i}`,
        content: [{ type: "text", text: step.text ?? "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

describe("readModelSnapshot — the visual-model snapshot read", () => {
  it("fresh DO: no session/held, the standing deny floor is visible, counts are zeroed", async () => {
    const stub = getStub();
    const snap = await runInDurableObject(stub, (instance) =>
      instance.readModelSnapshot("snap-user"),
    );
    // Strict contract parse — catches drift in both directions.
    GovernanceSnapshotResponse.parse(snap);
    expect(snap.userId).toBe("snap-user");
    expect(snap.session).toBeNull();
    expect(snap.held).toEqual([]);
    expect(snap.commissions).toEqual({ recent: [], total: 0 });
    expect(snap.connectedServices).toEqual([]);
    expect(snap.audit).toEqual({ recent: [], total: 0 });
    // The default-deny floor is part of the active policy surface here —
    // deliberately unlike GrantView, which filters it out.
    const floor = snap.policyEntries.find((pe) => pe.source === "standing");
    expect(floor).toMatchObject({ decision: "deny", sessionId: null });
    expect(snap.tableCounts.policyEntries).toBe(snap.policyEntries.length);
    expect(snap.tableCounts.sessionState).toBe(0);
    expect(snap.tableCounts.oauthState).toBe(0);
  });

  it("a held chat turn snapshots session + held (with joins) + audit, one consistent instant", async () => {
    const userId = "snap-held-user";
    const stub = getStub();
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
      return instance.chat({ message: "list inbox", userId });
    });

    const snap = await runInDurableObject(stub, (instance) =>
      instance.readModelSnapshot(userId),
    );
    GovernanceSnapshotResponse.parse(snap);
    expect(snap.session).not.toBeNull();
    expect(snap.held).toHaveLength(1);
    // The row joins the base record lacks: parked under the active session,
    // CLI-direct → runId null.
    expect(snap.held[0]!.sessionId).toBe(snap.session!.sessionId);
    expect(snap.held[0]!.runId).toBeNull();
    expect(snap.held[0]!.heldAt).toBeTruthy();
    expect(snap.held[0]).toMatchObject({
      service: "mock_email",
      verb: "list",
      noun: "INBOX",
    });
    // Audit: newest first, ordered by the chain's own total order, and the
    // pending decision entry for the hold is at the top.
    expect(snap.audit.total).toBeGreaterThan(0);
    expect(snap.audit.recent[0]!.decision).toBe("pending");
    const seqs = snap.audit.recent.map((a) => a.sequenceNum);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(snap.audit.total).toBe(snap.tableCounts.auditLog);
    expect(snap.connectedServices).toEqual([
      {
        service: "mock_email",
        connectedAt: expect.any(String) as unknown as string,
        hasCredential: false,
      },
    ]);
    expect(snap.tableCounts.heldToolCalls).toBe(1);
  });

  it("a commissioned hold joins to its run: held.runId ↔ commissions.recent", async () => {
    const stub = getStub();
    const now = new Date().toISOString();
    const snap = await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance);
      insertSessionState(sql, "sess-comm", now, "default");
      insertCommissionRun(sql, {
        id: "run-1",
        goal: "list my recent emails",
        data: null,
        sessionId: "sess-comm",
        createdAt: now,
      });
      insertHeldToolCall(sql, "held-comm", "sess-comm", "audit-c", now, "run-1");
      instance.storeHeldTurnState(
        "held-comm",
        JSON.stringify({
          heldCall: {
            type: "tool_use",
            id: "toolu_c",
            name: "mock_email_list",
            input: { label: "INBOX" },
          },
        }),
      );
      return instance.readModelSnapshot("snap-comm-user");
    });
    GovernanceSnapshotResponse.parse(snap);
    expect(snap.held[0]?.runId).toBe("run-1");
    expect(snap.held[0]?.origin).toBe("mcp_commission");
    expect(snap.held[0]?.goal).toBe("list my recent emails");
    expect(snap.commissions.total).toBe(1);
    expect(snap.commissions.recent[0]).toMatchObject({
      id: "run-1",
      origin: "mcp_commission",
      status: "running",
      sessionId: "sess-comm",
    });
  });

  it("NEGATIVE: the serialized snapshot carries no credential material or oauth_state secrets", async () => {
    const stub = getStub();
    const token = "ya29.SNAPSHOT-LEAK-CANARY";
    const ciphertext = await seedCiphertext(
      makeStoredCredential({ access_token: token }),
    );
    const verifier = "leak-canary-code-verifier";
    const snap = await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sql = bindDoSql(instance);
      insertOAuthState(sql, "state-key-1", {
        code_verifier: verifier,
        code_challenge: "leak-canary-challenge",
        service: "gmail",
        auth_code: "leak-canary-auth-code",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        status: null,
      });
      return instance.readModelSnapshot("snap-leak-user");
    });
    GovernanceSnapshotResponse.parse(snap);
    const wire = JSON.stringify(snap);
    // Neither the ciphertext blob nor any plaintext secret inside it.
    expect(wire).not.toContain(ciphertext.slice(0, 24));
    expect(wire).not.toContain(token);
    expect(wire).not.toContain(verifier);
    expect(wire).not.toContain("leak-canary-auth-code");
    // What DOES surface: presence and counts.
    expect(snap.connectedServices[0]).toEqual({
      service: "mock_email",
      connectedAt: expect.any(String) as unknown as string,
      hasCredential: true,
    });
    expect(snap.tableCounts.oauthState).toBe(1);
  });

  it("audit window is bounded: recent caps at the window, total keeps counting", async () => {
    const stub = getStub();
    const snap = await runInDurableObject(stub, (instance) => {
      // 60 entries straight through the real hash-chained write path.
      for (let i = 0; i < 60; i++) {
        instance.writeAuditEntry({
          userId: "window-user",
          agentId: "default",
          sessionId: "sess-w",
          toolName: "mock_email_list",
          service: "mock_email",
          verb: "list",
          noun: "INBOX",
          decision: "allow",
          parametersMetadata: { i },
          outcome: "success",
          latencyMs: 1,
        });
      }
      return instance.readModelSnapshot("window-user");
    });
    GovernanceSnapshotResponse.parse(snap);
    expect(snap.audit.recent).toHaveLength(50);
    expect(snap.audit.total).toBe(60);
    // Newest first: the last-written entry (sequence 59) leads.
    expect(snap.audit.recent[0]!.sequenceNum).toBe(59);
    expect(snap.audit.recent[49]!.sequenceNum).toBe(10);
  });
});
