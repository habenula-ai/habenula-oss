import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { get, post, stubFor, workerFetch } from "../helpers/http";

/**
 * A request string the engine cannot record as the bytes it would hash is
 * refused, not substituted.
 *
 * An unpaired UTF-16 surrogate is a legal JSON string with no UTF-8 encoding.
 * The write path conditions it (`wellFormed` in `@habenula-ai/audit`), which is
 * what keeps the audit chain verifiable for every writer including the model.
 * Conditioning alone still answers `200` and records a value the caller did not
 * send, and for `userId` that is an attribution question: every unpaired
 * surrogate encodes to the same replacement bytes, so two distinct spellings
 * condition to one string and name one Durable Object.
 *
 * These tests drive the real `worker.fetch`, because the refusal is a property
 * of the route's 400, not of a schema in isolation: each route names a
 * different default field in its error envelope, and an ill-formed `userId` has
 * to report itself rather than borrow `"service is required"`.
 *
 * No test title or assertion prints a raw surrogate. The vitest reporter cannot
 * serialize one, so a regression would otherwise arrive as a transport error
 * instead of a readable diff — hence message comparisons, never value ones.
 */
describe("Ill-formed request strings are refused at the boundary", () => {
  const HIGH = "\ud800";
  const ILL_FORMED = `a${HIGH}b`;
  const USER_ID_MESSAGE = "userId must not contain an unpaired surrogate";
  const TOOL_NAME_MESSAGE = "toolName must not contain an unpaired surrogate";

  /** Every POST route that carries `userId`, with an otherwise-valid body. */
  const USER_ID_ROUTES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["/api/chat", { message: "hello" }],
    ["/api/tools/execute", { toolName: "mock_email_list", params: {} }],
    ["/api/resolve", { heldCallId: "held-1", choice: "deny" }],
    ["/api/session/start", {}],
    ["/api/session/quit", {}],
    ["/api/kill", {}],
    ["/api/connect/cancel", { flow: "flow-1" }],
    ["/api/services/disconnect", { service: "gmail" }],
    ["/api/settings", { monthLimitCents: 5_000 }],
    ["/api/tasks/cancel", { taskId: "task-1" }],
  ];

  it("every POST route that reads userId 400s and names userId", async () => {
    for (const [path, body] of USER_ID_ROUTES) {
      const res = await workerFetch(post(path, { ...body, userId: ILL_FORMED }));
      expect(res.status, path).toBe(400);
      const payload = (await res.json()) as { error: string };
      // Each of these routes reports a different field by default
      // ("service is required", "taskId is required", "message is required").
      // The ill-formed message has to win, or the 400 misdirects the caller to
      // a field that was fine.
      expect(payload.error, path).toBe(USER_ID_MESSAGE);
    }
  });

  it("an ill-formed userId reports first even when the route's own field also fails", async () => {
    // The first test's bodies are otherwise valid, so the ill-formed issue is
    // the only one in each parse failure. Here every body also breaks the
    // route's own field (a missing message, a missing taskId, an empty settings
    // update), so the route has a competing default message — the priority the
    // mappers and inline sites promise is that the ill-formed report wins it.
    // The settings case additionally pins the detection itself: its
    // empty-update failure is a `custom` issue too, and must not be mistaken
    // for the ill-formed marker.
    const ROUTES_WITH_OWN_FAILURE: readonly string[] = [
      "/api/chat",
      "/api/tools/execute",
      "/api/resolve",
      "/api/connect/cancel",
      "/api/services/disconnect",
      "/api/settings",
      "/api/tasks/cancel",
    ];
    for (const path of ROUTES_WITH_OWN_FAILURE) {
      const res = await workerFetch(post(path, { userId: ILL_FORMED }));
      expect(res.status, path).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error, path).toBe(USER_ID_MESSAGE);
    }
  });

  it("with userId and toolName both ill-formed, userId reports", async () => {
    // Pins the tie-break so the wire message stays deterministic: the first
    // matching issue wins, and issue order follows the schema shape, where
    // `userId` precedes `toolName`.
    const res = await workerFetch(
      post("/api/tools/execute", { userId: ILL_FORMED, toolName: ILL_FORMED, params: {} }),
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe(USER_ID_MESSAGE);
  });

  it("tools/execute 400s on an ill-formed toolName and records nothing", async () => {
    const userId = "ill-formed-tool-name-user";
    const res = await workerFetch(
      post("/api/tools/execute", { userId, toolName: ILL_FORMED, params: {} }),
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe(TOOL_NAME_MESSAGE);

    // The refusal sits ahead of every DO effect, so the accountability record
    // is untouched: no session minted, no held call parked, no audit row. The
    // pre-fix behavior was a 200 and a written row.
    const status = await runInDurableObject(stubFor(userId), (instance) =>
      instance.readStatus(),
    );
    expect(status.session).toBeNull();
    expect(status.held).toEqual([]);
    expect(status.auditTail).toBeNull();
  });

  it("a spellable replacement character is still a legal userId", async () => {
    // The refusal is about the form that cannot be spelled back, not about
    // U+FFFD itself: a caller who genuinely wants that character keeps it.
    const res = await workerFetch(
      post("/api/session/start", { userId: "a�b" }),
    );
    expect(res.status).toBe(200);
  });

  it("an absent or null userId still defaults, unrefused", async () => {
    // The refinement runs on the string, ahead of the nullish transform, so the
    // `?? "demo-user"` accept-set the routes have always had is unchanged.
    for (const body of [{}, { userId: null }]) {
      const res = await workerFetch(post("/api/session/quit", body));
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
  });

  it("a query-string userId cannot reach the refusal", async () => {
    // `URLSearchParams` yields a scalar value string: a hand-crafted raw
    // surrogate arrives already replaced by the URL decoder, so the read
    // surface answers normally. This is why the throwing `parse*Query` helpers
    // stay throwing — the check they carry has no query-side case to fail on.
    const raw = await workerFetch(
      new Request("http://localhost/api/status?userId=a%ED%A0%80b"),
    );
    expect(raw.status).toBe(200);

    // Same for the helper-built form, which percent-encodes through the same
    // lossy conversion.
    const built = await workerFetch(get("/api/status", { userId: ILL_FORMED }));
    expect(built.status).toBe(200);
  });
});
