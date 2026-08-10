import { describe, it, expect } from "vitest";
import {
  executeGmailSend,
  GmailApiError,
  GMAIL_SEND,
  GMAIL_CAPABILITY_SCOPES,
  type GmailSendRequest,
} from "../../../src/services/google/gmail";

/** Decode Gmail's base64url `raw` back to the RFC 2822 text. */
function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Capture the send request; answer with a canned Gmail send response. */
function sendFetch(status = 200) {
  const captured = {
    url: "",
    method: "",
    headers: undefined as HeadersInit | undefined,
    body: null as { raw: string; threadId?: string } | null,
  };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.method = init?.method ?? "GET";
    captured.headers = init?.headers;
    captured.body = JSON.parse(String(init?.body)) as {
      raw: string;
      threadId?: string;
    };
    if (status !== 200) {
      return new Response("error", { status });
    }
    return new Response(
      JSON.stringify({ id: "sent-1", threadId: "thread-1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch, captured };
}

const ENVELOPE: GmailSendRequest = {
  to: ["alice@acme.com", "Bob <bob@acme.com>"],
  cc: ["carol@other.com"],
  bcc: ["dan@zeta.org"],
  subject: "Quarterly numbers",
  body: "Attached below.\nThanks!",
};

describe("executeGmailSend", () => {
  it("POSTs a base64url RFC 2822 raw message to messages/send with the bearer token", async () => {
    const { fetch, captured } = sendFetch();

    const result = await executeGmailSend("ya29.send-token", ENVELOPE, fetch);

    expect(captured.url).toContain("/messages/send");
    expect(captured.method).toBe("POST");
    expect(captured.headers).toMatchObject({
      Authorization: "Bearer ya29.send-token",
    });
    expect(result).toEqual({ id: "sent-1", threadId: "thread-1" });

    const message = decodeRaw(captured.body!.raw);
    expect(message).toContain("To: alice@acme.com, Bob <bob@acme.com>");
    expect(message).toContain("Cc: carol@other.com");
    expect(message).toContain("Bcc: dan@zeta.org");
    expect(message).toContain("Subject: Quarterly numbers");
    expect(message).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(message.endsWith("\r\n\r\nAttached below.\nThanks!")).toBe(true);
    // A plain send is not threaded.
    expect(message).not.toContain("In-Reply-To");
    expect(captured.body!.threadId).toBeUndefined();
  });

  it("omits Cc/Bcc headers when empty", async () => {
    const { fetch, captured } = sendFetch();

    await executeGmailSend(
      "ya29.t",
      { to: ["a@x.com"], cc: [], bcc: [], subject: "s", body: "b" },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    expect(message).not.toContain("Cc:");
    expect(message).not.toContain("Bcc:");
  });

  it("neutralizes CRLF header injection in a recipient address", async () => {
    // A newline smuggled into an address must not break out of the To line
    // and forge a standalone Bcc header (RFC 2822 header injection).
    const { fetch, captured } = sendFetch();

    await executeGmailSend(
      "ya29.t",
      {
        to: ["alice@acme.com\r\nBcc: attacker@evil.com"],
        cc: [],
        bcc: [],
        subject: "s",
        body: "b",
      },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    const headerLines = message.split("\r\n\r\n")[0]!.split("\r\n");
    // No forged Bcc header line; the value is folded onto the To line instead.
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(headerLines[0]).toContain("attacker@evil.com");
  });

  it("RFC 2047-encodes a non-ASCII subject", async () => {
    const { fetch, captured } = sendFetch();

    await executeGmailSend(
      "ya29.t",
      { to: ["a@x.com"], cc: [], bcc: [], subject: "Résumé — città", body: "b" },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    expect(message).toContain("Subject: =?UTF-8?B?");
  });

  it("RFC 2047-encodes a non-ASCII display name but leaves the addr-spec verbatim", async () => {
    const { fetch, captured } = sendFetch();

    await executeGmailSend(
      "ya29.t",
      {
        to: ["Résumé <resume@acme.com>"],
        cc: ["Plain Name <plain@acme.com>"],
        bcc: [],
        subject: "s",
        body: "b",
      },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    const toLine = message
      .split("\r\n")
      .find((line) => line.startsWith("To:"))!;
    // The header stays 7-bit ASCII: the display name is an encoded-word, the
    // address is untouched, and no raw non-ASCII byte leaks into the header.
    expect(toLine).toMatch(/^To: =\?UTF-8\?B\?[^ ]+\?= <resume@acme.com>$/);
    expect(toLine).not.toContain("Résumé");
    // An all-ASCII display name is left exactly as authored (no encoding).
    expect(message).toContain("Cc: Plain Name <plain@acme.com>");
  });

  it("throws GmailApiError on a non-ok response", async () => {
    const { fetch } = sendFetch(403);

    await expect(executeGmailSend("ya29.t", ENVELOPE, fetch)).rejects.toThrow(
      GmailApiError,
    );
    await expect(executeGmailSend("ya29.t", ENVELOPE, fetch)).rejects.toThrow(
      "Gmail send failed (403)",
    );
  });
});

describe("GMAIL_SEND tool", () => {
  it("is governed as (gmail, send) with the recipient-address noun and the send capability", () => {
    expect(GMAIL_SEND.service).toBe("gmail");
    expect(GMAIL_SEND.verb).toBe("send");
    expect(GMAIL_SEND.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.send);
    expect(GMAIL_SEND.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    // gmail.modify and gmail.compose both cover send (overlapping supersets).
    expect(GMAIL_SEND.requiredScopes).toContain(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(
      GMAIL_SEND.nounExtractor({ to: ["a@acme.com"], bcc: ["b@other.com"] }),
    ).toBe("a@acme.com,b@other.com");
  });

  it("fails without a credential and rejects an empty envelope", async () => {
    const noCred = await GMAIL_SEND.execute(
      { to: ["a@x.com"], subject: "s", body: "b" },
      { userId: "u1" },
    );
    expect(noCred.success).toBe(false);
    expect(noCred.error).toContain("No credential found");

    const empty = await GMAIL_SEND.execute(
      { subject: "s", body: "b" },
      {
        userId: "u1",
        credential: {
          access_token: "tok",
          refresh_token: "r",
          expiry_unix: 4102444800,
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
        },
      },
    );
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("at least one recipient");
  });
});
