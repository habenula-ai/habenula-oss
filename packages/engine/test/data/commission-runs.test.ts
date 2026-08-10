/**
 * `commission_runs` helper CRUD + the absorbing-terminal guard
 * whereby a terminal status write applies only over a
 * non-terminal status, so quit/kill/read-time `expired` landing mid-turn can
 * never be overwritten by the turn's later `completed`, and vice versa.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getUserAgentStub, bindDoSql } from "../helpers/do-sql";
import * as runs from "../../src/data/helpers/commission-runs";

const T0 = "2026-07-06T10:00:00.000Z";
const T1 = "2026-07-06T10:05:00.000Z";
const T2 = "2026-07-06T10:10:00.000Z";

function seed(sql: Parameters<typeof runs.insertCommissionRun>[0], id = "run-1") {
  runs.insertCommissionRun(sql, {
    id,
    goal: "email the notes to jane",
    data: JSON.stringify({ recipient: "jane@acme.test" }),
    sessionId: "s-1",
    createdAt: T0,
  });
}

describe("commission_runs helpers", () => {
  it("creates running, reads back in full, and moves through the hold cycle", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      seed(sql);
      expect(runs.readCommissionRun(sql, "run-1")).toEqual({
        id: "run-1",
        origin: "mcp_commission",
        goal: "email the notes to jane",
        data: JSON.stringify({ recipient: "jane@acme.test" }),
        status: "running",
        session_id: "s-1",
        created_at: T0,
        updated_at: T0,
        // Additive columns, unset on a fresh insert.
        label: null,
        status_detail: null,
        awaited_slot_keys: null,
      });
      expect(runs.readCommissionRun(sql, "absent")).toBeNull();

      runs.updateCommissionStatus(sql, "run-1", "awaiting_confirmation", T1);
      expect(runs.readCommissionRun(sql, "run-1")!.status).toBe(
        "awaiting_confirmation",
      );
      // resume: awaiting → running is a non-terminal → non-terminal move
      runs.updateCommissionStatus(sql, "run-1", "running", T1);
      expect(runs.readCommissionRun(sql, "run-1")!.status).toBe("running");
    });
  });

  it("terminal states are absorbing: a later terminal write is a no-op", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      seed(sql);
      // quit/kill/read-time expiry lands mid-turn…
      runs.updateCommissionStatus(sql, "run-1", "expired", T1);
      const afterExpire = runs.readCommissionRun(sql, "run-1")!;
      expect(afterExpire.status).toBe("expired");
      // …and the straddling turn's own terminal must NOT overwrite it.
      runs.updateCommissionStatus(sql, "run-1", "completed", T2);
      const final = runs.readCommissionRun(sql, "run-1")!;
      expect(final.status).toBe("expired");
      expect(final.updated_at).toBe(T1);
    });
  });

  it("selects non-terminal runs and expires a session's runs with the same guard", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      seed(sql, "run-1");
      seed(sql, "run-2");
      runs.updateCommissionStatus(sql, "run-2", "completed", T1);

      expect(runs.selectNonTerminalRuns(sql).map((r) => r.id)).toEqual([
        "run-1",
      ]);

      runs.markRunsExpiredForSession(sql, "s-1", T2);
      expect(runs.readCommissionRun(sql, "run-1")!.status).toBe("expired");
      // the completed run is untouched (absorbing), not flipped to expired
      expect(runs.readCommissionRun(sql, "run-2")!.status).toBe("completed");
      expect(runs.selectNonTerminalRuns(sql)).toEqual([]);
    });
  });

  it("cancelRun terminates a parked run and no-ops on running/terminal (guarded)", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      // A running run is NOT cancellable by the helper — the guard excludes it
      // (the DO refuses a running task upstream anyway).
      seed(sql, "run-run");
      runs.cancelRun(sql, "run-run", T1);
      expect(runs.readCommissionRun(sql, "run-run")!.status).toBe("running");

      // A parked (awaiting_confirmation) run cancels.
      seed(sql, "run-park");
      runs.updateCommissionStatus(sql, "run-park", "awaiting_confirmation", T1);
      runs.cancelRun(sql, "run-park", T2);
      expect(runs.readCommissionRun(sql, "run-park")!.status).toBe("cancelled");

      // A needs_input run cancels.
      seed(sql, "run-input");
      runs.markNeedsInput(sql, "run-input", JSON.stringify(["to"]), T1);
      runs.cancelRun(sql, "run-input", T2);
      expect(runs.readCommissionRun(sql, "run-input")!.status).toBe("cancelled");

      // A terminal run is absorbing — a stray cancel never overwrites it.
      seed(sql, "run-done");
      runs.updateCommissionStatus(sql, "run-done", "completed", T1);
      runs.cancelRun(sql, "run-done", T2);
      expect(runs.readCommissionRun(sql, "run-done")!.status).toBe("completed");
    });
  });

  it("listTasks is bounded by limit and paged newest-first by the keyset cursor", async () => {
    const stub = getUserAgentStub();
    await runInDurableObject(stub, (instance) => {
      const sql = bindDoSql(instance as never);
      // Five runs with strictly increasing created_at (newest = run-5).
      const stamps = [
        "2026-07-06T10:00:00.000Z",
        "2026-07-06T10:01:00.000Z",
        "2026-07-06T10:02:00.000Z",
        "2026-07-06T10:03:00.000Z",
        "2026-07-06T10:04:00.000Z",
      ];
      stamps.forEach((createdAt, n) =>
        runs.insertCommissionRun(sql, {
          id: `run-${n + 1}`,
          goal: `task ${n + 1}`,
          data: null,
          sessionId: "s-1",
          createdAt,
        }),
      );

      // First page: the two newest, DESC.
      const page1 = runs.listTasks(sql, { limit: 2 });
      expect(page1.map((r) => r.id)).toEqual(["run-5", "run-4"]);

      // Keyset cursor from the last row of page 1 → the next two, no overlap.
      const page2 = runs.listTasks(sql, {
        limit: 2,
        before: { createdAt: page1[1]!.created_at, id: page1[1]!.id },
      });
      expect(page2.map((r) => r.id)).toEqual(["run-3", "run-2"]);

      const page3 = runs.listTasks(sql, {
        limit: 2,
        before: { createdAt: page2[1]!.created_at, id: page2[1]!.id },
      });
      expect(page3.map((r) => r.id)).toEqual(["run-1"]);
    });
  });
});
