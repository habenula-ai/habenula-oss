import { describe, it, expect } from "vitest";
import {
  emailSendCapability,
  normalizeEmailEnvelope,
  type EmailSendParams,
} from "../../../src/services/shared/email-send";
import { makeCredential } from "../../helpers/credential";

const CTX = {
  userId: "u1",
  credential: makeCredential({ scopes: ["test.send"] }),
};

describe("normalizeEmailEnvelope", () => {
  it("normalizes recipients and passes subject/body through", () => {
    const result = normalizeEmailEnvelope({
      to: ["a@x.com, b@y.com"],
      subject: "Hi",
      body: "Hello",
    });
    expect(result).toEqual({
      envelope: {
        to: ["a@x.com", "b@y.com"],
        cc: [],
        bcc: [],
        subject: "Hi",
        body: "Hello",
      },
    });
  });

  it("rejects an empty envelope, missing subject, and missing body", () => {
    expect(normalizeEmailEnvelope({ subject: "s", body: "b" })).toEqual({
      error: "Invalid parameter: to must contain at least one recipient",
    });
    expect(
      normalizeEmailEnvelope({ to: ["a@x.com"], subject: "  ", body: "b" }),
    ).toEqual({ error: "Invalid parameter: subject must be a non-empty string" });
    expect(
      normalizeEmailEnvelope({ to: ["a@x.com"], subject: "s", body: "" }),
    ).toEqual({ error: "Invalid parameter: body must be a non-empty string" });
    // A whitespace-only body is rejected too, symmetric with subject.
    expect(
      normalizeEmailEnvelope({ to: ["a@x.com"], subject: "s", body: "   \n" }),
    ).toEqual({ error: "Invalid parameter: body must be a non-empty string" });
  });
});

describe("emailSendCapability", () => {
  function makeTool(execute: (token: string, params: EmailSendParams) => unknown) {
    return emailSendCapability({
      service: "test_email",
      description: "Send a test message.",
      requiredScopes: ["test.send"],
      execute,
    });
  }

  it("builds a (service, send) tool with the recipient-address noun and declared scopes", () => {
    const tool = makeTool(() => ({}));

    expect(tool.service).toBe("test_email");
    expect(tool.verb).toBe("send");
    expect(tool.requiredScopes).toEqual(["test.send"]);
    expect(tool.inputSchema.required).toEqual(["to", "subject", "body"]);
    expect(
      tool.nounExtractor({ to: ["a@acme.com"], cc: ["b@other.com"] }),
    ).toBe("a@acme.com,b@other.com");
  });

  it("fails without a credential and never calls execute", async () => {
    let called = false;
    const tool = makeTool(() => {
      called = true;
      return {};
    });

    const result = await tool.execute(
      { to: ["a@x.com"], subject: "s", body: "b" },
      { userId: "u1" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No credential found");
    expect(called).toBe(false);
  });

  it("rejects an invalid envelope as an input error before execute", async () => {
    let called = false;
    const tool = makeTool(() => {
      called = true;
      return {};
    });

    const result = await tool.execute({ subject: "s", body: "b" }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain("at least one recipient");
    expect(called).toBe(false);
  });

  it("hands execute the normalized envelope — the same recipients the noun governed", async () => {
    const seen: EmailSendParams[] = [];
    const tool = makeTool((_token, params) => {
      seen.push(params);
      return { ok: true };
    });

    const params = {
      to: ["Alice <a@acme.com>", "b@acme.com"],
      bcc: ["c@other.com"],
      subject: "s",
      body: "b",
    };
    const result = await tool.execute(params, CTX);

    expect(result.success).toBe(true);
    expect(seen[0]!.to).toEqual(["Alice <a@acme.com>", "b@acme.com"]);
    expect(seen[0]!.bcc).toEqual(["c@other.com"]);
    // One source read twice: the governed noun covers exactly the addresses
    // the envelope transmits to.
    expect(tool.nounExtractor(params)).toBe(
      "a@acme.com,b@acme.com,c@other.com",
    );
  });

  it("wraps a thrown execute error into { success: false, error }", async () => {
    const tool = makeTool(() => {
      throw new Error("smtp exploded");
    });

    const result = await tool.execute(
      { to: ["a@x.com"], subject: "s", body: "b" },
      CTX,
    );

    expect(result).toEqual({ success: false, error: "smtp exploded" });
  });
});
