import { describe, it, expect } from "vitest";
import {
  executeGmailSearch,
  GmailApiError,
  GMAIL_SEARCH,
  GMAIL_CAPABILITY_SCOPES,
} from "../../../src/services/google/gmail";

/** Build a mock fetch routing Gmail search (messages?q=) and detail requests. */
function searchFetch(opts: {
  messageIds: string[];
  messages: Record<string, { subject: string; from: string; date: string }>;
  searchStatus?: number;
  detailStatus?: number;
}) {
  const captured = { searchUrl: "" };
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    const detailMatch = url.match(/\/messages\/(\w+)/);
    if (detailMatch) {
      if (opts.detailStatus && opts.detailStatus !== 200) {
        return new Response("error", { status: opts.detailStatus });
      }
      const msg = opts.messages[detailMatch[1]!];
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

    if (url.includes("/messages")) {
      captured.searchUrl = url;
      if (opts.searchStatus && opts.searchStatus !== 200) {
        return new Response("error", { status: opts.searchStatus });
      }
      return new Response(
        JSON.stringify({ messages: opts.messageIds.map((id) => ({ id })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("unknown endpoint", { status: 404 });
  };
  return { fetch, captured };
}

const TEST_MESSAGES = {
  msg1: {
    subject: "Invoice #1234",
    from: "billing@example.com",
    date: "Mon, 07 Apr 2026 10:00:00 -0700",
  },
  msg2: {
    subject: "Re: Invoice #1234",
    from: "me@example.com",
    date: "Mon, 07 Apr 2026 11:00:00 -0700",
  },
};

describe("executeGmailSearch", () => {
  it("sends q and maxResults, returns metadata with each hit's message id", async () => {
    const { fetch, captured } = searchFetch({
      messageIds: ["msg1", "msg2"],
      messages: TEST_MESSAGES,
    });

    const result = await executeGmailSearch(
      "ya29.t",
      { q: "subject:invoice", maxResults: 5 },
      fetch,
    );

    const params = new URL(captured.searchUrl).searchParams;
    expect(params.get("q")).toBe("subject:invoice");
    expect(params.get("maxResults")).toBe("5");

    expect(result.messages).toHaveLength(2);
    // The id rides along so the model can follow up with gmail_read.
    expect(result.messages[0]).toEqual({
      id: "msg1",
      subject: "Invoice #1234",
      sender: "billing@example.com",
      timestamp: "Mon, 07 Apr 2026 10:00:00 -0700",
    });
  });

  it("caps the detail fanout at maxResults when the search over-returns", async () => {
    const { fetch } = searchFetch({
      messageIds: ["msg1", "msg2"],
      messages: TEST_MESSAGES,
    });

    const result = await executeGmailSearch(
      "ya29.t",
      { q: "invoice", maxResults: 1 },
      fetch,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe("msg1");
  });

  it("returns an empty array for no hits or a missing messages field", async () => {
    const { fetch } = searchFetch({ messageIds: [], messages: {} });
    const empty = await executeGmailSearch("ya29.t", { q: "nada", maxResults: 5 }, fetch);
    expect(empty.messages).toEqual([]);

    const noField = async (): Promise<Response> =>
      new Response(JSON.stringify({}), { status: 200 });
    const missing = await executeGmailSearch("ya29.t", { q: "nada", maxResults: 5 }, noField);
    expect(missing.messages).toEqual([]);
  });

  it("throws GmailApiError on a failing search or detail response", async () => {
    const { fetch: search403 } = searchFetch({
      messageIds: [],
      messages: {},
      searchStatus: 403,
    });
    await expect(
      executeGmailSearch("ya29.t", { q: "x", maxResults: 5 }, search403),
    ).rejects.toThrow("Gmail search failed (403)");

    const { fetch: detail500 } = searchFetch({
      messageIds: ["msg1"],
      messages: TEST_MESSAGES,
      detailStatus: 500,
    });
    await expect(
      executeGmailSearch("ya29.t", { q: "x", maxResults: 5 }, detail500),
    ).rejects.toThrow(GmailApiError);
  });
});

describe("GMAIL_SEARCH tool", () => {
  it("is governed as (gmail, search) with the resolved-label noun", () => {
    expect(GMAIL_SEARCH.service).toBe("gmail");
    expect(GMAIL_SEARCH.verb).toBe("search");
    expect(GMAIL_SEARCH.nounExtractor({ q: "from:alice in:inbox" })).toBe("INBOX");
    expect(GMAIL_SEARCH.nounExtractor({ q: "from:alice" })).toBe("anywhere");
    // Disjunction defeats mailbox narrowing (`in:sent OR from:x` reads the
    // whole account): the noun over-claims to anywhere so a narrow grant
    // can never cover the wider search.
    expect(GMAIL_SEARCH.nounExtractor({ q: "in:sent OR from:ceo" })).toBe(
      "anywhere",
    );
  });

  it("declares the read capability's satisfying scopes (shared with gmail_read)", () => {
    expect(GMAIL_SEARCH.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.read);
  });
});
