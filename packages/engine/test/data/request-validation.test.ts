import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import {
  ChatRequest,
  DisconnectServiceRequest,
  ResolveRequest,
  ToolExecuteRequest,
} from "@habenula-ai/contracts";

/**
 * Boundary-validation preservation.
 *
 * The validation refactor swapped each POST handler's hand-rolled cast-and-guard for a Zod
 * schema. The hard constraint is behavior preservation:
 * accept exactly the requests accepted today, reject exactly the ones rejected
 * today, and produce the *verbatim* error string the old guard produced.
 *
 * Accept side: asserted at the schema level, so a valid `chat` body does not
 * trigger a real (non-deterministic) LLM call. Reject side: driven through the
 * real `worker.fetch` so the exact 400 body and status are pinned end-to-end —
 * validation fails before any DO/LLM work, so these stay cheap and
 * deterministic. Tests run in the real Workers runtime (Hard Invariant 5).
 *
 * The accept-set has narrowed once since, deliberately: a `userId` or `toolName`
 * that is not well-formed UTF-16 is now refused rather than conditioned into a
 * value the caller did not send. That is its own suite —
 * test/contract/ill-formed-request-strings.test.ts — and nothing here overlaps
 * it, because every body below is well-formed text.
 */

async function post(pathname: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Request validation — accept-set preservation (schema level)", () => {
  it("disconnect: accepts a well-formed body and defaults userId", () => {
    const parsed = DisconnectServiceRequest.safeParse({ service: "gmail" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      userId: "demo-user",
      service: "gmail",
    });
  });

  it("disconnect: preserves an explicit userId", () => {
    const parsed = DisconnectServiceRequest.safeParse({
      userId: "u-1",
      service: "gmail",
    });
    expect(parsed.success && parsed.data.userId).toBe("u-1");
  });

  it("tool-execute: accepts toolName and defaults params to {}", () => {
    const parsed = ToolExecuteRequest.safeParse({ toolName: "mock_email_list" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.params).toEqual({});
  });

  it("tool-execute: preserves supplied params", () => {
    const parsed = ToolExecuteRequest.safeParse({
      toolName: "mock_email_list",
      params: { label: "INBOX" },
    });
    expect(parsed.success && parsed.data.params).toEqual({ label: "INBOX" });
  });

  it("chat: accepts a message without triggering the handler", () => {
    const parsed = ChatRequest.safeParse({ message: "hello" });
    expect(parsed.success).toBe(true);
  });

  it("resolve: accepts each valid choice", () => {
    for (const choice of ["deny", "tell_more", "task", "session"] as const) {
      const parsed = ResolveRequest.safeParse({ heldCallId: "h-1", choice });
      expect(parsed.success).toBe(true);
    }
  });

  // Explicit `null` preservation. The old `x ?? "demo-user"` / `params ?? {}`
  // guards folded BOTH undefined and null to the default. An accept-set
  // regression slips in if the schema only defaults on undefined (e.g.
  // `.optional().default()`), so pin the null path here.
  it("userId: null folds to 'demo-user' (not a validation failure)", () => {
    const d = DisconnectServiceRequest.safeParse({ service: "gmail", userId: null });
    expect(d.success && d.data.userId).toBe("demo-user");
    const c = ChatRequest.safeParse({ message: "hi", userId: null });
    expect(c.success && c.data.userId).toBe("demo-user");
    const r = ResolveRequest.safeParse({ heldCallId: "h-1", choice: "deny", userId: null });
    expect(r.success && r.data.userId).toBe("demo-user");
  });

  it("tool-execute: params null folds to {} and userId null to 'demo-user'", () => {
    const parsed = ToolExecuteRequest.safeParse({
      toolName: "mock_email_list",
      params: null,
      userId: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.params).toEqual({});
    expect(parsed.success && parsed.data.userId).toBe("demo-user");
  });
});

describe("Request validation — rejection wording preserved verbatim (HTTP)", () => {
  it("disconnect: missing service → 400 'service is required'", async () => {
    const res = await post("/api/services/disconnect", { userId: "demo-user" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "service is required" });
  });

  it("disconnect: empty-string service → 400 (falsy guard preserved)", async () => {
    const res = await post("/api/services/disconnect", { service: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "service is required" });
  });

  it("tool-execute: missing toolName → 400 'toolName is required'", async () => {
    const res = await post("/api/tools/execute", { params: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "toolName is required" });
  });

  it("tool-execute: empty-string toolName → 400", async () => {
    const res = await post("/api/tools/execute", { toolName: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "toolName is required" });
  });

  it("chat: missing message → 400 'message is required'", async () => {
    const res = await post("/api/chat", { userId: "demo-user" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "message is required" });
  });

  it("chat: empty-string message → 400", async () => {
    const res = await post("/api/chat", { message: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "message is required" });
  });

  it("resolve: missing heldCallId → 400 'heldCallId is required'", async () => {
    const res = await post("/api/resolve", { choice: "deny" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "heldCallId is required" });
  });

  it("resolve: invalid choice → 400 'choice must be one of: …'", async () => {
    const res = await post("/api/resolve", { heldCallId: "h-1", choice: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "choice must be one of: deny, tell_more, task, session, approve_once",
    });
  });

  it("resolve: both invalid → heldCallId message wins (guard order preserved)", async () => {
    const res = await post("/api/resolve", { choice: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "heldCallId is required" });
  });

  it("resolve: valid choice + userId null → not a 400 (null folds, reaches handler)", async () => {
    // Regression guard: an explicit null userId must not fail validation and
    // surface the misleading "choice must be one of" 400. It reaches
    // resolveConfirmation, which reports the unknown held call as 404.
    const res = await post("/api/resolve", {
      heldCallId: "does-not-exist",
      choice: "deny",
      userId: null,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "held call not found" });
  });

  it("invalid JSON body → 400 'Request body must be valid JSON'", async () => {
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be valid JSON" });
  });
});
