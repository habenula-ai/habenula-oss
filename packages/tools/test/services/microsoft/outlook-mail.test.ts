import { describe, it, expect } from "vitest";
import {
  outlookMail,
  outlookMailListExecute,
  OUTLOOK_MAIL_FOLDERS,
  OUTLOOK_MAIL_CAPABILITY_SCOPES,
  OUTLOOK_MAIL_SCOPES,
  OUTLOOK_MAIL_LIST,
  OUTLOOK_MAIL_READ,
  OUTLOOK_MAIL_SEARCH,
  OUTLOOK_MAIL_SEND,
} from "../../../src/services/microsoft/outlook-mail";
import { normalizeGraphScope } from "../../../src/services/microsoft/provider";
import { NO_RECIPIENTS_NOUN } from "../../../src/services/shared/recipients";

/**
 * The governed surface: what each Outlook tool nouns as, and that every
 * scope requirement comes from the capability map in the canonical form the
 * provider stores.
 */

describe("outlookMail service definition", () => {
  it("declares the microsoft provider with the wire-form scope set", () => {
    expect(outlookMail.service).toBe("outlook_mail");
    expect(outlookMail.connect).toEqual({
      type: "oauth",
      provider: "microsoft",
      scopes: OUTLOOK_MAIL_SCOPES,
    });
  });

  it("requests offline_access — without it Entra issues no refresh token", () => {
    expect(OUTLOOK_MAIL_SCOPES).toContain("offline_access");
  });

  it("requests least privilege: Mail.Read + Mail.Send, no User.Read, no ReadWrite", () => {
    expect(OUTLOOK_MAIL_SCOPES).toEqual([
      "offline_access",
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Mail.Send",
    ]);
  });

  it("exposes exactly the four Tier 1-2 mail verbs", () => {
    expect(outlookMail.tools.map((t) => t.verb)).toEqual([
      "list",
      "read",
      "search",
      "send",
    ]);
    for (const tool of outlookMail.tools) {
      expect(tool.service).toBe("outlook_mail");
    }
  });

  it("declares every capability scope in the provider's canonical form", () => {
    // The scope gate is exact-string membership: the map must declare the
    // same form normalizeGraphScope stores, or every Outlook tool fails
    // closed into a re-connect loop. Canonical form =
    // a fixed point of the normalizer.
    for (const scopes of Object.values(OUTLOOK_MAIL_CAPABILITY_SCOPES)) {
      for (const scope of scopes) {
        expect(normalizeGraphScope(scope)).toBe(scope);
      }
    }
  });

  it("covers read with mail.readwrite (broader covers narrower, forward-compat)", () => {
    expect(OUTLOOK_MAIL_CAPABILITY_SCOPES.read).toEqual([
      "mail.read",
      "mail.readwrite",
    ]);
    expect(OUTLOOK_MAIL_CAPABILITY_SCOPES.send).toEqual(["mail.send"]);
  });

  it("stores exactly what the exchange fixture grants — the gate's two sides agree", () => {
    // The end-to-end scope-form pin: the fixture's fully-qualified scopes
    // canonicalize to members of the capability map, so a connected
    // credential passes the gate for read and send.
    const granted = [
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Mail.Send",
    ].map(normalizeGraphScope);
    expect(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.read.some((s) => granted.includes(s)),
    ).toBe(true);
    expect(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.send.some((s) => granted.includes(s)),
    ).toBe(true);
  });
});

describe("OUTLOOK_MAIL_LIST", () => {
  it("nouns the folder listed, defaulting to inbox when omitted", () => {
    expect(OUTLOOK_MAIL_LIST.nounExtractor({ label: "sentitems" })).toBe(
      "sentitems",
    );
    expect(OUTLOOK_MAIL_LIST.nounExtractor({})).toBe("inbox");
    expect(OUTLOOK_MAIL_LIST.nounExtractor({ label: null })).toBe("inbox");
  });

  it("declares the read capability's scopes from the map", () => {
    expect(OUTLOOK_MAIL_LIST.requiredScopes).toEqual(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
    );
  });

  it("schema enum is exactly the folder vocabulary", () => {
    const labelSchema = OUTLOOK_MAIL_LIST.inputSchema.properties.label as {
      enum?: string[];
    };
    expect(labelSchema.enum).toEqual([...OUTLOOK_MAIL_FOLDERS]);
  });

  it("rejects an invalid explicit folder as an input error", async () => {
    const result = await OUTLOOK_MAIL_LIST.execute(
      { label: "INBOX" },
      {
        userId: "u1",
        credential: {
          access_token: "tok",
          refresh_token: "r",
          expiry_unix: 4102444800,
          scopes: ["mail.read"],
        },
      },
    );

    // Outlook's vocabulary is lowercase — Gmail's uppercase INBOX is not in
    // it, and an invalid label must fail as an input error, never reach
    // Graph.
    expect(result.success).toBe(false);
    expect(result.error).toContain("label must be one of");
  });
});

describe("outlookMailListExecute (direct-caller defense)", () => {
  it("re-asserts the vocabulary before calling the client", async () => {
    await expect(
      outlookMailListExecute("tok", {
        label: "not-a-folder" as never,
        maxResults: 5,
      }),
    ).rejects.toThrow("Unknown mailbox label");
    await expect(
      outlookMailListExecute("tok", { label: "inbox", maxResults: 0 }),
    ).rejects.toThrow("Invalid maxResults");
  });

  it("passes the folder verbatim to the Graph path (identity mapping)", async () => {
    // No DRAFTS → DRAFT style translation table: the vocabulary entry IS the
    // Graph path segment.
    const urls: string[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      urls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    for (const folder of OUTLOOK_MAIL_FOLDERS) {
      await outlookMailListExecute(
        "tok",
        { label: folder, maxResults: 5 },
        { fetchFn },
      );
      expect(urls.at(-1)).toContain(`/me/mailFolders/${folder}/messages`);
    }
  });
});

describe("OUTLOOK_MAIL_READ", () => {
  it("nouns the constant mailbox sentinel", () => {
    expect(OUTLOOK_MAIL_READ.nounExtractor({ messageId: "m1" })).toBe(
      "mailbox",
    );
    expect(OUTLOOK_MAIL_READ.nounExtractor({})).toBe("mailbox");
  });

  it("sentinel cannot collide: no well-known folder is named mailbox", () => {
    // Gmail's non-collision rests on uppercase system IDs; Outlook's
    // vocabulary is lowercase, so the property is re-derived here, not
    // inherited.
    expect(OUTLOOK_MAIL_FOLDERS).not.toContain("mailbox");
  });

  it("declares the read capability's scopes from the map", () => {
    expect(OUTLOOK_MAIL_READ.requiredScopes).toEqual(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
    );
  });

  it("points the model at outlook_mail_search ids", () => {
    expect(OUTLOOK_MAIL_READ.description).toContain("outlook_mail_search");
    expect(OUTLOOK_MAIL_READ.inputSchema.required).toEqual(["messageId"]);
  });

  it("fails without a credential", async () => {
    const result = await OUTLOOK_MAIL_READ.execute(
      { messageId: "m1" },
      { userId: "u1" },
    );

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
        scopes: ["mail.read"],
      },
    };

    for (const params of [{}, { messageId: "" }, { messageId: 42 }]) {
      const result = await OUTLOOK_MAIL_READ.execute(
        params as Record<string, unknown>,
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("messageId must be a non-empty string");
    }
  });
});

describe("OUTLOOK_MAIL_SEARCH", () => {
  it("nouns the constant anywhere — even for a query that looks narrowing", () => {
    // Graph $search is whole-mailbox with nothing for the resolver to
    // narrow on: a Gmail-shaped in:inbox filter must not mint a narrower
    // noun than the search actually reads (never under-claim).
    expect(OUTLOOK_MAIL_SEARCH.nounExtractor({ q: "in:inbox" })).toBe(
      "anywhere",
    );
    expect(OUTLOOK_MAIL_SEARCH.nounExtractor({ q: "from:alice" })).toBe(
      "anywhere",
    );
    expect(OUTLOOK_MAIL_SEARCH.nounExtractor({})).toBe("anywhere");
  });

  it("declares the read capability's scopes and Graph $search semantics", () => {
    expect(OUTLOOK_MAIL_SEARCH.requiredScopes).toEqual(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
    );
    const qSchema = OUTLOOK_MAIL_SEARCH.inputSchema.properties.q as {
      description?: string;
    };
    // Graph semantics, not Gmail syntax: no in:/label: vocabulary offered.
    expect(qSchema.description).toContain("$search");
    expect(qSchema.description).toContain("whole mailbox");
    expect(qSchema.description).not.toContain("Gmail");
  });
});

describe("OUTLOOK_MAIL_SEND", () => {
  it("reuses the shared recipient-address noun verbatim (cross-provider contract)", () => {
    // The same noun rule Gmail governs sends by — any change to the
    // recipient set changes the noun and re-confirms, on a non-Google
    // provider.
    expect(
      OUTLOOK_MAIL_SEND.nounExtractor({
        to: ["alice@acme.com"],
        cc: ["bob@partner.io"],
      }),
    ).toBe("alice@acme.com,bob@partner.io");
    expect(OUTLOOK_MAIL_SEND.nounExtractor({})).toBe(NO_RECIPIENTS_NOUN);
  });

  it("declares the send capability's scopes from the map", () => {
    expect(OUTLOOK_MAIL_SEND.requiredScopes).toEqual(
      OUTLOOK_MAIL_CAPABILITY_SCOPES.send,
    );
  });

  it("states acceptance-not-delivery in the model-facing description", () => {
    expect(OUTLOOK_MAIL_SEND.description).toContain("acceptance");
  });
});
