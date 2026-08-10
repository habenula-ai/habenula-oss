import { describe, it, expect } from "vitest";
import {
  emailSearchCapability,
  emailSearchNoun,
} from "../../../src/services/shared/email-search";
import { EMAIL_LIST_MAX_RESULTS_CEILING } from "../../../src/services/shared/email";
import type { EmailSearchParams } from "../../../src/services/shared/email-search";
import { makeCredential } from "../../helpers/credential";

/**
 * The search-`q` noun resolution table: system labels resolve to Gmail
 * label IDs, user labels
 * normalize to a prefixed token, no mailbox filter resolves to `anywhere`,
 * multiple filters sort-join.
 */
describe("emailSearchNoun", () => {
  const cases: [string, string][] = [
    // System labels resolve to their Gmail label ID
    ["in:inbox", "INBOX"],
    ["in:sent", "SENT"],
    ["in:drafts", "DRAFT"],
    ["in:spam", "SPAM"],
    ["in:trash", "TRASH"],
    ["is:starred", "STARRED"],
    ["is:important", "IMPORTANT"],
    ["label:inbox", "INBOX"],
    // Gmail's draft label id is singular DRAFT (same quirk as the list
    // vocabulary's DRAFTS → DRAFT mapping)
    ["label:drafts", "DRAFT"],
    // Case-insensitive operator values
    ["IN:INBOX", "INBOX"],
    ["from:alice In:Sent", "SENT"],
    // No mailbox filter → anywhere
    ["", "anywhere"],
    ["from:alice subject:invoice", "anywhere"],
    // An explicit in:anywhere is the unfiltered noun, not a user label —
    // and it subsumes any narrower filter beside it
    ["in:anywhere", "anywhere"],
    ["in:anywhere in:inbox", "anywhere"],
    // `is:` values that are status filters, not mailboxes, contribute nothing
    ["is:unread from:alice", "anywhere"],
    // Non-system (user) labels normalize to a prefixed lowercase token —
    // never resolvable to Label_<n> without a network call, and never able
    // to collide with the `read` sentinel (`mailbox`) or a system ID
    ["label:receipts", "label:receipts"],
    ["in:Receipts", "label:receipts"],
    ["label:mailbox", "label:mailbox"],
    // Multiple filters de-dupe and sort-join
    ["in:inbox is:starred", "INBOX,STARRED"],
    ["is:starred in:inbox", "INBOX,STARRED"],
    ["in:inbox in:inbox", "INBOX"],
    ["label:zeta label:alpha", "label:alpha,label:zeta"],
    // Disjunction defeats mailbox narrowing: `in:sent OR from:x` reads the
    // whole account, so the noun must over-claim to anywhere — a SENT grant
    // must never cover it. Any case counts as OR (Gmail documents uppercase
    // only; we don't bet a grant boundary on its leniency).
    ["in:sent OR from:ceo", "anywhere"],
    ["in:inbox or in:sent", "anywhere"],
    // `{}` is Gmail's other disjunction syntax — poisons wherever it appears
    ["{in:inbox in:spam}", "anywhere"],
    ["in:sent {from:a from:b}", "anywhere"],
    // A quoted/parenthesized mailbox-filter value resolves at Gmail after
    // unquoting (`in:"sent"` reads system SENT) — the tokenizer can't see
    // that, so it must not mint a user-label noun for it
    ['in:"sent"', "anywhere"],
    ['label:"my label"', "anywhere"],
    // ...but quoting in a NON-mailbox position narrows nothing and keeps
    // the precise noun
    ['in:inbox subject:"quarterly report"', "INBOX"],
    // Negation only ever narrows; it passes through untouched
    ["in:sent -from:bob", "SENT"],
  ];

  it.each(cases)("resolves %j to %j", (q, noun) => {
    expect(emailSearchNoun(q)).toBe(noun);
  });

  it("resolves a non-string q to anywhere (audited as sent; executor rejects)", () => {
    expect(emailSearchNoun(undefined)).toBe("anywhere");
    expect(emailSearchNoun(42)).toBe("anywhere");
  });
});

describe("emailSearchCapability", () => {
  function makeTool(execute: (token: string, params: EmailSearchParams) => unknown) {
    return emailSearchCapability({
      service: "test_email",
      description: "Search test messages.",
      requiredScopes: ["test.read"],
      execute,
    });
  }

  it("builds a (service, search) tool carrying the declared scopes and the shared noun resolver", () => {
    const tool = makeTool(() => ({ messages: [] }));

    expect(tool.service).toBe("test_email");
    expect(tool.verb).toBe("search");
    expect(tool.requiredScopes).toEqual(["test.read"]);
    expect(tool.inputSchema.required).toEqual(["q"]);
    expect(tool.nounExtractor({ q: "in:inbox" })).toBe("INBOX");
    expect(tool.nounExtractor({})).toBe("anywhere");
  });

  it("fails without a credential and never calls execute", async () => {
    let called = false;
    const tool = makeTool(() => {
      called = true;
      return {};
    });

    const result = await tool.execute({ q: "hello" }, { userId: "u1" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No credential found");
    expect(called).toBe(false);
  });

  it("rejects a missing or empty q as an input error before execute", async () => {
    let called = false;
    const tool = makeTool(() => {
      called = true;
      return {};
    });
    const ctx = {
      userId: "u1",
      credential: makeCredential({ scopes: ["test.read"] }),
    };

    for (const params of [{}, { q: "" }, { q: "   " }, { q: 42 }]) {
      const result = await tool.execute(params as Record<string, unknown>, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain("q must be a non-empty string");
    }
    expect(called).toBe(false);
  });

  it("applies the shared page-size default and rejects out-of-range maxResults", async () => {
    const seen: EmailSearchParams[] = [];
    const tool = makeTool((_token, params) => {
      seen.push(params);
      return {};
    });
    const ctx = {
      userId: "u1",
      credential: makeCredential({ scopes: ["test.read"] }),
    };

    await tool.execute({ q: "hello" }, ctx);
    expect(seen[0]!.maxResults).toBe(5);

    const tooBig = await tool.execute(
      { q: "hello", maxResults: EMAIL_LIST_MAX_RESULTS_CEILING + 1 },
      ctx,
    );
    expect(tooBig.success).toBe(false);
    expect(tooBig.error).toContain("maxResults must be an integer");

    const nan = await tool.execute({ q: "hello", maxResults: "many" }, ctx);
    expect(nan.success).toBe(false);
  });

  it("wraps a thrown execute error into { success: false, error }", async () => {
    const tool = makeTool(() => {
      throw new Error("provider exploded");
    });
    const ctx = {
      userId: "u1",
      credential: makeCredential({ scopes: ["test.read"] }),
    };

    const result = await tool.execute({ q: "hello" }, ctx);

    expect(result).toEqual({ success: false, error: "provider exploded" });
  });

  it("honors a supplied nounExtractor and qDescription override", () => {
    // A provider whose search language is not Gmail's (Outlook's Graph
    // $search) overrides the noun and the model-facing q description while
    // keeping the scaffolding.
    const tool = emailSearchCapability({
      service: "test_email",
      description: "Search test messages.",
      requiredScopes: ["test.read"],
      nounExtractor: () => "anywhere",
      qDescription: "Search query in provider syntax.",
      execute: () => ({ messages: [] }),
    });

    // Constant even for a query the Gmail resolver would narrow.
    expect(tool.nounExtractor({ q: "in:inbox" })).toBe("anywhere");
    const qSchema = tool.inputSchema.properties.q as {
      description?: string;
    };
    expect(qSchema.description).toBe("Search query in provider syntax.");
  });

  it("keeps its defaults byte-identical when the overrides are omitted", () => {
    // Gmail and the mock pass no overrides; their governed shape and schema
    // must be exactly what they were before the opts existed.
    const tool = makeTool(() => ({ messages: [] }));

    expect(tool.nounExtractor({ q: "in:inbox" })).toBe("INBOX");
    expect(tool.nounExtractor({ q: "from:alice" })).toBe("anywhere");
    const qSchema = tool.inputSchema.properties.q as {
      description?: string;
    };
    expect(qSchema.description).toBe(
      "Search query in Gmail query syntax, e.g. `from:alice subject:invoice in:inbox`. Supports from:, to:, subject:, in:, label:, is:, and bare terms.",
    );
  });
});
