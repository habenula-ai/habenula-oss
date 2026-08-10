import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  executeGmailModify,
  executeGmailTrash,
  GmailApiError,
  GMAIL_ARCHIVE,
  GMAIL_MARK_READ,
  GMAIL_LABEL,
  GMAIL_TRASH,
  GMAIL_CAPABILITY_SCOPES,
  NO_LABELS_NOUN,
} from "../../../src/services/google/gmail";

const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const CTX = {
  userId: "u1",
  credential: {
    access_token: "ya29.hygiene-token",
    refresh_token: "r",
    expiry_unix: 4102444800,
    scopes: [MODIFY_SCOPE],
  },
};

/** Capture the mutation request; answer with a canned modified message. */
function mutationFetch(status = 200) {
  const captured = {
    url: "",
    method: "",
    body: null as { addLabelIds?: string[]; removeLabelIds?: string[] } | null,
  };
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof input === "string" ? input : input.toString();
    captured.method = init?.method ?? "GET";
    captured.body = init?.body
      ? (JSON.parse(String(init.body)) as {
          addLabelIds?: string[];
          removeLabelIds?: string[];
        })
      : null;
    if (status !== 200) {
      return new Response("error", { status });
    }
    return new Response(
      JSON.stringify({ id: "m1", labelIds: ["SENT"] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch, captured };
}

describe("executeGmailModify / executeGmailTrash", () => {
  it("POSTs add/remove label ids to messages/{id}/modify", async () => {
    const { fetch, captured } = mutationFetch();

    const result = await executeGmailModify(
      "ya29.t",
      { messageId: "m1", addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
      fetch,
    );

    expect(captured.url).toContain("/messages/m1/modify");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });
    expect(result).toEqual({ id: "m1", labelIds: ["SENT"] });
  });

  it("POSTs to messages/{id}/trash with no body", async () => {
    const { fetch, captured } = mutationFetch();

    await executeGmailTrash("ya29.t", { messageId: "m1" }, fetch);

    expect(captured.url).toContain("/messages/m1/trash");
    expect(captured.method).toBe("POST");
    expect(captured.body).toBeNull();
  });

  it("throws GmailApiError with the failing id on non-ok responses", async () => {
    const { fetch } = mutationFetch(404);
    await expect(
      executeGmailModify(
        "ya29.t",
        { messageId: "gone", addLabelIds: [], removeLabelIds: ["INBOX"] },
        fetch,
      ),
    ).rejects.toThrow(GmailApiError);
    await expect(
      executeGmailModify(
        "ya29.t",
        { messageId: "gone", addLabelIds: [], removeLabelIds: ["INBOX"] },
        fetch,
      ),
    ).rejects.toThrow("Gmail modify failed (404): gone");
    await expect(
      executeGmailTrash("ya29.t", { messageId: "gone" }, fetch),
    ).rejects.toThrow("Gmail trash failed (404): gone");
  });
});

describe("fixed-target mutation tools (archive / mark_read / trash)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("each is its own verb with the constant label noun it is defined as mutating", () => {
    expect(GMAIL_ARCHIVE.verb).toBe("archive");
    expect(GMAIL_ARCHIVE.nounExtractor({ messageId: "m1" })).toBe("INBOX");
    expect(GMAIL_MARK_READ.verb).toBe("mark_read");
    expect(GMAIL_MARK_READ.nounExtractor({ messageId: "m1" })).toBe("UNREAD");
    expect(GMAIL_TRASH.verb).toBe("trash");
    expect(GMAIL_TRASH.nounExtractor({ messageId: "m1" })).toBe("TRASH");
  });

  it("archive/mark_read/label need the modify-labels capability; trash the trash capability", () => {
    for (const tool of [GMAIL_ARCHIVE, GMAIL_MARK_READ, GMAIL_LABEL]) {
      expect(tool.requiredScopes).toEqual(
        GMAIL_CAPABILITY_SCOPES["modify-labels"],
      );
    }
    expect(GMAIL_TRASH.requiredScopes).toEqual(GMAIL_CAPABILITY_SCOPES.trash);
    // Of the requestable scopes, only gmail.modify covers the mutations —
    // Gmail has no narrower hygiene scope. The unrequested full-access
    // umbrella also counts: a credential is judged by what it holds.
    for (const capability of ["modify-labels", "trash"] as const) {
      expect(GMAIL_CAPABILITY_SCOPES[capability]).toEqual([
        MODIFY_SCOPE,
        "https://mail.google.com/",
      ]);
    }
  });

  it("archive removes INBOX and mark_read removes UNREAD — exactly, via modify", async () => {
    const archive = mutationFetch();
    globalThis.fetch = archive.fetch;
    const result = await GMAIL_ARCHIVE.execute({ messageId: "m1" }, CTX);
    expect(result.success).toBe(true);
    expect(archive.captured.url).toContain("/messages/m1/modify");
    expect(archive.captured.body).toEqual({
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });

    const markRead = mutationFetch();
    globalThis.fetch = markRead.fetch;
    await GMAIL_MARK_READ.execute({ messageId: "m1" }, CTX);
    expect(markRead.captured.body).toEqual({
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    });

    const trash = mutationFetch();
    globalThis.fetch = trash.fetch;
    await GMAIL_TRASH.execute({ messageId: "m1" }, CTX);
    expect(trash.captured.url).toContain("/messages/m1/trash");
  });

  it("rejects a missing or empty messageId as an input error", async () => {
    for (const tool of [GMAIL_ARCHIVE, GMAIL_MARK_READ, GMAIL_TRASH]) {
      const result = await tool.execute({}, CTX);
      expect(result.success).toBe(false);
      expect(result.error).toContain("messageId must be a non-empty string");
    }
  });
});

describe("GMAIL_LABEL", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("nouns the full set of labels being mutated — canonicalized, de-duped, sorted", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ messageId: "m1", addLabelIds: ["STARRED"] }, "STARRED"],
      // A system id canonicalizes to its uppercase form, case-insensitively.
      [{ messageId: "m1", addLabelIds: ["starred"] }, "STARRED"],
      // The display name "Drafts" is not the id (DRAFT), so it normalizes to
      // the prefixed token rather than being rewritten to a valid-looking id:
      // the executor forwards raw "Drafts", which Gmail rejects, so the noun
      // must record an unresolvable label, not consent to a real DRAFT
      // mutation that can never succeed. (Search's in:drafts → DRAFT is a
      // separate read-filter resolution, unaffected.)
      [{ messageId: "m1", addLabelIds: ["Drafts"] }, "label:drafts"],
      // A real user-label id passes verbatim (nouns
      // emit label IDs — INBOX, Label_<n> — never raw display names).
      [{ messageId: "m1", addLabelIds: ["Label_37"] }, "Label_37"],
      // A display name that is not an id normalizes to the prefixed token
      // (cannot collide with the read sentinel or a system id).
      [{ messageId: "m1", addLabelIds: ["Receipts"] }, "label:receipts"],
      // A valid system id outside the list vocabulary (Gmail's category/chat
      // labels) is still recognized and emits its real id — never a `label:`
      // token that would misrepresent it as a user label (audit fidelity).
      [
        { messageId: "m1", addLabelIds: ["CATEGORY_PROMOTIONS"] },
        "CATEGORY_PROMOTIONS",
      ],
      // Added and removed labels both count; the set sorts and de-dupes.
      [
        {
          messageId: "m1",
          addLabelIds: ["STARRED"],
          removeLabelIds: ["UNREAD", "starred"],
        },
        "STARRED,UNREAD",
      ],
      // No labels named → the fixed non-matching sentinel.
      [{ messageId: "m1" }, NO_LABELS_NOUN],
    ];
    for (const [params, noun] of cases) {
      expect(GMAIL_LABEL.nounExtractor(params)).toBe(noun);
    }
  });

  it("transmits the caller's label ids and rejects a label-less call", async () => {
    const mutation = mutationFetch();
    globalThis.fetch = mutation.fetch;
    const result = await GMAIL_LABEL.execute(
      { messageId: "m1", addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(mutation.captured.body).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD"],
    });

    const empty = await GMAIL_LABEL.execute({ messageId: "m1" }, CTX);
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("at least one of addLabelIds or removeLabelIds");
  });

  it("forwards a display name verbatim so Gmail (not the extractor) rejects it", async () => {
    // The noun canonicalizes "Receipts" to label:receipts for consent, but the
    // executor transmits the caller's raw value — the fail-closed guarantee
    // rests on Gmail rejecting a non-id, not on the extractor rewriting it.
    const mutation = mutationFetch();
    globalThis.fetch = mutation.fetch;
    await GMAIL_LABEL.execute(
      { messageId: "m1", addLabelIds: ["Receipts"] },
      CTX,
    );
    expect(mutation.captured.body).toEqual({
      addLabelIds: ["Receipts"],
      removeLabelIds: [],
    });
  });

  it("refuses the reserved system labels (TRASH / SPAM) before any request", async () => {
    // Trashing has its own verb (gmail_trash) and marking spam is not exposed;
    // routing either through `label` would collapse the consequence separation
    // the design keeps. Rejected as an
    // input error whatever the case, on add or remove, and never dispatched.
    const throwingFetch: typeof globalThis.fetch = () => {
      throw new Error("gmail_label reached the network for a reserved label");
    };
    globalThis.fetch = throwingFetch;
    const reservedCalls: Record<string, unknown>[] = [
      { messageId: "m1", addLabelIds: ["TRASH"] },
      { messageId: "m1", addLabelIds: ["trash"] },
      { messageId: "m1", removeLabelIds: ["TRASH"] },
      { messageId: "m1", addLabelIds: ["SPAM"] },
      { messageId: "m1", addLabelIds: ["STARRED", "Trash"] },
    ];
    for (const params of reservedCalls) {
      const result = await GMAIL_LABEL.execute(params, CTX);
      expect(result.success, JSON.stringify(params)).toBe(false);
      expect(result.error).toContain("cannot modify the");
    }
  });
});
