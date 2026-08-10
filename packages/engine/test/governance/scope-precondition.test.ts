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
 * The pre-policy scope precondition:
 * a connected service whose stored credential's granted scopes do not
 * cover a tool's declared capability is denied with the first-class
 * needs-authorization outcome — before policy, without dispatch, audited with
 * the same (service, verb, noun) a permitted call would carry.
 *
 * No Tier 1 tool has a real scope gap against gmail.readonly, so this suite —
 * driving the gate with a stripped-scope credential — is what keeps the
 * mechanism from shipping dormant.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const AGENT_ID = "agent-scope";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_FULL_ACCESS = "https://mail.google.com/";

/** A minimal Gmail API mock: empty list, so no detail fanout follows. */
function emptyGmailFetch() {
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    calls++;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  return { fetch, count: () => calls };
}

describe("scope precondition (needs_authorization)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("denies a granted call when the credential lacks every satisfying scope — no dispatch", async () => {
    const userId = "scope-missing";
    // Connected, but the credential's granted scopes hold no gmail scope at
    // all (partial/legacy consent).
    const ciphertext = await seedCiphertext({ scopes: ["email.read"] });

    // A live grant proves the gate fires BEFORE policy: policy would allow.
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const gmailApi = emptyGmailFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_list",
        toolParams: { label: "INBOX", maxResults: 2 },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.execution).toBeUndefined();
    expect(result.held).toBeUndefined();
    // Never dispatched: the Gmail API was not touched.
    expect(gmailApi.count()).toBe(0);
  });

  it("audits the deny with the governed (service, verb, noun) and the re-connect reason", async () => {
    const userId = "scope-audit";
    const ciphertext = await seedCiphertext({ scopes: [] });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_search",
        toolParams: { q: "from:alice in:inbox" },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.denyReason).toBe("needs_authorization");
    // The noun is extracted on every path: the
    // needs-authorization row carries the same resolved-label noun a
    // permitted search would.
    expect(result.governance.noun).toBe("INBOX");

    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        service: string;
        verb: string;
        noun: string;
        decision: string;
        outcome: string;
        error_message: string | null;
      }>`SELECT service, verb, noun, decision, outcome, error_message
         FROM audit_log WHERE tool_name = 'gmail_search'`;
    });

    // Exactly one entry: the deny decision, audited before (instead of) any
    // execution — no outcome row follows a call that never dispatched.
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      service: "gmail",
      verb: "search",
      noun: "INBOX",
      decision: "deny",
      // Not a new audit outcome value: deny rows are
      // outcome=error, distinguished by their error_message.
      outcome: "error",
    });
    expect(rows[0]!.error_message).toContain("not authorized to search");
    expect(rows[0]!.error_message).toContain("re-connect");
  });

  it("short-circuits to a plain deny before policy — never a hold", async () => {
    const userId = "scope-no-hold";
    const ciphertext = await seedCiphertext({ scopes: ["email.read"] });

    // No grant seeded: with scopes in order this would go pending (a hold);
    // with them missing it must be a plain needs-authorization deny.
    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_read",
        toolParams: { messageId: "m1" },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.held).toBeUndefined();
    expect(result.governance.noun).toBe("mailbox");
  });

  it("skips the gate when no credential is readable — a missing credential is not a scope gap", async () => {
    const userId = "scope-no-credential";

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      // Connected with no stored credential. The gate answers only "do the
      // GRANTED scopes cover the capability?" — with nothing granted to
      // read, it defers to the existing dispatch-time credential handling
      // (the executor's "No credential found" error) rather than mislabeling
      // the state as a consent gap.
      instance.connectService("gmail");
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_list",
        toolParams: { label: "INBOX", maxResults: 2 },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.denyReason).toBeUndefined();
    expect(result.execution?.success).toBe(false);
    expect(result.execution?.error).toContain("No credential found");
  });

  it("capability coverage, not exact-string membership: gmail.modify satisfies read", async () => {
    const userId = "scope-broader";
    // gmail.readonly declined, gmail.modify granted — modify covers the read
    // capability, so the call proceeds.
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_MODIFY] });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const gmailApi = emptyGmailFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_list",
        toolParams: { label: "INBOX", maxResults: 2 },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);
    expect(gmailApi.count()).toBeGreaterThan(0);
  });

  it("the umbrella scope (full mailbox access) satisfies read", async () => {
    // Never requested by Habenula, but a credential is judged by what it
    // holds: mail.google.com is a superset of every gmail scope, so the
    // broadest possible grant must not read as a scope gap.
    const userId = "scope-umbrella";
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_FULL_ACCESS] });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const gmailApi = emptyGmailFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_list",
        toolParams: { label: "INBOX", maxResults: 2 },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);
  });

  it("passes with the matching scope granted (the baseline)", async () => {
    const userId = "scope-baseline";
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_READONLY] });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const gmailApi = emptyGmailFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_list",
        toolParams: { label: "INBOX", maxResults: 2 },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.execution?.success).toBe(true);
  });

  it("a Tier-2 credential (readonly + send) hits needs_authorization on a hygiene tool", async () => {
    // The real Tier-3 migration case: a user connected
    // before gmail.modify was requested tries to trash a message.
    const userId = "scope-tier2-cred-trash";
    const ciphertext = await seedCiphertext({
      scopes: [GMAIL_READONLY, "https://www.googleapis.com/auth/gmail.send"],
    });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "trash", "TRASH", sessionId);
    });

    const gmailApi = emptyGmailFetch();
    globalThis.fetch = gmailApi.fetch;

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "gmail_trash",
        toolParams: { messageId: "m1" },
        userId,
        agentId: AGENT_ID,
      });
    });

    expect(result.governance.decision).toBe("deny");
    expect(result.denyReason).toBe("needs_authorization");
    expect(result.governance.noun).toBe("TRASH");
    expect(result.execution).toBeUndefined();
    expect(gmailApi.count()).toBe(0);
  });

  it("one broad scope satisfies every narrower capability: gmail.modify alone covers read, draft, and hygiene", async () => {
    // gmail.modify is a near-master scope: the
    // check asks only whether ANY held scope covers the capability, so a
    // modify-only credential passes the gate for every Tier 1–3 tool.
    const userId = "scope-modify-master";
    const ciphertext = await seedCiphertext({ scopes: [GMAIL_MODIFY] });

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: AGENT_ID });
      instance.createSessionGrant("gmail", "read", "mailbox", sessionId);
      instance.createSessionGrant("gmail", "draft", "a@acme.com", sessionId);
      instance.createSessionGrant("gmail", "archive", "INBOX", sessionId);
    });

    // Answers Gmail's read, drafts, and modify endpoints generically.
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/drafts")) {
        return new Response(
          JSON.stringify({ id: "d1", message: { id: "m1", threadId: "t1" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: "m1", threadId: "t1", labelIds: [], payload: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const calls: [string, Record<string, unknown>][] = [
      ["gmail_read", { messageId: "m1" }],
      ["gmail_draft", { to: ["a@acme.com"], subject: "s", body: "b" }],
      ["gmail_archive", { messageId: "m1" }],
    ];
    for (const [toolName, toolParams] of calls) {
      const result = await runInDurableObject(stub, async (instance) => {
        return instance.executeTool({ toolName, toolParams, userId, agentId: AGENT_ID });
      });
      expect(result.governance.decision, toolName).toBe("allow");
      expect(result.execution?.success, toolName).toBe(true);
    }
  });

  it("surfaces the distinct needs_authorization ToolCallOutcome through a chat turn", async () => {
    const userId = "scope-chat-outcome";
    const ciphertext = await seedCiphertext({ scopes: ["email.read"] });

    let llmCallCount = 0;
    const mockLLM: LLMClient = {
      async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            id: "msg_scope_1",
            content: [
              {
                type: "tool_use",
                id: "toolu_scope_1",
                name: "gmail_list",
                input: { label: "INBOX", maxResults: 2 },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return {
          id: "msg_scope_2",
          content: [
            {
              type: "text",
              text: "Gmail needs to be re-authorized before I can list messages.",
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    };

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
      instance.setLLMClient(mockLLM);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.chat({ message: "List my email", userId }).then(asTurn);
    });

    // The loop reports the sibling-of-not_connected outcome, so the client
    // can route the user to re-connect rather than to a policy change.
    expect(result.toolCalls).toEqual([
      { name: "gmail_list", id: "toolu_scope_1", outcome: "needs_authorization" },
    ]);
  });
});
