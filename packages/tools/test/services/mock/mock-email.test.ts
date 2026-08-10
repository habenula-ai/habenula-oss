import { describe, it, expect } from "vitest";
import {
  executeMockEmailList,
  executeMockEmailSearch,
  executeMockEmailSend,
  MOCK_EMAIL_SEARCH,
  MOCK_EMAIL_SEND,
  mockEmail,
} from "../../../src/services/mock/mock-email";
import { EMAIL_LIST_MAX_RESULTS_CEILING } from "../../../src/services/shared/email";

function isIso8601(s: string): boolean {
  return !isNaN(Date.parse(s)) && s.includes("T");
}

describe("executeMockEmailList", () => {
  it("returns messages with correct shape", () => {
    const result = executeMockEmailList({ label: "INBOX", maxResults: 5 });

    expect(result.messages.length).toBeGreaterThan(0);
    for (const msg of result.messages) {
      expect(typeof msg.subject).toBe("string");
      expect(msg.subject.length).toBeGreaterThan(0);
      expect(typeof msg.sender).toBe("string");
      expect(msg.sender.length).toBeGreaterThan(0);
      expect(typeof msg.timestamp).toBe("string");
      expect(isIso8601(msg.timestamp)).toBe(true);
    }
  });

  it("holds at least 5 INBOX messages so the default page is full", () => {
    const result = executeMockEmailList({
      label: "INBOX",
      maxResults: EMAIL_LIST_MAX_RESULTS_CEILING,
    });

    expect(result.messages.length).toBeGreaterThanOrEqual(5);
  });

  it("returns different data for INBOX vs SENT vs DRAFTS", () => {
    const inbox = executeMockEmailList({ label: "INBOX", maxResults: 5 });
    const sent = executeMockEmailList({ label: "SENT", maxResults: 5 });
    const drafts = executeMockEmailList({ label: "DRAFTS", maxResults: 5 });

    // Different labels have different subjects
    const inboxSubjects = inbox.messages.map((m) => m.subject);
    const sentSubjects = sent.messages.map((m) => m.subject);
    const draftsSubjects = drafts.messages.map((m) => m.subject);

    expect(inboxSubjects).not.toEqual(sentSubjects);
    expect(inboxSubjects).not.toEqual(draftsSubjects);
    expect(sentSubjects).not.toEqual(draftsSubjects);
  });

  it("respects maxResults — returns at most N messages", () => {
    const result = executeMockEmailList({ label: "INBOX", maxResults: 2 });

    expect(result.messages).toHaveLength(2);
  });

  it("returns all messages when maxResults exceeds available data", () => {
    const result = executeMockEmailList({
      label: "DRAFTS",
      maxResults: EMAIL_LIST_MAX_RESULTS_CEILING,
    });

    // DRAFTS has 3 messages — should return all of them
    expect(result.messages).toHaveLength(3);
  });

  it("rejects invalid params via the shared guard", () => {
    // One deliberately-invalid input (cast past EmailListParams) proves the
    // executor wires assertEmailListParams; the guard's full input matrix is
    // pinned in test/services/shared/email.test.ts.
    expect(() =>
      executeMockEmailList(
        { label: "NONEXISTENT" } as unknown as Parameters<
          typeof executeMockEmailList
        >[0],
      ),
    ).toThrow("Unknown mailbox label: NONEXISTENT");
  });
});

describe("executeMockEmailSearch", () => {
  it("matches bare terms against subject and sender, case-insensitively", () => {
    const bySubject = executeMockEmailSearch({ q: "amazon", maxResults: 5 });
    expect(bySubject.messages.length).toBeGreaterThan(0);
    for (const msg of bySubject.messages) {
      expect(
        msg.subject.toLowerCase().includes("amazon") ||
          msg.sender.toLowerCase().includes("amazon"),
      ).toBe(true);
    }

    const bySender = executeMockEmailSearch({ q: "PRIYA.CHEN", maxResults: 5 });
    expect(bySender.messages.length).toBeGreaterThan(0);
    expect(bySender.messages[0]!.sender).toContain("priya.chen");
  });

  it("requires every term to match", () => {
    const result = executeMockEmailSearch({
      q: "amazon dentist",
      maxResults: 5,
    });
    expect(result.messages).toEqual([]);
  });

  it("narrows to a mock mailbox on an in:/label: filter", () => {
    // "Re: Q2 planning doc" exists in both INBOX (from a teammate) and SENT
    // (from me); the filter must confine the match to one mailbox.
    const sentOnly = executeMockEmailSearch({ q: "in:sent q2", maxResults: 5 });
    expect(sentOnly.messages.length).toBeGreaterThan(0);
    for (const msg of sentOnly.messages) {
      expect(msg.sender).toBe("me");
    }
  });

  it("narrows in:drafts to the DRAFTS mailbox via the shared DRAFT noun token", () => {
    const drafts = executeMockEmailSearch({ q: "in:drafts", maxResults: 5 });
    expect(drafts.messages.length).toBeGreaterThan(0);
    expect(drafts.messages[0]!.subject).toContain("Blog post draft");
  });

  it("returns nothing for a mailbox filter the mock does not hold — the searched set never exceeds the governed noun", () => {
    // These queries noun as STARRED / SPAM / label:receipts. Ignoring the
    // filter would search INBOX+SENT+DRAFTS under a narrower consent; the
    // honest mock behavior is an empty (unheld) mailbox.
    for (const q of ["is:starred amazon", "in:spam amazon", "label:receipts amazon"]) {
      expect(executeMockEmailSearch({ q, maxResults: 5 }).messages).toEqual([]);
    }
  });

  it("drops non-mailbox status operators instead of matching them as terms", () => {
    // is:unread contributes no noun and the mock holds no read-state — it
    // must neither narrow the searched set nor become a required term.
    const result = executeMockEmailSearch({
      q: "is:unread amazon",
      maxResults: 5,
    });
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("honors from: and subject: against the fields the mock holds", () => {
    const bySender = executeMockEmailSearch({
      q: "from:priya.chen",
      maxResults: 5,
    });
    expect(bySender.messages.length).toBeGreaterThan(0);
    for (const msg of bySender.messages) {
      expect(msg.sender).toContain("priya.chen");
    }

    // "q2" appears in a SENT subject from "me"; from:marcus must exclude it.
    const crossField = executeMockEmailSearch({
      q: "from:marcus q2",
      maxResults: 5,
    });
    expect(crossField.messages.length).toBeGreaterThan(0);
    for (const msg of crossField.messages) {
      expect(msg.sender).toContain("marcus");
    }

    const bySubject = executeMockEmailSearch({
      q: "subject:invoice",
      maxResults: 5,
    });
    expect(bySubject.messages.length).toBeGreaterThan(0);
    for (const msg of bySubject.messages) {
      expect(msg.subject.toLowerCase()).toContain("invoice");
    }
    // subject: must not match against the sender field.
    const senderOnlyTerm = executeMockEmailSearch({
      q: "subject:priya.chen",
      maxResults: 5,
    });
    expect(senderOnlyTerm.messages).toEqual([]);
  });

  it("searches all mailboxes when unfiltered and respects maxResults", () => {
    const all = executeMockEmailSearch({
      q: "re:",
      maxResults: EMAIL_LIST_MAX_RESULTS_CEILING,
    });
    // "Re:" subjects exist in INBOX, SENT, and DRAFTS.
    const senders = new Set(all.messages.map((m) => m.sender));
    expect(senders.size).toBeGreaterThan(1);

    const capped = executeMockEmailSearch({ q: "re:", maxResults: 2 });
    expect(capped.messages).toHaveLength(2);
  });

  it("treats an explicit in:anywhere like the unfiltered search (noun: anywhere)", () => {
    const anywhere = executeMockEmailSearch({
      q: "in:anywhere re:",
      maxResults: EMAIL_LIST_MAX_RESULTS_CEILING,
    });
    const unfiltered = executeMockEmailSearch({
      q: "re:",
      maxResults: EMAIL_LIST_MAX_RESULTS_CEILING,
    });
    expect(anywhere.messages).toEqual(unfiltered.messages);
  });

  it("widens to every mailbox when the query syntax cannot be narrowed (noun: anywhere)", () => {
    // `in:sent OR amazon` nouns as anywhere — the parse cannot prove the
    // searched set stays in SENT — so the mock searches everything, staying
    // within the widened claim. The OR token is syntax, never a term.
    const disjunctive = executeMockEmailSearch({
      q: "in:sent OR amazon",
      maxResults: 10,
    });
    const unfiltered = executeMockEmailSearch({ q: "amazon", maxResults: 10 });
    expect(disjunctive.messages).toEqual(unfiltered.messages);
    expect(disjunctive.messages.length).toBeGreaterThan(0);
  });
});

describe("MOCK_EMAIL_SEARCH tool", () => {
  it("is governed as (mock_email, search) with the shared noun resolver and mock scope", () => {
    expect(MOCK_EMAIL_SEARCH.service).toBe("mock_email");
    expect(MOCK_EMAIL_SEARCH.verb).toBe("search");
    expect(MOCK_EMAIL_SEARCH.requiredScopes).toEqual(["email.read"]);
    expect(MOCK_EMAIL_SEARCH.nounExtractor({ q: "in:inbox amazon" })).toBe("INBOX");
    expect(MOCK_EMAIL_SEARCH.nounExtractor({ q: "amazon" })).toBe("anywhere");
  });
});

describe("executeMockEmailSend", () => {
  it("returns a canned acknowledgement naming the envelope, transmitting nothing", () => {
    const result = executeMockEmailSend({
      to: ["alice@acme.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Hi there",
    });

    expect(result.id).toMatch(/^mock-sent-/);
    expect(result.threadId).toMatch(/^mock-thread-/);
    expect(result.to).toEqual(["alice@acme.com"]);
    expect(result.subject).toBe("Hello");
    expect(result.notice).toContain("no real email");
  });

  it("mints distinct ids across sends", () => {
    const envelope = {
      to: ["a@x.com"],
      cc: [],
      bcc: [],
      subject: "s",
      body: "b",
    };
    const first = executeMockEmailSend(envelope);
    const second = executeMockEmailSend(envelope);
    expect(second.id).not.toBe(first.id);
  });
});

describe("MOCK_EMAIL_SEND tool", () => {
  it("is governed as (mock_email, send) with the recipient-address noun and the mock send scope", () => {
    expect(MOCK_EMAIL_SEND.service).toBe("mock_email");
    expect(MOCK_EMAIL_SEND.verb).toBe("send");
    expect(MOCK_EMAIL_SEND.requiredScopes).toEqual(["email.send"]);
    expect(
      MOCK_EMAIL_SEND.nounExtractor({ to: ["a@acme.com", "b@other.com"] }),
    ).toBe("a@acme.com,b@other.com");
  });

  it("the mock connect scopes cover both read and send capabilities", () => {
    // The mock provider mints its credential from connect.scopes, so a
    // normally-connected mock passes both scope gates (mock parity).
    expect(mockEmail.connect).toEqual({
      type: "oauth",
      provider: "mock",
      scopes: ["email.read", "email.send"],
    });
  });
});
