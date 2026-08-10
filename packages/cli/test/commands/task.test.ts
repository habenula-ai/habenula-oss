import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import {
  runTaskCancel,
  runTaskList,
  runTaskShow,
  runTaskWatch,
} from "../../src/commands/task";
import { sseToolResult } from "../helpers/internal-wire";

/**
 * `habenula task list / show / cancel / watch`. A real
 * ApiClient over a route-keyed fake fetch (Hard Invariant 5 posture — no mocked
 * client), `depth: "none"` (non-TTY) so assertions are on plain text. `getStatus`
 * routes through `/internal/mcp` (the poll seam), so `watch` serves that route
 * SSE-wrapped, exactly as the status command's tests do.
 */
type Handler = (req: {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}) => { status: number; body?: unknown; sse?: unknown };

function makeClient(handler: Handler): ApiClient {
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const r = handler({ path: url.pathname, method, body });
    if (r.sse !== undefined) return new Response(sseToolResult(r.sse), { status: r.status });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  };
  return new ApiClient({ apiUrl: "http://api.test", userId: "u", humanTouch: false }, fetchFn);
}

const TASK = {
  taskId: "task-abc",
  origin: "mcp_commission" as const,
  status: "awaiting_confirmation" as const,
  label: "email the report",
  goal: "email the report to ceo@acme.test",
  createdAt: "2026-07-06T09:55:00.000Z",
  updatedAt: "2026-07-06T09:55:00.000Z",
};

describe("habenula task", () => {
  let logs: string[];
  let originalColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  });

  it("A-7: `task list` renders the queue with id, origin, status, and label", async () => {
    const client = makeClient(({ path }) => {
      if (path === "/api/tasks") return { status: 200, body: { tasks: [TASK], nextCursor: null } };
      throw new Error(`unexpected ${path}`);
    });
    const code = await runTaskList(client, {}, "none");
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("task-abc");
    expect(out).toContain("awaiting_confirmation");
    expect(out).toContain("email the report");
    expect(out).toContain("mcp_commission");
  });

  it("A-7: `task list` shows the empty-state nudge and a truncation footer", async () => {
    const empty = makeClient(() => ({ status: 200, body: { tasks: [], nextCursor: null } }));
    await runTaskList(empty, {}, "none");
    expect(logs.join("\n")).toContain("No tasks");

    logs.length = 0;
    const more = makeClient(() => ({ status: 200, body: { tasks: [TASK], nextCursor: "CURSOR" } }));
    await runTaskList(more, {}, "none");
    // A non-null nextCursor surfaces as a "more not shown" footer (no silent truncation).
    expect(logs.join("\n")).toContain("more tasks not shown");
  });

  it("`task list --all` follows the cursor to the end and stops making progress safely", async () => {
    const page2 = { ...TASK, taskId: "task-def", label: "second page task" };
    const requested: (string | null)[] = [];
    const client = makeClient(({ path, method }) => {
      if (path === "/api/tasks" && method === "GET") {
        // Page 1 hands back a cursor; page 2 is the last page.
        const n = requested.length;
        requested.push(n === 0 ? null : "CURSOR");
        return n === 0
          ? { status: 200, body: { tasks: [TASK], nextCursor: "CURSOR" } }
          : { status: 200, body: { tasks: [page2], nextCursor: null } };
      }
      throw new Error(`unexpected ${path}`);
    });

    const code = await runTaskList(client, { all: true }, "none");

    expect(code).toBe(0);
    expect(requested).toHaveLength(2);
    const out = logs.join("\n");
    // Both pages rendered, and with --all there is no truncation footer.
    expect(out).toContain("task-abc");
    expect(out).toContain("task-def");
    expect(out).not.toContain("more tasks not shown");
  });

  it("`task list --all` stops instead of looping when a cursor never advances", async () => {
    // A server (or a corrupted cursor) that keeps returning page 1 with a fresh
    // cursor must not spin forever re-reporting the same rows.
    let calls = 0;
    const client = makeClient(() => {
      calls += 1;
      return { status: 200, body: { tasks: [TASK], nextCursor: "SAME" } };
    });

    const code = await runTaskList(client, { all: true }, "none");

    expect(code).toBe(0);
    // Page 1, then one non-advancing page detected by id -> stop.
    expect(calls).toBe(2);
    expect(logs.join("\n")).toContain("task-abc");
  });

  it("`task list --limit` is passed through to the query", async () => {
    let seenLimit: string | null = null;
    const client = makeClient(({ path }) => {
      if (path === "/api/tasks") return { status: 200, body: { tasks: [TASK], nextCursor: null } };
      throw new Error(`unexpected ${path}`);
    });
    // Re-wrap to capture the query string the client actually built.
    const spy = new Proxy(client, {
      get(target, prop, recv) {
        if (prop === "listTasks") {
          return (opts?: { limit?: number }) => {
            seenLimit = opts?.limit !== undefined ? String(opts.limit) : null;
            return Reflect.get(target, prop, recv).call(target, opts);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });

    await runTaskList(spy as typeof client, { limit: 5 }, "none");
    expect(seenLimit).toBe("5");
  });

  it("A-8: `task show` renders the per-action breakdown and awaited slot", async () => {
    const detail = {
      task: { ...TASK, status: "needs_input" as const },
      statusDetail: [
        { service: "mock_email", verb: "list", noun: "INBOX", outcome: "executed" as const },
      ],
      awaitedSlotKeys: ["to"],
    };
    const client = makeClient(({ path }) => {
      if (path === "/api/tasks/get") return { status: 200, body: detail };
      throw new Error(`unexpected ${path}`);
    });
    const code = await runTaskShow(client, "task-abc", "none");
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("task-abc");
    expect(out).toContain("mock_email · list");
    expect(out).toContain("executed");
    // Assert the composed line, not a bare "to" — TASK.goal already contains
    // "to", so `toContain("to")` would pass with the awaited-slot block deleted.
    expect(out).toContain("Awaiting input: to");
  });

  it("A-8: `task show` on an unknown id prints a clean message and exits 1", async () => {
    const client = makeClient(({ path }) => {
      if (path === "/api/tasks/get") return { status: 404, body: { error: "Task not found" } };
      throw new Error(`unexpected ${path}`);
    });
    const code = await runTaskShow(client, "nope", "none");
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("No such task: nope");
  });

  it("A-9: `task cancel` reports each outcome (cancelled / running / not_cancellable)", async () => {
    const cancelled = makeClient(({ path, method }) => {
      if (path === "/api/tasks/cancel" && method === "POST")
        return { status: 200, body: { status: "cancelled", taskId: "task-abc", previousStatus: "awaiting_confirmation" } };
      throw new Error("unexpected");
    });
    expect(await runTaskCancel(cancelled, "task-abc")).toBe(0);
    expect(logs.join("\n")).toContain("Cancelled task task-abc");

    logs.length = 0;
    const running = makeClient(() => ({ status: 200, body: { status: "running", taskId: "task-abc" } }));
    expect(await runTaskCancel(running, "task-abc")).toBe(1);
    expect(logs.join("\n")).toContain("is running");

    logs.length = 0;
    const terminal = makeClient(() => ({
      status: 200,
      body: { status: "not_cancellable", taskId: "task-abc", currentStatus: "completed" },
    }));
    expect(await runTaskCancel(terminal, "task-abc")).toBe(1);
    expect(logs.join("\n")).toContain("already completed");

    logs.length = 0;
    // A hold mid-resolve: the action's real outcome is owed by the resolve path,
    // so cancel is refused rather than recording a false "never ran".
    const resolving = makeClient(() => ({
      status: 200,
      body: { status: "resolving", taskId: "task-abc" },
    }));
    expect(await runTaskCancel(resolving, "task-abc")).toBe(1);
    expect(logs.join("\n")).toContain("being resolved");
  });

  it("A-9: `task cancel` branches on the 404 and 409 API errors", async () => {
    const notFound = makeClient(() => ({ status: 404, body: { error: "Task not found" } }));
    expect(await runTaskCancel(notFound, "nope")).toBe(1);
    expect(logs.join("\n")).toContain("No such task: nope");

    logs.length = 0;
    const busy = makeClient(() => ({
      status: 409,
      body: { error: "A turn is in progress", error_code: "TURN_IN_PROGRESS" },
    }));
    expect(await runTaskCancel(busy, "task-abc")).toBe(1);
    expect(logs.join("\n")).toContain("turn in progress");
  });

  it("A-10: `task watch` polls status + tasks each tick and renders the queue", async () => {
    const statusBody = { session: null, grants: [], held: [] };
    let taskReads = 0;
    const client = makeClient(({ path }) => {
      if (path === "/internal/mcp") return { status: 200, sse: statusBody };
      if (path === "/api/tasks") {
        taskReads += 1;
        return { status: 200, body: { tasks: [TASK], nextCursor: null } };
      }
      throw new Error(`unexpected ${path}`);
    });
    const signal = new AbortController().signal;
    const code = await runTaskWatch(client, {
      depth: "none",
      width: 100,
      signal,
      sleep: async () => {},
      maxTicks: 2,
      now: () => new Date("2026-07-06T10:00:00.000Z"),
    });
    expect(code).toBe(0);
    // Two frames rendered: the task list appears in each tick.
    expect(taskReads).toBe(2);
    const frames = logs.filter((l) => l.includes("── tasks @"));
    expect(frames).toHaveLength(2);
    expect(logs.join("\n")).toContain("task-abc");
  });

  it("A-10: `task watch` surfaces the live-slot confirmation nudge when one is parked", async () => {
    const statusBody = {
      session: null,
      grants: [],
      held: [
        {
          heldCallId: "h1",
          service: "mock_email",
          verb: "send",
          noun: "ceo@acme.test",
          params: {},
          origin: "mcp_commission",
          goal: "email the report",
        },
      ],
    };
    const client = makeClient(({ path }) => {
      if (path === "/internal/mcp") return { status: 200, sse: statusBody };
      if (path === "/api/tasks") return { status: 200, body: { tasks: [TASK], nextCursor: null } };
      throw new Error(`unexpected ${path}`);
    });
    await runTaskWatch(client, {
      depth: "none",
      width: 100,
      signal: new AbortController().signal,
      sleep: async () => {},
      maxTicks: 1,
      now: () => new Date("2026-07-06T10:00:00.000Z"),
    });
    expect(logs.join("\n")).toContain("waiting for your approval");
    expect(logs.join("\n")).toContain("mock_email · send");
  });
});
