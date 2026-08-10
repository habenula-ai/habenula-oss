import { describe, it, expect } from "vitest";
import {
  executeOutlookMailList,
  executeOutlookMailSearch,
  executeOutlookMailGet,
  executeOutlookMailSend,
} from "../../../src/services/microsoft/outlook-mail-client";
import {
  GraphApiError,
  GRAPH_BASE,
} from "../../../src/services/microsoft/graph";
import { EMAIL_READ_BODY_MAX_CHARS } from "../../../src/services/shared/email-read";

/** One canned JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A scripted fetch: pops one response per call, recording URLs and inits. */
function scriptedFetch(responses: Response[]) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    urls.push(typeof input === "string" ? input : input.toString());
    inits.push(init);
    const next = responses.shift();
    if (!next) {
      throw new Error(`scripted fetch exhausted (call ${String(urls.length)})`);
    }
    return next;
  };
  return { fetchFn, urls, inits };
}

/** A projected Graph message row. */
function graphMessage(opts: {
  id?: string;
  subject?: string;
  name?: string;
  address?: string;
  received?: string;
}) {
  return {
    id: opts.id,
    subject: opts.subject ?? "a subject",
    from: {
      emailAddress: {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.address !== undefined ? { address: opts.address } : {}),
      },
    },
    receivedDateTime: opts.received ?? "2026-07-15T10:00:00Z",
  };
}

describe("executeOutlookMailList", () => {
  it("requests the folder path with $select and $top, mapping the fields", async () => {
    const { fetchFn, urls, inits } = scriptedFetch([
      jsonResponse({
        value: [
          graphMessage({
            subject: "Meeting Tomorrow",
            name: "Alice",
            address: "alice@example.com",
            received: "2026-07-14T09:30:00Z",
          }),
          graphMessage({ subject: "No display name", address: "bob@x.com" }),
        ],
      }),
    ]);

    const result = await executeOutlookMailList(
      "ms-token",
      { folder: "inbox", maxResults: 5 },
      { fetchFn },
    );

    const url = new URL(urls[0]!);
    expect(urls[0]).toContain(`${GRAPH_BASE}/me/mailFolders/inbox/messages`);
    expect(url.searchParams.get("$select")).toBe(
      "subject,from,receivedDateTime",
    );
    expect(url.searchParams.get("$top")).toBe("5");
    expect(new Headers(inits[0]?.headers).get("Authorization")).toBe(
      "Bearer ms-token",
    );
    expect(result.messages).toEqual([
      {
        subject: "Meeting Tomorrow",
        sender: "Alice <alice@example.com>",
        timestamp: "2026-07-14T09:30:00Z",
      },
      {
        subject: "No display name",
        sender: "bob@x.com",
        timestamp: "2026-07-15T10:00:00Z",
      },
    ]);
  });

  it("uses the folder name verbatim in the path (sentitems, no translation)", async () => {
    const { fetchFn, urls } = scriptedFetch([jsonResponse({ value: [] })]);

    await executeOutlookMailList(
      "ms-token",
      { folder: "sentitems", maxResults: 5 },
      { fetchFn },
    );

    expect(urls[0]).toContain("/me/mailFolders/sentitems/messages");
  });

  it("follows plain-list paging: nextLink verbatim, bounded by maxResults", async () => {
    // The plain folder-list paging path, exercised in its own right —
    // separate from $search paging below.
    const nextLink = `${GRAPH_BASE}/me/mailFolders/inbox/messages?%24skiptoken=list-page-2`;
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: [
          graphMessage({ subject: "one", address: "a@x.com" }),
          graphMessage({ subject: "two", address: "b@x.com" }),
        ],
        "@odata.nextLink": nextLink,
      }),
      jsonResponse({
        value: [
          graphMessage({ subject: "three", address: "c@x.com" }),
          graphMessage({ subject: "four", address: "d@x.com" }),
        ],
        "@odata.nextLink": `${GRAPH_BASE}/never-followed`,
      }),
    ]);

    const result = await executeOutlookMailList(
      "ms-token",
      { folder: "inbox", maxResults: 3 },
      { fetchFn },
    );

    // The second request is the nextLink exactly as issued.
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(nextLink);
    // maxResults binds mid-walk: three rows, the third page never fetched.
    expect(result.messages.map((m) => m.subject)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("returns [] for an empty folder", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({ value: [] })]);

    const result = await executeOutlookMailList(
      "ms-token",
      { folder: "archive", maxResults: 5 },
      { fetchFn },
    );

    expect(result.messages).toEqual([]);
  });

  it("propagates a GraphApiError from the substrate", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({}, 403)]);

    await expect(
      executeOutlookMailList(
        "ms-token",
        { folder: "inbox", maxResults: 5 },
        { fetchFn },
      ),
    ).rejects.toThrow(GraphApiError);
  });
});

describe("executeOutlookMailSearch", () => {
  it("requests /me/messages with a double-quoted $search and id in $select", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: [
          graphMessage({
            id: "msg-1",
            subject: "Invoice",
            name: "Alice",
            address: "alice@example.com",
          }),
        ],
      }),
    ]);

    const result = await executeOutlookMailSearch(
      "ms-token",
      { q: "from:alice invoice", maxResults: 5 },
      { fetchFn },
    );

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v1.0/me/messages");
    expect(url.searchParams.get("$search")).toBe('"from:alice invoice"');
    expect(url.searchParams.get("$select")).toBe(
      "id,subject,from,receivedDateTime",
    );
    expect(url.searchParams.get("$top")).toBe("5");
    // Graph rejects these alongside $search — never emitted.
    expect(url.searchParams.get("$orderby")).toBeNull();
    expect(url.searchParams.get("$count")).toBeNull();
    expect(url.searchParams.get("$skip")).toBeNull();
    // Hits carry ids for the search-then-read flow.
    expect(result.messages).toEqual([
      {
        id: "msg-1",
        subject: "Invoice",
        sender: "Alice <alice@example.com>",
        timestamp: "2026-07-15T10:00:00Z",
      },
    ]);
  });

  it("backslash-escapes embedded double quotes in the $search value", async () => {
    const { fetchFn, urls } = scriptedFetch([jsonResponse({ value: [] })]);

    await executeOutlookMailSearch(
      "ms-token",
      { q: 'subject:"quarterly report"', maxResults: 5 },
      { fetchFn },
    );

    const url = new URL(urls[0]!);
    expect(url.searchParams.get("$search")).toBe(
      '"subject:\\"quarterly report\\""',
    );
  });

  it("escapes backslashes before quotes so the clause cannot un-terminate", async () => {
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({ value: [] }),
      jsonResponse({ value: [] }),
    ]);

    // A trailing backslash must not swallow the closing quote…
    await executeOutlookMailSearch(
      "ms-token",
      { q: "trailing\\", maxResults: 5 },
      { fetchFn },
    );
    // …and a pre-escaped quote in the input must stay a literal backslash
    // followed by an escaped quote, not collapse into a bare escape.
    await executeOutlookMailSearch(
      "ms-token",
      { q: 'say \\"hi', maxResults: 5 },
      { fetchFn },
    );

    expect(new URL(urls[0]!).searchParams.get("$search")).toBe(
      '"trailing\\\\"',
    );
    expect(new URL(urls[1]!).searchParams.get("$search")).toBe(
      '"say \\\\\\"hi"',
    );
  });

  it("follows $search paging: nextLink verbatim, bounded on this path in its own right", async () => {
    // The $search paging path, exercised separately from the plain folder
    // list: Graph caps search result sets and pages differently, so the
    // maxResults-plus-page-cap bound cannot be assumed to transfer.
    const nextLink = `${GRAPH_BASE}/me/messages?%24search=%22report%22&%24skiptoken=search-page-2`;
    const { fetchFn, urls } = scriptedFetch([
      jsonResponse({
        value: [
          graphMessage({ id: "s1", subject: "r-one", address: "a@x.com" }),
          graphMessage({ id: "s2", subject: "r-two", address: "b@x.com" }),
        ],
        "@odata.nextLink": nextLink,
      }),
      jsonResponse({
        value: [
          graphMessage({ id: "s3", subject: "r-three", address: "c@x.com" }),
          graphMessage({ id: "s4", subject: "r-four", address: "d@x.com" }),
        ],
        "@odata.nextLink": `${GRAPH_BASE}/never-followed`,
      }),
    ]);

    const result = await executeOutlookMailSearch(
      "ms-token",
      { q: "report", maxResults: 3 },
      { fetchFn },
    );

    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(nextLink);
    expect(result.messages.map((m) => m.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("returns [] when the search matches nothing", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({ value: [] })]);

    const result = await executeOutlookMailSearch(
      "ms-token",
      { q: "nothing", maxResults: 5 },
      { fetchFn },
    );

    expect(result.messages).toEqual([]);
  });
});

describe("executeOutlookMailGet", () => {
  const fullMessage = {
    id: "m1",
    subject: "Meeting Tomorrow",
    from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    toRecipients: [
      { emailAddress: { name: "Me", address: "me@example.com" } },
      { emailAddress: { address: "other@example.com" } },
    ],
    receivedDateTime: "2026-07-14T09:30:00Z",
    body: { contentType: "text", content: "Hello — see you at 10am." },
  };

  it("requests the message with the text-body Prefer header and maps the fields", async () => {
    const { fetchFn, urls, inits } = scriptedFetch([jsonResponse(fullMessage)]);

    const result = await executeOutlookMailGet(
      "ms-token",
      { messageId: "m1" },
      { fetchFn },
    );

    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v1.0/me/messages/m1");
    expect(url.searchParams.get("$select")).toBe(
      "id,subject,from,toRecipients,receivedDateTime,body",
    );
    // Graph converts an HTML body to text server-side under this Prefer.
    expect(new Headers(inits[0]?.headers).get("Prefer")).toBe(
      'outlook.body-content-type="text"',
    );
    expect(result).toEqual({
      id: "m1",
      subject: "Meeting Tomorrow",
      sender: "Alice <alice@example.com>",
      to: "Me <me@example.com>, other@example.com",
      timestamp: "2026-07-14T09:30:00Z",
      body: "Hello — see you at 10am.",
    });
  });

  it("applies the shared truncation contract to an oversized body", async () => {
    const oversized = "x".repeat(EMAIL_READ_BODY_MAX_CHARS + 500);
    const { fetchFn } = scriptedFetch([
      jsonResponse({ ...fullMessage, body: { content: oversized } }),
    ]);

    const result = await executeOutlookMailGet(
      "ms-token",
      { messageId: "m1" },
      { fetchFn },
    );

    expect(result.body).toContain("[... body truncated: 500 of ");
    expect(result.body.length).toBeLessThan(EMAIL_READ_BODY_MAX_CHARS + 100);
  });

  it("returns an empty body when the message carries none", async () => {
    const { fetchFn } = scriptedFetch([
      jsonResponse({ ...fullMessage, body: undefined }),
    ]);

    const result = await executeOutlookMailGet(
      "ms-token",
      { messageId: "m1" },
      { fetchFn },
    );

    expect(result.body).toBe("");
  });

  it("throws GraphApiError with the status on a missing message", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({}, 404)]);

    const err = await executeOutlookMailGet(
      "ms-token",
      { messageId: "missing" },
      { fetchFn },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(404);
  });
});

describe("executeOutlookMailSend", () => {
  const envelope = {
    to: ["Alice Smith <alice@example.com>", "bob@example.com"],
    cc: ['"Last, First" <cf@example.com>'],
    bcc: [],
    subject: "Status update",
    body: "All green.",
  };

  it("POSTs the structured sendMail body and reports 202 as accepted", async () => {
    const { fetchFn, urls, inits } = scriptedFetch([
      new Response(null, { status: 202 }),
    ]);

    const result = await executeOutlookMailSend("ms-token", envelope, {
      fetchFn,
    });

    expect(urls[0]).toBe(`${GRAPH_BASE}/me/sendMail`);
    expect(inits[0]?.method).toBe("POST");
    const sent = JSON.parse(String(inits[0]?.body)) as {
      message: {
        subject: string;
        body: { contentType: string; content: string };
        toRecipients: unknown[];
        ccRecipients: unknown[];
        bccRecipients: unknown[];
      };
      saveToSentItems: boolean;
    };
    expect(sent.saveToSentItems).toBe(true);
    expect(sent.message.subject).toBe("Status update");
    expect(sent.message.body).toEqual({
      contentType: "Text",
      content: "All green.",
    });
    // `Display <addr>` converts to the emailAddress node; a bare address
    // carries no name; an RFC 5322 quote layer is stripped, not sent.
    expect(sent.message.toRecipients).toEqual([
      { emailAddress: { address: "alice@example.com", name: "Alice Smith" } },
      { emailAddress: { address: "bob@example.com" } },
    ]);
    expect(sent.message.ccRecipients).toEqual([
      { emailAddress: { address: "cf@example.com", name: "Last, First" } },
    ]);
    expect(sent.message.bccRecipients).toEqual([]);
    // Acceptance, not delivery (202 semantics).
    expect(result).toEqual({ accepted: true });
  });

  it("throws on a non-202 success status rather than mislabeling it accepted", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({}, 200)]);

    await expect(
      executeOutlookMailSend("ms-token", envelope, { fetchFn }),
    ).rejects.toThrow("expected 202");
  });

  it("propagates a GraphApiError on a rejected send", async () => {
    const { fetchFn } = scriptedFetch([jsonResponse({}, 403)]);

    const err = await executeOutlookMailSend("ms-token", envelope, {
      fetchFn,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(403);
  });
});
