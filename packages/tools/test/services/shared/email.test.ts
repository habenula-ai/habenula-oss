import { describe, it, expect } from "vitest";
import {
  assertEmailListParams,
  emailListCapability,
  EMAIL_LIST_MAX_RESULTS_CEILING,
  type EmailListParams,
} from "../../../src/services/shared/email";
import { makeCredential } from "../../helpers/credential";

// The default scopes pass the mock's and gmail's read-capability gates.
const CREDENTIAL = makeCredential();

const CTX = { userId: "user-1", credential: CREDENTIAL };

// A representative per-service vocabulary for the builder tests. The label
// vocabulary is now owned by each service, not the shared module, so the
// tests declare their own the way gmail and mock_email do.
const LABELS = ["INBOX", "SENT", "DRAFTS"] as const;
type TestLabel = (typeof LABELS)[number];

/**
 * Build a tool over the standard test vocabulary where only the execute body
 * matters. The wiring test below constructs its tool explicitly — it asserts
 * the service and description fields this helper hardcodes.
 */
function makeTool(
  execute: (
    token: string,
    params: EmailListParams<TestLabel>,
  ) => Promise<unknown> | unknown,
) {
  return emailListCapability({
    service: "svc",
    labels: LABELS,
    defaultLabel: "INBOX",
    description: "d",
    execute,
  });
}

describe("emailListCapability", () => {
  it("wires the shared tool surface: verb, schema, noun extractor", () => {
    const tool = emailListCapability({
      service: "svc",
      labels: LABELS,
      defaultLabel: "INBOX",
      description: "a test list tool",
      execute: () => ({ messages: [] }),
    });

    expect(tool.service).toBe("svc");
    expect(tool.verb).toBe("list");
    expect(tool.description).toBe("a test list tool");
    expect(typeof tool.nounExtractor).toBe("function");
    // The noun extractor audits the service default for an omitted label and
    // echoes an explicit one.
    expect(tool.nounExtractor!({})).toBe("INBOX");
    expect(tool.nounExtractor!({ label: "SENT" })).toBe("SENT");
  });

  it("derives the schema from the service's own vocabulary", () => {
    // The schema is what the model sees; keep its machine-readable
    // constraints in lockstep with the builder's runtime validation and the
    // service's label set.
    const tool = makeTool(() => ({ messages: [] }));

    expect(tool.inputSchema.properties.label).toMatchObject({
      enum: [...LABELS],
    });
    expect(tool.inputSchema.properties.maxResults).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: EMAIL_LIST_MAX_RESULTS_CEILING,
    });
  });

  it("carries a wider vocabulary through to the schema and validation", () => {
    // A service that accepts more mailboxes gets them in its schema enum and
    // its execute path — the vocabulary is per-service, not a shared enum.
    const WIDE = ["INBOX", "STARRED", "TRASH"] as const;
    let seenLabel: string | undefined;
    const tool = emailListCapability({
      service: "wide",
      labels: WIDE,
      defaultLabel: "INBOX",
      description: "wide vocab",
      execute: (_token, params) => {
        seenLabel = params.label;
        return { messages: [] };
      },
    });

    expect(tool.inputSchema.properties.label).toMatchObject({
      enum: [...WIDE],
    });

    // STARRED is out of the mock's set but in this service's — it must run.
    return tool.execute({ label: "STARRED", maxResults: 3 }, CTX).then((r) => {
      expect(r).toEqual({ success: true, data: { messages: [] } });
      expect(seenLabel).toBe("STARRED");
    });
  });

  it("returns the standard no-credential failure without running execute", async () => {
    let ran = false;
    const tool = makeTool(() => {
      ran = true;
      return {};
    });

    const result = await tool.execute({}, { userId: "user-1" });

    expect(result).toEqual({
      success: false,
      error: "No credential found for service: svc",
    });
    expect(ran).toBe(false);
  });

  it("passes the token and exactly the two cast params to execute", async () => {
    let seenToken: string | undefined;
    let seenParams: EmailListParams<TestLabel> | undefined;
    const tool = makeTool((token, params) => {
      seenToken = token;
      seenParams = params;
      return { messages: [] };
    });

    // Extra LLM-invented fields must not be forwarded to the execute body.
    const result = await tool.execute(
      { label: "SENT", maxResults: 3, invented: "field" },
      CTX,
    );

    expect(result).toEqual({ success: true, data: { messages: [] } });
    expect(seenToken).toBe("test-access-token");
    expect(seenParams).toEqual({ label: "SENT", maxResults: 3 });
  });

  it("applies the service defaults for omitted or null params", async () => {
    // The noun extractor's ?? governs and audits an omitted or null label as
    // the service default (INBOX here), so the execute body must receive the
    // same defaults — null and omitted are equivalent.
    for (const input of [{}, { label: null, maxResults: null }]) {
      let seenParams: EmailListParams<TestLabel> | undefined;
      const tool = makeTool((_token, params) => {
        seenParams = params;
        return { messages: [] };
      });

      const result = await tool.execute(input, CTX);

      expect(result).toEqual({ success: true, data: { messages: [] } });
      expect(seenParams).toEqual({ label: "INBOX", maxResults: 5 });
    }
  });

  it("rejects a label outside the service vocabulary without running execute", async () => {
    let ran = false;
    const tool = makeTool(() => {
      ran = true;
      return {};
    });

    // Non-strings and mailboxes outside this service's set alike must fail as
    // input errors. "SPAM" is outside the test vocabulary (though a valid
    // Gmail label); "inbox" is case-mismatched.
    for (const bad of [42, "SPAM", "inbox"]) {
      const result = await tool.execute({ label: bad }, CTX);
      expect(result).toEqual({
        success: false,
        error: "Invalid parameter: label must be one of INBOX, SENT, DRAFTS",
      });
    }
    expect(ran).toBe(false);
  });

  it("rejects out-of-range maxResults as an input error without running execute", async () => {
    let ran = false;
    const tool = makeTool(() => {
      ran = true;
      return {};
    });

    // A string would flow to NaN math; a negative would flip slice() semantics;
    // a float would silently truncate; above the ceiling gmail would silently
    // return fewer than asked. All must fail as input errors instead.
    for (const bad of ["abc", -1, 0, 2.5, EMAIL_LIST_MAX_RESULTS_CEILING + 1]) {
      const result = await tool.execute({ maxResults: bad }, CTX);
      expect(result).toEqual({
        success: false,
        error: `Invalid parameter: maxResults must be an integer between 1 and ${EMAIL_LIST_MAX_RESULTS_CEILING}`,
      });
    }
    expect(ran).toBe(false);
  });

  it("wraps a sync execute result in { success: true, data }", async () => {
    const tool = makeTool(() => ({ messages: [{ subject: "hi" }] }));

    const result = await tool.execute({}, CTX);

    expect(result).toEqual({
      success: true,
      data: { messages: [{ subject: "hi" }] },
    });
  });

  it("wraps a thrown Error into { success: false, error: message }", async () => {
    const tool = makeTool(async () => {
      throw new Error("Gmail list failed (500)");
    });

    const result = await tool.execute({}, CTX);

    expect(result).toEqual({
      success: false,
      error: "Gmail list failed (500)",
    });
  });

  it("wraps a non-Error throw into the generic failure message", async () => {
    const tool = makeTool(() => {
      throw "boom";
    });

    const result = await tool.execute({}, CTX);

    expect(result).toEqual({
      success: false,
      error: "Tool execution failed",
    });
  });
});

describe("assertEmailListParams", () => {
  it("accepts every label in the given vocabulary across the maxResults range", () => {
    for (const label of LABELS) {
      for (const maxResults of [1, EMAIL_LIST_MAX_RESULTS_CEILING]) {
        expect(() =>
          assertEmailListParams({ label, maxResults }, LABELS),
        ).not.toThrow();
      }
    }
  });

  it("validates against the vocabulary it is handed, not a shared one", () => {
    // A label valid for a wider service passes there and fails against a
    // narrower set — the guard has no global vocabulary of its own.
    expect(() =>
      assertEmailListParams(
        { label: "STARRED", maxResults: 5 },
        ["INBOX", "STARRED"] as const,
      ),
    ).not.toThrow();
    expect(() =>
      assertEmailListParams(
        { label: "STARRED", maxResults: 5 } as unknown as EmailListParams<
          (typeof LABELS)[number]
        >,
        LABELS,
      ),
    ).toThrow("Unknown mailbox label: STARRED");
  });

  it("throws for a label outside the given vocabulary", () => {
    // Deliberately violates the label type to exercise the runtime guard.
    // "constructor" pins the prototype-key case: a plain object lookup would
    // resolve it to an inherited function instead of rejecting it.
    for (const label of ["SPAM", "constructor"]) {
      expect(() =>
        assertEmailListParams(
          { label, maxResults: 5 } as unknown as EmailListParams<TestLabel>,
          LABELS,
        ),
      ).toThrow(`Unknown mailbox label: ${label}`);
    }
  });

  it("throws for an out-of-range maxResults", () => {
    // undefined would flow to NaN math in the gmail URL and slice(0, undefined)
    // would return a whole mailbox in the mock — the direct-caller failure
    // modes the guard exists to make loud.
    for (const maxResults of [
      undefined,
      NaN,
      "5",
      0,
      -1,
      2.5,
      EMAIL_LIST_MAX_RESULTS_CEILING + 1,
    ]) {
      expect(() =>
        assertEmailListParams(
          {
            label: "INBOX",
            maxResults,
          } as unknown as EmailListParams<TestLabel>,
          LABELS,
        ),
      ).toThrow(`Invalid maxResults: ${String(maxResults)}`);
    }
  });
});
