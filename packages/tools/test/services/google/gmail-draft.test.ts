import { describe, it, expect } from "vitest";
import {
  executeGmailDraft,
  GmailApiError,
  GMAIL_DRAFT,
  GMAIL_CAPABILITY_SCOPES,
  type GmailDraftRequest,
} from "../../../src/services/google/gmail";

/** Decode Gmail's base64url `raw` back to the RFC 2822 text. */
function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function draftFetch(status = 200) {
  const captured = {
    url: "",
    method: "",
    body: null as { message: { raw: string } } | null,
  };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.method = init?.method ?? "GET";
    captured.body = JSON.parse(String(init?.body)) as {
      message: { raw: string };
    };
    if (status !== 200) {
      return new Response("error", { status });
    }
    return new Response(
      JSON.stringify({
        id: "draft-1",
        message: { id: "msg-1", threadId: "thread-1" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch, captured };
}

const ENVELOPE: GmailDraftRequest = {
  to: ["alice@acme.com"],
  cc: [],
  bcc: [],
  subject: "Draft: numbers",
  body: "Working notes.",
};

describe("executeGmailDraft", () => {
  it("POSTs the raw RFC 2822 message to the drafts endpoint and maps the result", async () => {
    const { fetch, captured } = draftFetch();

    const result = await executeGmailDraft("ya29.t", ENVELOPE, fetch);

    expect(captured.url).toContain("/drafts");
    expect(captured.url).not.toContain("/messages/send");
    expect(captured.method).toBe("POST");
    expect(result).toEqual({
      id: "draft-1",
      messageId: "msg-1",
      threadId: "thread-1",
    });

    const message = decodeRaw(captured.body!.message.raw);
    expect(message).toContain("To: alice@acme.com");
    expect(message).toContain("Subject: Draft: numbers");
    expect(message.endsWith("\r\n\r\nWorking notes.")).toBe(true);
  });

  it("throws GmailApiError on a non-ok response", async () => {
    const { fetch } = draftFetch(403);
    await expect(executeGmailDraft("ya29.t", ENVELOPE, fetch)).rejects.toThrow(
      GmailApiError,
    );
    await expect(executeGmailDraft("ya29.t", ENVELOPE, fetch)).rejects.toThrow(
      "Gmail draft failed (403)",
    );
  });
});

describe("GMAIL_DRAFT tool", () => {
  it("is governed as (gmail, draft) with send's recipient-address noun shape and the draft capability", () => {
    expect(GMAIL_DRAFT.service).toBe("gmail");
    expect(GMAIL_DRAFT.verb).toBe("draft");
    expect(GMAIL_DRAFT.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.draft);
    // A draft is covered by compose or modify — but NOT by gmail.send: a
    // send-only credential cannot create drafts.
    expect(GMAIL_DRAFT.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(GMAIL_DRAFT.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(GMAIL_DRAFT.requiredScopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(
      GMAIL_DRAFT.nounExtractor({ to: ["a@acme.com"], cc: ["b@other.com"] }),
    ).toBe("a@acme.com,b@other.com");
  });

  it("fails without a credential and rejects an empty envelope", async () => {
    const noCred = await GMAIL_DRAFT.execute(
      { to: ["a@x.com"], subject: "s", body: "b" },
      { userId: "u1" },
    );
    expect(noCred.success).toBe(false);
    expect(noCred.error).toContain("No credential found");

    const empty = await GMAIL_DRAFT.execute(
      { subject: "s", body: "b" },
      {
        userId: "u1",
        credential: {
          access_token: "tok",
          refresh_token: "r",
          expiry_unix: 4102444800,
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
      },
    );
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("at least one recipient");
  });
});
