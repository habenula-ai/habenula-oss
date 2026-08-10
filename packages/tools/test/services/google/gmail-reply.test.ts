import { describe, it, expect } from "vitest";
import {
  executeGmailReply,
  GMAIL_REPLY,
  GMAIL_CAPABILITY_SCOPES,
  type GmailReplyRequest,
} from "../../../src/services/google/gmail";

/** Decode Gmail's base64url `raw` back to the RFC 2822 text. */
function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function replyFetch() {
  const captured = { body: null as { raw: string; threadId?: string } | null };
  const fetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.body = JSON.parse(String(init?.body)) as {
      raw: string;
      threadId?: string;
    };
    return new Response(
      JSON.stringify({ id: "sent-2", threadId: "thread-9" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch, captured };
}

const REPLY: GmailReplyRequest = {
  threadId: "thread-9",
  inReplyTo: "msg-id-123@mail.gmail.com",
  to: ["alice@acme.com"],
  cc: [],
  bcc: [],
  subject: "Quarterly numbers",
  body: "Looks good.",
};

describe("executeGmailReply", () => {
  it("threads the reply: threadId in the payload, In-Reply-To/References headers, Re: subject", async () => {
    const { fetch, captured } = replyFetch();

    const result = await executeGmailReply("ya29.t", REPLY, fetch);

    expect(result).toEqual({ id: "sent-2", threadId: "thread-9" });
    expect(captured.body!.threadId).toBe("thread-9");

    const message = decodeRaw(captured.body!.raw);
    expect(message).toContain("In-Reply-To: <msg-id-123@mail.gmail.com>");
    expect(message).toContain("References: <msg-id-123@mail.gmail.com>");
    expect(message).toContain("Subject: Re: Quarterly numbers");
    expect(message).toContain("To: alice@acme.com");
  });

  it("neutralizes CRLF header injection via inReplyTo (which the recipient noun never sees)", async () => {
    // inReplyTo sets threading only and is excluded from the recipient-address
    // noun, so a reply grant for the recipients would authorize this
    // call. A CR/LF in the Message-ID must still not forge a Bcc header.
    const { fetch, captured } = replyFetch();

    await executeGmailReply(
      "ya29.t",
      { ...REPLY, inReplyTo: "<m@x>\r\nBcc: attacker@evil.com" },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    const headerLines = message.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
    // The poisoned value stays folded onto the In-Reply-To line.
    expect(
      headerLines.some(
        (line) =>
          line.startsWith("In-Reply-To:") &&
          line.includes("attacker@evil.com"),
      ),
    ).toBe(true);
  });

  it("keeps an existing Re: prefix and pre-bracketed Message-ID", async () => {
    const { fetch, captured } = replyFetch();

    await executeGmailReply(
      "ya29.t",
      { ...REPLY, subject: "RE: Quarterly numbers", inReplyTo: "<abc@x>" },
      fetch,
    );

    const message = decodeRaw(captured.body!.raw);
    expect(message).toContain("Subject: RE: Quarterly numbers");
    expect(message).not.toContain("Re: RE:");
    expect(message).toContain("In-Reply-To: <abc@x>");
    expect(message).not.toContain("<<abc@x>>");
  });
});

describe("GMAIL_REPLY tool", () => {
  const CTX = {
    userId: "u1",
    credential: {
      access_token: "tok",
      refresh_token: "r",
      expiry_unix: 4102444800,
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
    },
  };

  it("is its own (gmail, reply) subject sharing send's noun shape and capability", () => {
    expect(GMAIL_REPLY.service).toBe("gmail");
    expect(GMAIL_REPLY.verb).toBe("reply");
    expect(GMAIL_REPLY.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.send);
    // Recipients come from the reply's own params; threading ids never
    // enter the noun.
    expect(
      GMAIL_REPLY.nounExtractor({
        to: ["alice@acme.com"],
        threadId: "t",
        inReplyTo: "<m@other.com>",
      }),
    ).toBe("alice@acme.com");
  });

  it("rejects missing threading params as input errors before any fetch", async () => {
    const noThread = await GMAIL_REPLY.execute(
      { to: ["a@x.com"], inReplyTo: "<m@x>", subject: "s", body: "b" },
      CTX,
    );
    expect(noThread.success).toBe(false);
    expect(noThread.error).toContain("threadId");

    const noMsgId = await GMAIL_REPLY.execute(
      { to: ["a@x.com"], threadId: "t", subject: "s", body: "b" },
      CTX,
    );
    expect(noMsgId.success).toBe(false);
    expect(noMsgId.error).toContain("inReplyTo");
  });

  it("rejects an empty envelope like send does", async () => {
    const result = await GMAIL_REPLY.execute(
      { threadId: "t", inReplyTo: "<m@x>", subject: "s", body: "b" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("at least one recipient");
  });
});
