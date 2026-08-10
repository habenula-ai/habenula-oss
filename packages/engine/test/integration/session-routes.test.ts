import { describe, it, expect } from "vitest";
import { workerFetch, post, get } from "../helpers/http";

/**
 * HTTP-entry (`worker.fetch`) coverage of the session routes.
 * These prove the ROUTE WIRING (the class of gap the shipped re-minting bug
 * lived in); the DO-method logic is pinned in isolation by
 * `test/agent/session-lifecycle.test.ts`.
 */

const SESSION_LIFETIME_MS = 90 * 60 * 1000;

type ActiveSessionView = {
  sessionId: string;
  startedAt: string;
  expiry: string | null;
};
type StartJson = { status: string; activeSession: ActiveSessionView };
type QuitJson = { ended: boolean };
type GetJson = { active: ActiveSessionView | null };

describe("session routes (HTTP entry)", () => {
  it("POST /api/session/start starts once; a second start is 409 refused naming the active session", async () => {
    const userId = "routes-refuse-user";

    const first = await workerFetch(post("/api/session/start", { userId }));
    expect(first.status).toBe(200);
    const started = (await first.json()) as StartJson;
    expect(started.status).toBe("started");
    expect(started.activeSession.sessionId).toMatch(/^session-/);

    const second = await workerFetch(post("/api/session/start", { userId }));
    expect(second.status).toBe(409); // refusal is a conflict, not an error 500
    const refused = (await second.json()) as StartJson;
    expect(refused.status).toBe("refused");
    // The refusal payload names the session that blocked the start.
    expect(refused.activeSession.sessionId).toBe(started.activeSession.sessionId);
  });

  it("POST /api/session/quit frees the slot — a subsequent start succeeds; quit is idempotent", async () => {
    const userId = "routes-quit-user";

    const first = (await (
      await workerFetch(post("/api/session/start", { userId }))
    ).json()) as StartJson;

    const quit = await workerFetch(post("/api/session/quit", { userId }));
    expect(quit.status).toBe(200);
    expect(((await quit.json()) as QuitJson).ended).toBe(true);

    // The slot is free: a fresh start is not refused, and mints a NEW session.
    const restart = await workerFetch(post("/api/session/start", { userId }));
    expect(restart.status).toBe(200);
    const restarted = (await restart.json()) as StartJson;
    expect(restarted.status).toBe("started");
    expect(restarted.activeSession.sessionId).not.toBe(
      first.activeSession.sessionId,
    );

    // Idempotent: quitting again (after a quit of the restarted session)
    // reports nothing to end rather than erroring.
    await workerFetch(post("/api/session/quit", { userId }));
    const again = await workerFetch(post("/api/session/quit", { userId }));
    expect(((await again.json()) as QuitJson).ended).toBe(false);
  });

  it("GET /api/session reports the active session with its computed expiry, or { active: null }", async () => {
    const userId = "routes-status-user";

    // No session yet — one shape, null payload.
    const empty = (await (
      await workerFetch(get(`/api/session?userId=${userId}`))
    ).json()) as GetJson;
    expect(empty.active).toBeNull();

    const started = (await (
      await workerFetch(post("/api/session/start", { userId }))
    ).json()) as StartJson;

    const view = (await (
      await workerFetch(get(`/api/session?userId=${userId}`))
    ).json()) as GetJson;
    expect(view.active).toEqual({
      sessionId: started.activeSession.sessionId,
      startedAt: started.activeSession.startedAt,
      expiry: new Date(
        new Date(started.activeSession.startedAt).getTime() +
          SESSION_LIFETIME_MS,
      ).toISOString(),
    });
  });

  it("start/quit accept an omitted or explicitly-null userId (defaults to demo-user)", async () => {
    // The boundary's historic contract is `(body.userId ?? "demo-user")`, so
    // BOTH an absent userId and an explicit `userId: null` must parse (the
    // .nullish() accept-set) — not 400.
    const started = await workerFetch(post("/api/session/start", {}));
    expect(started.status).toBe(200);
    expect(((await started.json()) as StartJson).status).toBe("started");

    // Explicit null routes to the same demo-user DO → refused, not 400.
    const nullStart = await workerFetch(
      post("/api/session/start", { userId: null }),
    );
    expect(nullStart.status).toBe(409);

    const quit = await workerFetch(post("/api/session/quit", { userId: null }));
    expect(quit.status).toBe(200);
    expect(((await quit.json()) as QuitJson).ended).toBe(true);
  });
});
