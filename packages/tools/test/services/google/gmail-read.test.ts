import { describe, it, expect } from "vitest";
import {
  executeGmailGet,
  GmailApiError,
  GMAIL_READ,
  GMAIL_CAPABILITY_SCOPES,
  GMAIL_READ_BODY_MAX_CHARS,
} from "../../../src/services/google/gmail";

/** Gmail's base64url encoding of a UTF-8 string. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const HEADERS = [
  { name: "Subject", value: "Meeting Tomorrow" },
  { name: "From", value: "alice@example.com" },
  { name: "To", value: "me@example.com" },
  { name: "Date", value: "Mon, 07 Apr 2026 10:00:00 -0700" },
];

/** Mock fetch returning one full-format message payload. */
function readFetch(payload: unknown, status = 200) {
  const captured = { url: "", headers: undefined as HeadersInit | undefined };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.headers = init?.headers;
    if (status !== 200) {
      return new Response("error", { status });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, captured };
}

describe("executeGmailGet", () => {
  it("requests format=full for the message id with the bearer token", async () => {
    const { fetch, captured } = readFetch({ id: "m1", payload: { headers: HEADERS } });

    await executeGmailGet("ya29.read-token", { messageId: "m1" }, fetch);

    const url = new URL(captured.url);
    expect(url.pathname).toContain("/messages/m1");
    expect(url.searchParams.get("format")).toBe("full");
    expect(captured.headers).toEqual({ Authorization: "Bearer ya29.read-token" });
  });

  it("returns headers plus the decoded single-part body", async () => {
    const { fetch } = readFetch({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "text/plain",
        headers: HEADERS,
        body: { data: b64url("Hello — see you at 10am.") },
      },
    });

    const result = await executeGmailGet("ya29.t", { messageId: "m1" }, fetch);

    expect(result).toEqual({
      id: "m1",
      threadId: "t1",
      subject: "Meeting Tomorrow",
      sender: "alice@example.com",
      to: "me@example.com",
      timestamp: "Mon, 07 Apr 2026 10:00:00 -0700",
      body: "Hello — see you at 10am.",
    });
  });

  it("prefers the text/plain part of a nested multipart payload", async () => {
    const { fetch } = readFetch({
      id: "m2",
      threadId: "t2",
      payload: {
        mimeType: "multipart/mixed",
        headers: HEADERS,
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/html", body: { data: b64url("<b>html</b>") } },
              { mimeType: "text/plain", body: { data: b64url("plain text") } },
            ],
          },
          { mimeType: "application/pdf", body: {} },
        ],
      },
    });

    const result = await executeGmailGet("ya29.t", { messageId: "m2" }, fetch);
    expect(result.body).toBe("plain text");
  });

  it("falls back to text/html when no text/plain part exists", async () => {
    const { fetch } = readFetch({
      id: "m3",
      payload: {
        mimeType: "multipart/alternative",
        headers: HEADERS,
        parts: [{ mimeType: "text/html", body: { data: b64url("<p>only html</p>") } }],
      },
    });

    const result = await executeGmailGet("ya29.t", { messageId: "m3" }, fetch);
    expect(result.body).toBe("<p>only html</p>");
  });

  it("returns an empty body when the payload carries no body data", async () => {
    const { fetch } = readFetch({ id: "m4", payload: { headers: HEADERS } });

    const result = await executeGmailGet("ya29.t", { messageId: "m4" }, fetch);
    expect(result.body).toBe("");
  });

  it("caps an oversized body at the ceiling with an explicit truncation marker", async () => {
    // format=full has no server-side bound and the body flows into the LLM
    // context; the cap is read's analogue of list/search's maxResults.
    const oversized = "x".repeat(GMAIL_READ_BODY_MAX_CHARS + 500);
    const { fetch } = readFetch({
      id: "m5",
      payload: {
        mimeType: "text/plain",
        headers: HEADERS,
        body: { data: b64url(oversized) },
      },
    });

    const result = await executeGmailGet("ya29.t", { messageId: "m5" }, fetch);

    expect(result.body).toContain("[... body truncated: 500 of ");
    expect(result.body.length).toBeLessThan(GMAIL_READ_BODY_MAX_CHARS + 100);

    // A body exactly at the ceiling passes through unmarked.
    const atCeiling = "y".repeat(GMAIL_READ_BODY_MAX_CHARS);
    const { fetch: fetchAtCeiling } = readFetch({
      id: "m6",
      payload: {
        mimeType: "text/plain",
        headers: HEADERS,
        body: { data: b64url(atCeiling) },
      },
    });
    const exact = await executeGmailGet(
      "ya29.t",
      { messageId: "m6" },
      fetchAtCeiling,
    );
    expect(exact.body).toBe(atCeiling);
  });

  it("never leaves a lone surrogate at the truncation boundary", async () => {
    // An astral character (two UTF-16 code units) straddling the ceiling
    // must be dropped whole, not cut into a lone high surrogate.
    const straddling =
      "x".repeat(GMAIL_READ_BODY_MAX_CHARS - 1) + "😀" + "y".repeat(100);
    const { fetch } = readFetch({
      id: "m7",
      payload: {
        mimeType: "text/plain",
        headers: HEADERS,
        body: { data: b64url(straddling) },
      },
    });

    const result = await executeGmailGet("ya29.t", { messageId: "m7" }, fetch);

    const kept = result.body.slice(0, result.body.indexOf("\n[..."));
    expect(kept).toBe("x".repeat(GMAIL_READ_BODY_MAX_CHARS - 1));
    // The omitted count reflects the actual cut (emoji's 2 units + tail).
    expect(result.body).toContain(
      `[... body truncated: 102 of ${String(straddling.length)} characters omitted]`,
    );
  });

  it("throws GmailApiError with the failing id on a non-ok response", async () => {
    const { fetch } = readFetch({}, 404);

    await expect(
      executeGmailGet("ya29.t", { messageId: "missing" }, fetch),
    ).rejects.toThrow(GmailApiError);
    await expect(
      executeGmailGet("ya29.t", { messageId: "missing" }, fetch),
    ).rejects.toThrow("Gmail read failed (404): missing");
  });
});

describe("GMAIL_READ tool", () => {
  it("is governed as (gmail, read) with the constant account sentinel noun", () => {
    expect(GMAIL_READ.service).toBe("gmail");
    expect(GMAIL_READ.verb).toBe("read");
    // The sentinel: constant per call, not the
    // message id (audited as metadata), not "*" (survives wildcard-allow
    // hardening), and never collidable with a label noun.
    expect(GMAIL_READ.nounExtractor({ messageId: "m1" })).toBe("mailbox");
    expect(GMAIL_READ.nounExtractor({})).toBe("mailbox");
  });

  it("declares the read capability's satisfying scopes", () => {
    expect(GMAIL_READ.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.read);
    expect(GMAIL_READ.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    // The umbrella scope (full mailbox access) is never requested but must
    // satisfy every capability — the broadest grant cannot read as a gap.
    expect(GMAIL_READ.requiredScopes).toContain("https://mail.google.com/");
  });

  it("fails without a credential", async () => {
    const result = await GMAIL_READ.execute({ messageId: "m1" }, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No credential found");
  });

  it("rejects a missing or empty messageId as an input error", async () => {
    const ctx = {
      userId: "u1",
      credential: {
        access_token: "tok",
        refresh_token: "r",
        expiry_unix: 4102444800,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    };

    for (const params of [{}, { messageId: "" }, { messageId: 42 }]) {
      const result = await GMAIL_READ.execute(params as Record<string, unknown>, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("messageId must be a non-empty string");
    }
  });
});
