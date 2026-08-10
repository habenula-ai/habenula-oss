import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { seedCiphertext } from "../helpers/seed-credential";
import { asTurn } from "../helpers/turn";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
} from "../../src/llm/types";

/**
 * The per-tool grant-isolation metrics for the consequential send/reply
 * verbs: a send grant is bounded
 * by its recipient-address noun and its verb — it reuses only for the exact
 * granted recipient set, holds for any changed set (even a new address in
 * the same domain; per-address subset coverage is deferred), and never
 * authorizes a different verb. Plus the two Hard
 * Invariants on the new write path: audit-before-execute, and no raw token
 * toward the model or the audit log.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const AGENT_ID = "agent-isolation";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Count Gmail send calls; answer with a canned send success. */
function gmailSendFetch() {
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls++;
    return new Response(JSON.stringify({ id: "sent-1", threadId: "t-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, count: () => calls };
}

function sendParams(to: string[]): Record<string, unknown> {
  return { to, subject: "Numbers", body: "See below." };
}

/** Connect gmail with a send-capable credential and grant (gmail, send, noun). */
async function seedSendGrant(noun: string) {
  const ciphertext = await seedCiphertext({
    scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
  });
  const stub = getStub();
  const userId = `grant-isolation-${crypto.randomUUID()}`;
  await runInDurableObject(stub, (instance) => {
    instance.connectService("gmail", ciphertext);
    const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
    instance.createSessionGrant("gmail", "send", noun, sessionId);
  });
  return { stub, userId };
}

describe("send grant isolation", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a send grant covers exactly its address — a different same-domain address holds", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const first = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );
    expect(first.governance.decision).toBe("allow");
    expect(first.execution?.success).toBe(true);

    // The grant grain is the exact address set:
    // a second send to a DIFFERENT @acme.com address is a new noun and
    // re-confirms — intra-domain broadening is deliberately not covered
    // (per-address subset coverage is deferred).
    const second = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["bob@acme.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );
    expect(second.governance.decision).toBe("pending");
    expect(second.held).toBeDefined();
    expect(second.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(1);
  });

  it("a send to another domain holds for confirmation — no dispatch", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["mallory@other.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.decision).toBe("pending");
    expect(result.held).toBeDefined();
    expect(result.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(0);
  });

  it("a multi-recipient send never rides a single-address grant", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    // The noun is the WHOLE recipient-address set — smuggling one extra
    // recipient into an authorized send changes the noun and forces a hold.
    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com", "mallory@other.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.noun).toBe("alice@acme.com,mallory@other.com");
    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(0);
  });

  it("a send grant does not authorize reply — separate verbs, separate grants", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_reply",
        toolParams: {
          threadId: "t-1",
          inReplyTo: "<m@acme.com>",
          ...sendParams(["alice@acme.com"]),
        },
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.verb).toBe("reply");
    expect(result.governance.decision).toBe("pending");
    expect(result.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(0);
  });

  it("an unparseable recipient changes the noun — a grant never covers it", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com", "not-an-address"]),
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.noun).toBe(
      "alice@acme.com,unparseable:not-an-address",
    );
    expect(result.governance.decision).toBe("pending");
    expect(gmailApi.count()).toBe(0);
  });

  it("audit-before-execute holds on the send path (Hard Invariant 3)", async () => {
    const { stub, userId } = await seedSendGrant("alice@acme.com");
    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );
    expect(result.execution?.success).toBe(true);

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        sequence_num: number;
        decision: string;
        outcome: string;
        noun: string;
        decision_entry_id: string | null;
      }>`SELECT sequence_num, decision, outcome, noun, decision_entry_id
         FROM audit_log WHERE tool_name = 'gmail_send' ORDER BY sequence_num`;
    });

    // The allow decision entry precedes the outcome entry, which references
    // it — the decision was durably recorded before the fetch dispatched.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.decision).toBe("allow");
    expect(rows[0]!.noun).toBe("alice@acme.com");
    expect(rows[1]!.outcome).toBe("success");
    expect(rows[1]!.decision_entry_id).toBe(result.governance.auditEntry.id);
    expect(rows[0]!.sequence_num).toBeLessThan(rows[1]!.sequence_num);
  });

  it("partial consent fails closed: gmail.send declined → needs_authorization, never a Gmail 403", async () => {
    // The user approved reading but declined sending at the consent screen:
    // the stored credential's granted scopes carry readonly only.
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_READONLY_SCOPE] });
    const stub = getStub();
    const userId = "grant-isolation-partial-consent";
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "send", "alice@acme.com", sessionId);
    });

    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(0);

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        error_message: string | null;
      }>`SELECT error_message FROM audit_log WHERE tool_name = 'gmail_send'`;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error_message).toContain("not authorized to send");
  });

  it("capability coverage: gmail.compose satisfies send with gmail.send declined", async () => {
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_COMPOSE_SCOPE] });
    const stub = getStub();
    const userId = "grant-isolation-compose-covers";
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "send", "alice@acme.com", sessionId);
    });

    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        toolName: "gmail_send",
        toolParams: sendParams(["alice@acme.com"]),
        userId,
        agentId: AGENT_ID,
      }),
    );

    expect(result.governance.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);
  });

  it("Hard Invariant 1: the raw token reaches neither the model messages nor the audit log on a send", async () => {
    const token = "ya29.send-invariant-secret-token";
    const refresh = "1//send-invariant-refresh";
    const ciphertext = await seedCiphertext({
      access_token: token,
      refresh_token: refresh,
      scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
    });

    const capturedLLMParams: LLMCreateParams[] = [];
    let llmCall = 0;
    const mockLLM: LLMClient = {
      async createMessage(params: LLMCreateParams): Promise<LLMResponse> {
        capturedLLMParams.push(JSON.parse(JSON.stringify(params)));
        llmCall++;
        if (llmCall === 1) {
          return {
            id: "m1",
            content: [
              {
                type: "tool_use",
                id: "tu-send-1",
                name: "gmail_send",
                input: sendParams(["alice@acme.com"]),
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        return {
          id: "m2",
          content: [{ type: "text", text: "Sent." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };

    const gmailApi = gmailSendFetch();
    globalThis.fetch = gmailApi.fetch;

    const stub = getStub();
    const userId = "grant-isolation-hi1";
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant("gmail", "send", "alice@acme.com", sessionId);
      instance.setLLMClient(mockLLM);
    });

    const result = await runInDurableObject(stub, async (instance) =>
      instance.chat({ message: "Send Alice the numbers", userId }).then(asTurn),
    );

    expect(result.toolCalls).toEqual([
      { name: "gmail_send", id: "tu-send-1", outcome: "success" },
    ]);
    expect(gmailApi.count()).toBe(1);

    // Nothing the model ever saw carries the credential.
    const everythingTheModelSaw = JSON.stringify(capturedLLMParams);
    expect(everythingTheModelSaw).not.toContain(token);
    expect(everythingTheModelSaw).not.toContain(refresh);

    // Nor does any audit column.
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<Record<string, string | null>>`SELECT * FROM audit_log`;
    });
    const joined = rows
      .flatMap((row) => Object.values(row).map((v) => String(v ?? "")))
      .join("|");
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(refresh);
  });
});
