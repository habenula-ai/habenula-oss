import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  executeGmailList,
  gmailListExecute,
  GmailApiError,
} from "@habenula-ai/tools/services/google/gmail";
import { seedCiphertext } from "../../helpers/seed-credential";

/** Build a mock fetch that routes Gmail API list and detail requests. */
function gmailMockFetch(opts: {
  messageIds: string[];
  messages: Record<
    string,
    { subject: string; from: string; date: string }
  >;
  listStatus?: number;
  detailStatus?: number;
}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // Message list endpoint
    if (url.includes("/messages") && !url.match(/\/messages\/\w/)) {
      if (opts.listStatus && opts.listStatus !== 200) {
        return new Response("error", { status: opts.listStatus });
      }
      return new Response(
        JSON.stringify({
          messages: opts.messageIds.map((id) => ({ id })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Message detail endpoint
    const detailMatch = url.match(/\/messages\/(\w+)/);
    if (detailMatch) {
      if (opts.detailStatus && opts.detailStatus !== 200) {
        return new Response("error", { status: opts.detailStatus });
      }
      const id = detailMatch[1]!;
      const msg = opts.messages[id];
      if (!msg) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          payload: {
            headers: [
              { name: "Subject", value: msg.subject },
              { name: "From", value: msg.from },
              { name: "Date", value: msg.date },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("unknown endpoint", { status: 404 });
  };
}

/**
 * Build a mock fetch that records the request's URL and headers and returns
 * an empty inbox, so no detail fetches follow the list call.
 */
function captureFetch() {
  const captured = { url: "", headers: undefined as HeadersInit | undefined };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.headers = init?.headers;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  };
  return { fetch, captured };
}

/** A valid gmail-native request for tests where the exact values don't matter. */
const REQUEST = { labelId: "INBOX", maxResults: 5 } as const;

describe("Gmail API client", () => {
  const testMessages = {
    msg1: {
      subject: "Meeting Tomorrow",
      from: "alice@example.com",
      date: "Mon, 07 Apr 2026 10:00:00 -0700",
    },
    msg2: {
      subject: "Project Update",
      from: "bob@example.com",
      date: "Mon, 07 Apr 2026 09:30:00 -0700",
    },
    msg3: {
      subject: "Invoice #1234",
      from: "billing@example.com",
      date: "Sun, 06 Apr 2026 15:00:00 -0700",
    },
  };

  it("returns messages with correct shape", async () => {
    const result = await executeGmailList(
      "ya29.test-token",
      { labelId: "INBOX", maxResults: 3 },
      gmailMockFetch({
        messageIds: ["msg1", "msg2", "msg3"],
        messages: testMessages,
      }),
    );

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toEqual({
      subject: "Meeting Tomorrow",
      sender: "alice@example.com",
      timestamp: "Mon, 07 Apr 2026 10:00:00 -0700",
    });
    expect(result.messages[1]!.subject).toBe("Project Update");
    expect(result.messages[2]!.sender).toBe("billing@example.com");
  });

  it("caps the detail fanout at maxResults when the list over-returns", async () => {
    // The list response carries more IDs than requested (a contract-violating
    // provider); the executor must bound its per-message fanout — and the
    // returned page — by the validated maxResults, not the response length.
    const result = await executeGmailList(
      "ya29.test",
      { labelId: "INBOX", maxResults: 1 },
      gmailMockFetch({
        messageIds: ["msg1", "msg2", "msg3"],
        messages: testMessages,
      }),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.subject).toBe("Meeting Tomorrow");
  });

  it("sends the given labelId and maxResults as query params", async () => {
    const { fetch, captured } = captureFetch();

    await executeGmailList("ya29.test", { labelId: "INBOX", maxResults: 5 }, fetch);

    const params = new URL(captured.url).searchParams;
    expect(params.get("labelIds")).toBe("INBOX");
    expect(params.get("maxResults")).toBe("5");
  });

  it("adapter maps the canonical DRAFTS label to Gmail's singular DRAFT labelId", async () => {
    const { fetch, captured } = captureFetch();

    await gmailListExecute("ya29.test", { label: "DRAFTS", maxResults: 5 }, fetch);

    expect(new URL(captured.url).searchParams.get("labelIds")).toBe("DRAFT");
  });

  it("adapter reaches Gmail system mailboxes beyond the mock's onboarding set", async () => {
    // Gmail owns a wider vocabulary than the mock (INBOX/SENT/DRAFTS): its
    // system labels list-through as their own labelId.
    const { fetch, captured } = captureFetch();

    await gmailListExecute("ya29.test", { label: "STARRED", maxResults: 5 }, fetch);

    expect(new URL(captured.url).searchParams.get("labelIds")).toBe("STARRED");
  });

  it("adapter rejects invalid params via the shared guard before any fetch", async () => {
    const neverFetch = async (): Promise<Response> => {
      throw new Error("fetch must not be called for invalid params");
    };

    // One deliberately-invalid input (cast past the gmail label type) proves
    // the adapter wires assertEmailListParams ahead of the request; the
    // guard's full input matrix is pinned in test/services/shared/email.test.ts.
    // "ARCHIVE" is a real Gmail concept but not in the tool's system-label
    // vocabulary, so it is rejected as an input error.
    await expect(
      gmailListExecute(
        "ya29.test",
        { label: "ARCHIVE" } as unknown as Parameters<typeof gmailListExecute>[1],
        neverFetch,
      ),
    ).rejects.toThrow("Unknown mailbox label: ARCHIVE");
  });

  it("returns empty array for empty inbox", async () => {
    const emptyFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ messages: [] }), { status: 200 });

    const result = await executeGmailList(
      "ya29.test",
      REQUEST,
      emptyFetch,
    );
    expect(result.messages).toEqual([]);
  });

  it("returns empty array when messages field is missing", async () => {
    const noMessagesFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({}), { status: 200 });

    const result = await executeGmailList(
      "ya29.test",
      REQUEST,
      noMessagesFetch,
    );
    expect(result.messages).toEqual([]);
  });

  it("throws GmailApiError on 401 (expired token)", async () => {
    await expect(
      executeGmailList(
        "ya29.expired",
        REQUEST,
        gmailMockFetch({
          messageIds: [],
          messages: {},
          listStatus: 401,
        }),
      ),
    ).rejects.toThrow(GmailApiError);

    try {
      await executeGmailList(
        "ya29.expired",
        REQUEST,
        gmailMockFetch({ messageIds: [], messages: {}, listStatus: 401 }),
      );
    } catch (e) {
      expect(e).toBeInstanceOf(GmailApiError);
      expect((e as GmailApiError).status).toBe(401);
    }
  });

  it("throws GmailApiError on 403 (insufficient scopes)", async () => {
    await expect(
      executeGmailList(
        "ya29.no-scope",
        REQUEST,
        gmailMockFetch({ messageIds: [], messages: {}, listStatus: 403 }),
      ),
    ).rejects.toThrow("Gmail list failed (403)");
  });

  it("throws GmailApiError on 429 (rate limit)", async () => {
    await expect(
      executeGmailList(
        "ya29.rate-limited",
        REQUEST,
        gmailMockFetch({ messageIds: [], messages: {}, listStatus: 429 }),
      ),
    ).rejects.toThrow("Gmail list failed (429)");
  });

  it("throws on detail fetch failure", async () => {
    await expect(
      executeGmailList(
        "ya29.test",
        REQUEST,
        gmailMockFetch({
          messageIds: ["msg1"],
          messages: testMessages,
          detailStatus: 500,
        }),
      ),
    ).rejects.toThrow("Gmail message detail failed (500)");
  });

  it("respects maxResults parameter", async () => {
    const result = await executeGmailList(
      "ya29.test",
      { labelId: "INBOX", maxResults: 1 },
      gmailMockFetch({
        messageIds: ["msg1"],
        messages: testMessages,
      }),
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.subject).toBe("Meeting Tomorrow");
  });

  it("sends Authorization header with Bearer token", async () => {
    const { fetch, captured } = captureFetch();

    await executeGmailList("ya29.my-secret-token", REQUEST, fetch);

    expect(captured.headers).toEqual({
      Authorization: "Bearer ya29.my-secret-token",
    });
  });
});

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const baseParams = {
  toolName: "gmail_list",
  toolParams: { label: "INBOX", maxResults: 2 },
  agentId: "agent-1",
  epochId: "2026-04-08",
  timestamp: "2026-04-08T12:00:00Z",
};

/** Build a mock fetch that returns Gmail API responses for list + detail. */
function gmailApiFetch(
  messages: { id: string; subject: string; from: string; date: string }[],
) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    // Message list
    if (url.includes("/messages") && !url.match(/\/messages\/\w/)) {
      return new Response(
        JSON.stringify({ messages: messages.map((m) => ({ id: m.id })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Message detail
    const match = url.match(/\/messages\/(\w+)/);
    if (match) {
      const msg = messages.find((m) => m.id === match[1]);
      if (!msg) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          payload: {
            headers: [
              { name: "Subject", value: msg.subject },
              { name: "From", value: msg.from },
              { name: "Date", value: msg.date },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("unknown", { status: 404 });
  };
}

/**
 * Dispatch through the DO's full governance + execution pipeline for the gmail
 * service. The provider-isolation and single-decrypt properties are covered
 * generically over the catalog in integration/dispatch-isolation; this bundle
 * pins the gmail-specific end-to-end behavior: real API data flows through,
 * a missing credential surfaces as an execution error with an audit outcome,
 * and no raw token reaches the audit log after a real tool run.
 */
describe("Gmail tool dispatch (integration)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gmail_list → Gmail API called → returns real message data", async () => {
    const userId = "gmail-dispatch-real";

    // A real (non-mock) credential, seeded onto the gmail row
    const ciphertext = await seedCiphertext();

    // Intercept Gmail API calls
    globalThis.fetch = gmailApiFetch([
      { id: "m1", subject: "Real Email", from: "real@example.com", date: "2026-04-08T10:00:00Z" },
      { id: "m2", subject: "Another Email", from: "other@example.com", date: "2026-04-08T09:00:00Z" },
    ]);

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({ ...baseParams, userId });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.execution).toBeDefined();
    expect(result.execution!.success).toBe(true);

    const data = result.execution!.data as { messages: { subject: string; sender: string }[] };
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]!.subject).toBe("Real Email");
    expect(data.messages[0]!.sender).toBe("real@example.com");
    expect(data.messages[1]!.subject).toBe("Another Email");
  });

  it("no credential → execution error (not silent mock fallback)", async () => {
    const userId = "gmail-dispatch-no-cred";

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail");
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    const result = await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({ ...baseParams, userId });
    });

    expect(result.governance.decision).toBe("allow");
    expect(result.execution!.success).toBe(false);
    expect(result.execution!.error).toContain("No credential found");

    // Outcome entry in audit chain records the error with message
    const outcomeRows = await runInDurableObject(stub, (instance) => {
      return instance.sql<{
        outcome: string;
        error_message: string | null;
        decision_entry_id: string;
      }>`SELECT outcome, error_message, decision_entry_id FROM audit_log WHERE decision_entry_id = ${result.governance.auditEntry.id}`;
    });
    expect(outcomeRows).toHaveLength(1);
    expect(outcomeRows[0]!.outcome).toBe("error");
    expect(outcomeRows[0]!.error_message).toContain("No credential found");
    expect(outcomeRows[0]!.decision_entry_id).toBe(result.governance.auditEntry.id);
  });

  it("Hard Invariant #1: raw token never in audit log after real tool execution", async () => {
    const userId = "gmail-dispatch-invariant";
    const token = "ya29.invariant-check-secret-token";

    const ciphertext = await seedCiphertext({
      access_token: token,
      refresh_token: "1//invariant-refresh",
    });

    globalThis.fetch = gmailApiFetch([
      { id: "m1", subject: "Test", from: "test@test.com", date: "2026-04-08T10:00:00Z" },
    ]);

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseParams.agentId,
      });
      instance.createSessionGrant("gmail", "list", "INBOX", sessionId);
    });

    await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        ...baseParams,
        userId,
        toolParams: { label: "INBOX", maxResults: 1 },
      });
    });

    // Scan audit log for raw token
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<Record<string, string | null>>`SELECT * FROM audit_log`;
    });

    const allValues = rows.flatMap((row) =>
      Object.values(row).map((v) => String(v ?? "")),
    );
    const joined = allValues.join("|");

    expect(joined).not.toContain(token);
    expect(joined).not.toContain("1//invariant-refresh");
  });
});
