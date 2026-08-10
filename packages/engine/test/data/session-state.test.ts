import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as ss from "../../src/data/helpers/session-state";
import type { EngineSql } from "../../src/data/helpers/types";

/**
 * Behavior tests for the session_state data helpers.
 * They run against a real DO's SQLite via runInDurableObject — no mocks —
 * pinning the semantics the inline call sites carried: idempotent
 * INSERT OR IGNORE establishment, the open-session scan, and the once-only
 * ended_at close stamp.
 */
describe("session_state helpers", () => {
  it("reads back the anchor; absent session reads null", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(ss.readSessionStartedAt(sql, "s-1")).toBeNull();
      ss.insertSessionState(sql, "s-1", "2026-07-01T10:00:00.000Z", "agent-a");
      expect(ss.readSessionStartedAt(sql, "s-1")).toBe(
        "2026-07-01T10:00:00.000Z",
      );
    });
  });

  it("re-insert is ignored — started_at never resets (idempotent establish)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      ss.insertSessionState(sql, "s-1", "2026-07-01T10:00:00.000Z", "agent-a");
      ss.insertSessionState(sql, "s-1", "2026-07-01T11:00:00.000Z", "agent-b");
      expect(ss.readSessionStartedAt(sql, "s-1")).toBe(
        "2026-07-01T10:00:00.000Z",
      );
      expect(ss.selectOpenSessions(sql)).toHaveLength(1);
    });
  });

  it("selectOpenSessions returns only sessions without ended_at", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      ss.insertSessionState(sql, "s-1", "2026-07-01T10:00:00.000Z", "agent-a");
      ss.insertSessionState(sql, "s-2", "2026-07-01T10:05:00.000Z", "agent-a");
      ss.markSessionEnded(sql, "s-1", "2026-07-01T11:30:00.000Z");
      const open = ss.selectOpenSessions(sql);
      expect(open.map((r) => r.session_id)).toEqual(["s-2"]);
      expect(open[0]!.started_at).toBe("2026-07-01T10:05:00.000Z");
    });
  });

  it("markSessionEnded stamps the caller's instant, closing the reaper scan", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      ss.insertSessionState(sql, "s-1", "2026-07-01T10:00:00.000Z", "agent-a");
      ss.markSessionEnded(sql, "s-1", "2026-07-01T11:30:00.000Z");
      expect(ss.selectOpenSessions(sql)).toHaveLength(0);
      // The anchor row itself survives the close — only ended_at changes.
      expect(ss.readSessionStartedAt(sql, "s-1")).toBe(
        "2026-07-01T10:00:00.000Z",
      );
    });
  });

  it("selectActiveSession returns null when no session is open", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      expect(ss.selectActiveSession(sql)).toBeNull();
      ss.insertSessionState(sql, "s-1", "2026-07-01T10:00:00.000Z", "agent-a");
      ss.markSessionEnded(sql, "s-1", "2026-07-01T11:30:00.000Z");
      // All rows closed → no active session.
      expect(ss.selectActiveSession(sql)).toBeNull();
    });
  });

  it("selectActiveSession is the newest un-ended row (tie-break, newest wins)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      // Two open rows — the accumulated-state case the derive must reap. The
      // active session is the newest by started_at, regardless of insert order.
      ss.insertSessionState(sql, "s-old", "2026-07-01T10:00:00.000Z", "agent-a");
      ss.insertSessionState(sql, "s-new", "2026-07-01T10:05:00.000Z", "agent-a");
      const active = ss.selectActiveSession(sql);
      expect(active?.session_id).toBe("s-new");
      expect(active?.started_at).toBe("2026-07-01T10:05:00.000Z");
      expect(active?.ended_at).toBeNull();
    });
  });

  it("selectActiveSession skips ended rows even when newer", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as unknown as { sql: EngineSql });
      ss.insertSessionState(sql, "s-open", "2026-07-01T10:00:00.000Z", "agent-a");
      // A later-started session that has since ended must not be picked.
      ss.insertSessionState(sql, "s-ended", "2026-07-01T10:05:00.000Z", "agent-a");
      ss.markSessionEnded(sql, "s-ended", "2026-07-01T10:06:00.000Z");
      expect(ss.selectActiveSession(sql)?.session_id).toBe("s-open");
    });
  });
});
