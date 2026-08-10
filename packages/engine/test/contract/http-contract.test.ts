import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AuditListResponse,
  CatalogResponse,
  ChatResponse,
  ConnectCancelResponse,
  ConnectFlowStatusResponse,
  ConnectResponse,
  ContractDescriptorsResponse,
  DisconnectResponse,
  GovernanceSnapshotResponse,
  ErrorResponse,
  ExecuteToolResponse,
  GetSessionResponse,
  KillResponse,
  PolicyResponse,
  QuitResponse,
  ResolveResponse,
  ServicesResponse,
  SettingsResponse,
  StartSessionResponse,
  StatusResponse,
  TaskCancelResponse,
  TaskDetailResponse,
  TasksListResponse,
} from "@habenula-ai/contracts";
import { seedCiphertext } from "../helpers/seed-credential";
import { bindDoSql } from "../helpers/do-sql";
import { workerFetch, post, get, stubFor } from "../helpers/http";
import * as al from "../../src/data/helpers/audit-log";
import * as sl from "../../src/data/helpers/spend-ledger";
import type {
  ConversationLoopResult,
  RecordedToolName,
  ToolCallRecord,
} from "../../src/llm/conversation";
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * Runtime HTTP contract test:
 * drive each real /api/* endpoint in the Workers runtime (Hard Invariant #5 —
 * real bindings, nothing mocked) and `parse` the actual body against its wire
 * schema. Because every response schema is recursively strict, a parse
 * catches BOTH drift directions: a removed field fails here directly, and an
 * added field fails as an unknown key at whatever depth it appears.
 *
 * Schema selection is by return kind, not status: a result body validates
 * against its route schema at whatever status it ships (session-start's 409
 * refusal included); an error-envelope body validates against ErrorResponse.
 *
 * For the two projection endpoints (tools/execute, resolve) this test is the
 * LOAD-BEARING guard: their wire is deliberately narrower than the internal
 * type, so no compile-time check can cover the internal→wire projection. The
 * cases below reach every decision variant that changes the wire shape and
 * assert the dropped internals are absent. Assertions are structural only —
 * never LLM content.
 */

// ---------------------------------------------------------------------------
// Chat mirror equality — compile-time, no runtime cost. ChatResponse is a
// hand-authored mirror of ConversationLoopResult (mirror, not unify);
// divergence in EITHER direction fails engine tsc here.
// No such assertion exists for tools/execute or resolve: their wire is
// intentionally not equal to the internal type.
//
// `ToolCallRecord.name` is the ONE deliberate difference, so it is asserted
// separately: internally it is the branded `RecordedToolName` (only
// `recordToolName` mints one, so a new record site cannot skip registry
// validation), and on the wire it is the plain string a client receives, because
// the registry lives in the engine and no client can re-derive the brand. Every
// other field — and any field added to either side, at either level — still has
// to match exactly in both directions.
// ---------------------------------------------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type WireChatResponse = z.infer<typeof ChatResponse>;
type WireToolCallRecord = WireChatResponse["toolCalls"][number];
/* eslint-disable @typescript-eslint/no-unused-vars */
type _ChatMirror = Expect<
  Equal<
    Omit<ConversationLoopResult, "toolCalls">,
    Omit<WireChatResponse, "toolCalls">
  >
>;
type _ToolCallMirror = Expect<
  Equal<Omit<ToolCallRecord, "name">, Omit<WireToolCallRecord, "name">>
>;
type _BothCarryToolCallArrays = Expect<
  Equal<
    [ConversationLoopResult["toolCalls"], WireChatResponse["toolCalls"]],
    [ToolCallRecord[], WireToolCallRecord[]]
  >
>;
type _WireNameIsPlainString = Expect<Equal<WireToolCallRecord["name"], string>>;
type _RecordNameIsBranded = Expect<
  Equal<ToolCallRecord["name"], RecordedToolName>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */

// --- Harness -----------------------------------------------------------------

/** A single tool_use block calling mock_email_list. */
function toolUse(id: string, label = "INBOX"): LLMToolUseBlock {
  return { type: "tool_use", id, name: "mock_email_list", input: { label } };
}

/** Mock LLM emitting a scripted sequence — one entry per createMessage call. */
function scriptedLLM(
  script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>,
): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools && step.tools.length > 0) {
        return {
          id: `msg_${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${i}`,
        content: [{ type: "text", text: step.text ?? "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

type Raw = Record<string, unknown>;

// --- State-free endpoints ----------------------------------------------------

describe("HTTP contract — state-free endpoints", () => {
  it("GET /api/services/catalog matches CatalogResponse", async () => {
    const res = await workerFetch(get("/api/services/catalog"));
    expect(res.status).toBe(200);
    CatalogResponse.parse(await res.json());
  });

  it("GET /api/services matches ServicesResponse (with a connected row)", async () => {
    const userId = "contract-services-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
    });
    const res = await workerFetch(get(`/api/services?userId=${userId}`));
    expect(res.status).toBe(200);
    const body = ServicesResponse.parse(await res.json());
    expect(body.services.length).toBeGreaterThan(0);
  });

  it("GET /api/policy matches PolicyResponse", async () => {
    const res = await workerFetch(get("/api/policy?userId=contract-policy-user"));
    expect(res.status).toBe(200);
    const body = PolicyResponse.parse(await res.json());
    // The default-deny floor always exists, so entries is non-empty.
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it("GET /api/settings matches SettingsResponse with the shipped defaults in force", async () => {
    const res = await workerFetch(get("/api/settings?userId=contract-settings-user"));
    expect(res.status).toBe(200);
    const body = SettingsResponse.parse(await res.json());
    // A fresh DO has no stored keys: both limits are the shipped defaults,
    // flagged as such, with nothing spent (the cap exists before any config).
    expect(body).toEqual({
      monthLimitCents: 5000,
      sessionLimitCents: 2000,
      monthIsDefault: true,
      sessionIsDefault: true,
      monthSpentCents: 0,
      sessionSpentCents: 0,
    });
  });

  it("GET /api/settings sums a populated ledger into both windows", async () => {
    const userId = "contract-settings-sums-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      const sql = bindDoSql(instance as never);
      // Establish the session the session window sums by.
      const sessionId = instance.resolveActiveSession({ userId, agentId: "agent-1" });
      const insert = (over: Partial<sl.SpendLedgerInsert>) =>
        sl.insertSpendInTxn(sql, {
          id: crypto.randomUUID(),
          sessionId,
          createdAt: new Date().toISOString(),
          service: "mock_delivery",
          verb: "order",
          amountCents: 300,
          quoteId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          auditEntryId: "audit-x",
          ...over,
        });
      insert({}); // current month, active session
      insert({ sessionId: "someone-elses-session", amountCents: 500 }); // month only
      insert({ createdAt: "2020-01-01T00:00:00.000Z", amountCents: 900, sessionId: "old" }); // out of window
    });

    const body = SettingsResponse.parse(
      await (await workerFetch(get(`/api/settings?userId=${userId}`))).json(),
    );
    // The month window sees both current-month rows; the session window only
    // the active session's; the 2020 row is outside both.
    expect(body.monthSpentCents).toBe(800);
    expect(body.sessionSpentCents).toBe(300);
  });

  it("POST /api/settings sets a limit and echoes it; the other window keeps its default", async () => {
    const userId = "contract-settings-post-user";
    const res = await workerFetch(
      post("/api/settings", { userId, monthLimitCents: 7500 }),
    );
    expect(res.status).toBe(200);
    const body = SettingsResponse.parse(await res.json());
    expect(body.monthLimitCents).toBe(7500);
    expect(body.monthIsDefault).toBe(false);
    expect(body.sessionIsDefault).toBe(true);

    // The write is durable: the next GET reads the stored limit back.
    const reread = SettingsResponse.parse(
      await (await workerFetch(get(`/api/settings?userId=${userId}`))).json(),
    );
    expect(reread.monthLimitCents).toBe(7500);
  });

  it("POST /api/settings is 400 on an empty update and on non-integer cents", async () => {
    const empty = await workerFetch(
      post("/api/settings", { userId: "contract-settings-400" }),
    );
    expect(empty.status).toBe(400);
    ErrorResponse.parse(await empty.json());

    const fractional = await workerFetch(
      post("/api/settings", {
        userId: "contract-settings-400",
        monthLimitCents: 12.5,
      }),
    );
    expect(fractional.status).toBe(400);
    ErrorResponse.parse(await fractional.json());

    // Over the $1M ceiling — the same bound the CLI parser enforces, so a
    // raw POST cannot set a functionally-unlimited cap the CLI would refuse.
    const overMax = await workerFetch(
      post("/api/settings", {
        userId: "contract-settings-400",
        monthLimitCents: 100_000_001,
      }),
    );
    expect(overMax.status).toBe(400);
    ErrorResponse.parse(await overMax.json());
  });

  it("POST /api/kill matches KillResponse", async () => {
    const res = await workerFetch(
      post("/api/kill", { userId: "contract-kill-user" }),
    );
    expect(res.status).toBe(200);
    KillResponse.parse(await res.json());
  });

  it("POST /api/services/disconnect matches DisconnectResponse", async () => {
    const userId = "contract-disconnect-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
    });
    const res = await workerFetch(
      post("/api/services/disconnect", { userId, service: "mock_email" }),
    );
    expect(res.status).toBe(200);
    DisconnectResponse.parse(await res.json());
  });

  it("POST /connect/{service} matches ConnectResponse (authorizeUrl variant, flow present)", async () => {
    // Both catalog services are OAuth today, so the credential-less
    // `{ connected }` variant is unreachable over HTTP; it stays modeled in
    // the schema for the handler's `none` branch.
    const res = await workerFetch(
      post("/connect/mock_email?userId=contract-connect-user", {}),
    );
    expect(res.status).toBe(200);
    const body = ConnectResponse.parse(await res.json());
    expect("authorizeUrl" in body).toBe(true);
    expect("flow" in body).toBe(true);
    if ("flow" in body) expect(body.flow.length).toBeGreaterThan(0);
  });

  it("GET /api/connect/status matches ConnectFlowStatusResponse", async () => {
    const userId = "contract-flow-status-user";
    const begun = await workerFetch(post(`/connect/mock_email?userId=${userId}`, {}));
    const { flow } = (await begun.json()) as { flow: string };

    const res = await workerFetch(
      get(`/api/connect/status?userId=${userId}&service=mock_email&flow=${flow}`),
    );
    expect(res.status).toBe(200);
    const body = ConnectFlowStatusResponse.parse(await res.json());
    expect(body.status).toBe("pending");
  });

  it("GET /api/connect/status with a missing param is a 400 ErrorResponse", async () => {
    const res = await workerFetch(
      get("/api/connect/status?userId=contract-flow-status-user&service=mock_email"),
    );
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });

  it("POST /api/connect/cancel matches ConnectCancelResponse", async () => {
    const userId = "contract-flow-cancel-user";
    const begun = await workerFetch(post(`/connect/mock_email?userId=${userId}`, {}));
    const { flow } = (await begun.json()) as { flow: string };

    const res = await workerFetch(post("/api/connect/cancel", { userId, flow }));
    expect(res.status).toBe(200);
    const body = ConnectCancelResponse.parse(await res.json());
    expect(body.cancelled).toBe(true);
  });

  it("POST /api/connect/cancel without a flow is a 400 ErrorResponse", async () => {
    const res = await workerFetch(
      post("/api/connect/cancel", { userId: "contract-flow-cancel-user" }),
    );
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });
});

// --- Session lifecycle (return-kind rule: the 409 refusal is a result) -------

describe("HTTP contract — session endpoints", () => {
  it("start (200 started), start again (409 refused), get, quit — all match their result schemas", async () => {
    const userId = "contract-session-user";

    const first = await workerFetch(post("/api/session/start", { userId }));
    expect(first.status).toBe(200);
    const started = StartSessionResponse.parse(await first.json());
    expect(started.status).toBe("started");

    // The 409 refusal validates against StartSessionResponse, NOT
    // ErrorResponse — it is load-bearing data the client attaches to.
    const second = await workerFetch(post("/api/session/start", { userId }));
    expect(second.status).toBe(409);
    const refused = StartSessionResponse.parse(await second.json());
    expect(refused.status).toBe("refused");

    const active = await workerFetch(get(`/api/session?userId=${userId}`));
    expect(active.status).toBe(200);
    const view = GetSessionResponse.parse(await active.json());
    expect(view.active).not.toBeNull();

    const quit = await workerFetch(post("/api/session/quit", { userId }));
    expect(quit.status).toBe(200);
    QuitResponse.parse(await quit.json());

    const after = await workerFetch(get(`/api/session?userId=${userId}`));
    const cleared = GetSessionResponse.parse(await after.json());
    expect(cleared.active).toBeNull();
  });
});

// --- Status aggregate read (session + grants + held) --------------------------

describe("HTTP contract — GET /api/tasks*", () => {
  it("GET /api/tasks matches TasksListResponse after a commission", async () => {
    const userId = "contract-tasks-user";
    // Drive a zero-action commission through the DO so a task exists, then read
    // the cross-origin list over HTTP.
    await runInDurableObject(stubFor(userId), async (instance) => {
      instance.setLLMClient(scriptedLLM([{ text: "nothing to do" }]));
      await instance.commissionGoal({
        goal: "check whether anything needs doing",
        userId,
        agentId: "onboarding",
      });
    });

    const res = await workerFetch(get(`/api/tasks?userId=${userId}`));
    expect(res.status).toBe(200);
    const body = TasksListResponse.parse(await res.json());
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
    expect(body.tasks[0]!.origin).toBe("mcp_commission");
  });

  it("GET /api/tasks/get matches TaskDetailResponse for a known task", async () => {
    const userId = "contract-taskdetail-user";
    let taskId = "";
    await runInDurableObject(stubFor(userId), async (instance) => {
      instance.setLLMClient(scriptedLLM([{ text: "done" }]));
      const out = await instance.commissionGoal({
        goal: "check whether anything needs doing",
        userId,
        agentId: "onboarding",
      });
      taskId = (out as { runId: string }).runId;
    });

    const res = await workerFetch(
      get(`/api/tasks/get?userId=${userId}&taskId=${taskId}`),
    );
    expect(res.status).toBe(200);
    const body = TaskDetailResponse.parse(await res.json());
    expect(body.task.taskId).toBe(taskId);
    expect(body.task.status).toBe("completed");
  });

  it("GET /api/tasks/get is 400 without a taskId and 404 for an unknown one", async () => {
    const missing = await workerFetch(get("/api/tasks/get?userId=contract-tasks-404"));
    expect(missing.status).toBe(400);
    ErrorResponse.parse(await missing.json());

    const unknown = await workerFetch(
      get("/api/tasks/get?userId=contract-tasks-404&taskId=nope"),
    );
    expect(unknown.status).toBe(404);
    ErrorResponse.parse(await unknown.json());
  });
});

describe("HTTP contract — GET /api/audit", () => {
  /** Seed `count` audit rows through the DO's real write path. */
  async function seedAudit(userId: string, count: number): Promise<void> {
    await runInDurableObject(stubFor(userId), (instance) => {
      const sql = bindDoSql(instance as never);
      for (let n = 0; n < count; n++) {
        al.insertAuditEntryInTxn(sql, {
          userId,
          agentId: "agent-1",
          sessionId: "session-1",
          toolName: "email_list_messages",
          service: "email",
          verb: "list",
          noun: "inbox",
          decision: "allow",
          parametersMetadata: {},
          outcome: "success",
          latencyMs: 1,
          epochId: "2026-07-01",
          timestamp: `2026-07-01T10:00:0${n % 10}.000Z`,
        });
      }
    });
  }

  it("matches AuditListResponse, newest first, with parameters_content absent from the raw JSON", async () => {
    const userId = "contract-audit-user";
    await seedAudit(userId, 3);

    const res = await workerFetch(get(`/api/audit?userId=${userId}`));
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { entries: Array<Record<string, unknown>> };
    const body = AuditListResponse.parse(raw);
    expect(body.entries.map((e) => e.sequenceNum)).toEqual([2, 1, 0]);
    expect(body.nextCursor).toBeNull();
    // The strict parse above already rejects unknown keys; this states the
    // load-bearing absence directly.
    for (const entry of raw.entries) {
      expect(Object.keys(entry)).not.toContain("parametersContent");
      expect(Object.keys(entry)).not.toContain("parameters_content");
    }
  });

  it("treats a blank ?limit= as absent — the default page, never a one-row page", async () => {
    const userId = "contract-audit-blank-limit";
    await seedAudit(userId, 3);

    // `Number("")` is 0, which would clamp to a ONE-row page if the blank were
    // parsed as a number; parseAuditListQuery must treat it as absent.
    const res = await workerFetch(get(`/api/audit?userId=${userId}&limit=`));
    const body = AuditListResponse.parse(await res.json());
    expect(body.entries).toHaveLength(3);

    const nonNumeric = await workerFetch(get(`/api/audit?userId=${userId}&limit=abc`));
    const nonNumericBody = AuditListResponse.parse(await nonNumeric.json());
    expect(nonNumericBody.entries).toHaveLength(3);

    const bounded = await workerFetch(get(`/api/audit?userId=${userId}&limit=2`));
    const boundedBody = AuditListResponse.parse(await bounded.json());
    expect(boundedBody.entries).toHaveLength(2);
    expect(boundedBody.nextCursor).not.toBeNull();
  });
});

describe("HTTP contract — POST /api/tasks/cancel", () => {
  it("cancels a parked task → 200 TaskCancelResponse (cancelled)", async () => {
    const userId = "contract-cancel-user";
    let taskId = "";
    await runInDurableObject(stubFor(userId), async (instance) => {
      instance.connectService("mock_email");
      // An ungranted list parks awaiting_confirmation — a cancellable task.
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_cancel")] }]));
      const out = await instance.commissionGoal({
        goal: "list inbox",
        userId,
        agentId: "onboarding",
      });
      taskId = (out as { runId: string }).runId;
    });

    const res = await workerFetch(post("/api/tasks/cancel", { userId, taskId }));
    expect(res.status).toBe(200);
    const body = TaskCancelResponse.parse(await res.json());
    expect(body.status).toBe("cancelled");
  });

  it("is 404 for an unknown task and 400 without a taskId", async () => {
    const unknown = await workerFetch(
      post("/api/tasks/cancel", { userId: "contract-cancel-404", taskId: "nope" }),
    );
    expect(unknown.status).toBe(404);
    ErrorResponse.parse(await unknown.json());

    const missing = await workerFetch(
      post("/api/tasks/cancel", { userId: "contract-cancel-400" }),
    );
    expect(missing.status).toBe(400);
    ErrorResponse.parse(await missing.json());
  });

  it("the human surface cancels a task of ANY origin, including human-origin", async () => {
    // The whole point of `surface: "human"` being authoritative over every origin,
    // asserted at the wire level rather than only in the DO test.
    const userId = "contract-cancel-anyorigin";
    await runInDurableObject(stubFor(userId), (instance) => {
      const sql = bindDoSql(instance as never);
      const now = "2026-07-06T10:00:00.000Z";
      sql`
        INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
        VALUES ('human-origin-task', 'human', 'a human task', NULL, 'awaiting_confirmation', 's-h', ${now}, ${now})
      `;
    });

    const res = await workerFetch(
      post("/api/tasks/cancel", { userId, taskId: "human-origin-task" }),
    );
    expect(res.status).toBe(200);
    const body = TaskCancelResponse.parse(await res.json());
    expect(body.status).toBe("cancelled");
  });

  it("GET /api/tasks honours ?limit= and a blank limit is not treated as 1", async () => {
    const userId = "contract-tasks-paged";
    await runInDurableObject(stubFor(userId), (instance) => {
      const sql = bindDoSql(instance as never);
      for (let n = 0; n < 3; n++) {
        const ts = `2026-07-06T10:0${n}:00.000Z`;
        const id = `t-${n}`;
        sql`
          INSERT INTO commission_runs (id, origin, goal, data, status, session_id, created_at, updated_at)
          VALUES (${id}, 'mcp_commission', 'g', NULL, 'completed', 's-p', ${ts}, ${ts})
        `;
      }
    });

    const paged = await workerFetch(get(`/api/tasks?userId=${userId}&limit=2`));
    expect(paged.status).toBe(200);
    const first = TasksListResponse.parse(await paged.json());
    expect(first.tasks).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    // Feeding the cursor back yields the remainder with no overlap.
    const next = await workerFetch(
      get(`/api/tasks?userId=${userId}&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );
    const second = TasksListResponse.parse(await next.json());
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]!.taskId).not.toBe(first.tasks[0]!.taskId);

    // A BLANK ?limit= must fall back to the default page size, not clamp to 1.
    const blank = await workerFetch(get(`/api/tasks?userId=${userId}&limit=`));
    const all = TasksListResponse.parse(await blank.json());
    expect(all.tasks).toHaveLength(3);

    // A garbage cursor is fail-safe: the first page, never a 500.
    const garbage = await workerFetch(get(`/api/tasks?userId=${userId}&cursor=%25%25%25`));
    expect(garbage.status).toBe(200);
    TasksListResponse.parse(await garbage.json());
  });

  it("returns not_cancellable (200) for an already-terminal task", async () => {
    const userId = "contract-cancel-terminal";
    let taskId = "";
    await runInDurableObject(stubFor(userId), async (instance) => {
      // A zero-action commission completes immediately — a terminal task.
      instance.setLLMClient(scriptedLLM([{ text: "nothing to do" }]));
      const out = await instance.commissionGoal({
        goal: "check whether anything needs doing",
        userId,
        agentId: "onboarding",
      });
      taskId = (out as { runId: string }).runId;
    });

    const res = await workerFetch(post("/api/tasks/cancel", { userId, taskId }));
    expect(res.status).toBe(200);
    const body = TaskCancelResponse.parse(await res.json());
    expect(body.status).toBe("not_cancellable");
    if (body.status === "not_cancellable") expect(body.currentStatus).toBe("completed");
  });
});

describe("HTTP contract — GET /api/status", () => {
  it("matches StatusResponse with a live session, a grant, and a pending held call", async () => {
    const userId = "contract-status-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
    });
    // Drive a held turn so the aggregate carries a session + a held record.
    await workerFetch(post("/api/chat", { userId, message: "list inbox" }));

    const res = await workerFetch(get(`/api/status?userId=${userId}`));
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.session).not.toBeNull();
    expect(body.held[0]?.service).toBe("mock_email");
    // The held turn wrote audit rows, so the aggregate carries the chain tail
    // two non-empty hashes, nothing more.
    expect(body.auditTail?.hash).toBeTruthy();
    expect(body.auditTail?.prevHash).toBeTruthy();
  });

  it("matches StatusResponse for a fresh user (no session, no grants, no held, empty-log tail)", async () => {
    const res = await workerFetch(get("/api/status?userId=contract-status-empty-user"));
    expect(res.status).toBe(200);
    const body = StatusResponse.parse(await res.json());
    expect(body.session).toBeNull();
    expect(body.grants).toEqual([]);
    expect(body.held).toEqual([]);
    expect(body.auditTail).toBeNull();
  });

  it("two holds parked over HTTP are BOTH listed; resolving one leaves the other", async () => {
    // The defect the list shape closes: /api/tools/execute could park a
    // second call while one was already parked, and /api/status showed only
    // the oldest — a live, answerable confirmation the user was never shown.
    // Entered through the HTTP boundary on purpose: the two-request state is
    // exactly what a runInDurableObject test cannot witness being built.
    const userId = "contract-status-two-holds-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
    });
    const park = async (label: string): Promise<string> => {
      const res = await workerFetch(
        post("/api/tools/execute", {
          userId,
          toolName: "mock_email_list",
          params: { label },
        }),
      );
      expect(res.status).toBe(200);
      const body = ExecuteToolResponse.parse(await res.json());
      expect(body.decision).toBe("pending");
      return body.held!.heldCallId;
    };
    const first = await park("INBOX");
    const second = await park("SENT");
    expect(first).not.toBe(second);

    // Both visible at once, none hidden. (The two can park inside the same
    // millisecond, where order falls to the id tiebreak — assert membership,
    // then work the list front-first like a client would.)
    const listed = StatusResponse.parse(
      await (await workerFetch(get(`/api/status?userId=${userId}`))).json(),
    );
    expect(listed.held.map((h) => h.heldCallId).sort()).toEqual([first, second].sort());

    // Resolving the front of the list leaves the other one still listed.
    const front = listed.held[0]!;
    const resolved = await workerFetch(
      post("/api/resolve", { userId, heldCallId: front.heldCallId, choice: "deny" }),
    );
    expect(resolved.status).toBe(200);
    const after = StatusResponse.parse(
      await (await workerFetch(get(`/api/status?userId=${userId}`))).json(),
    );
    const remaining = front.heldCallId === first ? second : first;
    expect(after.held.map((h) => h.heldCallId)).toEqual([remaining]);
  });

  it("StatusResponse envelope is strict but HeldCallRecord.params stays open", () => {
    // Strict envelope: an unknown key at the described depth fails parse
    // (additive drift is caught, not silently stripped).
    expect(() =>
      StatusResponse.parse({ session: null, grants: [], held: [], auditTail: null, extra: 1 }),
    ).toThrow();
    // But `params` is an open record (arbitrary tool arguments), so a held
    // record with unknown param keys parses.
    const ok = StatusResponse.parse({
      session: null,
      grants: [],
      held: [
        {
          heldCallId: "h1",
          service: "mock_email",
          verb: "send",
          noun: "draft",
          params: { to: "a@b.com", subject: "hi", anythingGoes: { nested: true } },
        },
      ],
      auditTail: null,
    });
    expect(ok.held[0]?.params.anythingGoes).toEqual({ nested: true });
  });

  it("auditTail is required, nullable, and strict — two hashes, nothing else", () => {
    // The object form parses; prevHash is non-nullable (GENESIS sentinel, not
    // NULL, on the chain's first entry).
    const tailed = StatusResponse.parse({
      session: null,
      grants: [],
      held: [],
      auditTail: { hash: "a".repeat(64), prevHash: "GENESIS" },
    });
    expect(tailed.auditTail?.hash).toBe("a".repeat(64));
    // Absent field fails — the tail is a required key on the envelope.
    expect(() => StatusResponse.parse({ session: null, grants: [], held: [] })).toThrow();
    // Partial or widened tails fail — metadata only, no row count, no extras.
    expect(() =>
      StatusResponse.parse({
        session: null,
        grants: [],
        held: [],
        auditTail: { hash: "a".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      StatusResponse.parse({
        session: null,
        grants: [],
        held: [],
        auditTail: { hash: "a", prevHash: "b", rowCount: 12 },
      }),
    ).toThrow();
  });

  it("HeldCallRecord carries optional commission origin/goal, both bounded", () => {
    const commissioned = StatusResponse.parse({
      session: null,
      grants: [],
      held: [
        {
          heldCallId: "h1",
          service: "mock_email",
          verb: "send",
          noun: "draft",
          params: {},
          origin: "mcp_commission",
          goal: "send the report",
        },
      ],
      auditTail: null,
    });
    expect(commissioned.held[0]?.origin).toBe("mcp_commission");
    expect(commissioned.held[0]?.goal).toBe("send the report");
    // origin is a closed enum — an arbitrary provenance string is rejected.
    expect(() =>
      StatusResponse.parse({
        session: null,
        grants: [],
        held: [{ heldCallId: "h", service: "s", verb: "v", noun: "n", params: {}, origin: "user_typed" }],
        auditTail: null,
      }),
    ).toThrow();
    // goal mirrors the ingest cap (4000) — an over-long goal is rejected at the wire.
    expect(() =>
      StatusResponse.parse({
        session: null,
        grants: [],
        held: [{ heldCallId: "h", service: "s", verb: "v", noun: "n", params: {}, goal: "x".repeat(4001) }],
        auditTail: null,
      }),
    ).toThrow();
  });
});

// --- Chat (mirror endpoint) ---------------------------------------------------

describe("HTTP contract — GET /api/dev/* (visual model)", () => {
  it("GET /api/dev/model matches GovernanceSnapshotResponse with live state", async () => {
    const userId = "contract-devmodel-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
    });
    await workerFetch(post("/api/chat", { userId, message: "list inbox" }));

    const res = await workerFetch(get(`/api/dev/model?userId=${userId}`));
    expect(res.status).toBe(200);
    const body = GovernanceSnapshotResponse.parse(await res.json());
    expect(body.userId).toBe(userId);
    expect(body.session).not.toBeNull();
    expect(body.held[0]?.sessionId).toBe(body.session!.sessionId);
    expect(body.policyEntries.some((pe) => pe.source === "standing")).toBe(true);
  });

  it("GET /api/dev/model matches GovernanceSnapshotResponse for a fresh user", async () => {
    const res = await workerFetch(get("/api/dev/model?userId=contract-devmodel-empty"));
    expect(res.status).toBe(200);
    const body = GovernanceSnapshotResponse.parse(await res.json());
    expect(body.session).toBeNull();
    expect(body.audit).toEqual({ recent: [], total: 0 });
  });

  it("GET /api/dev/contracts matches ContractDescriptorsResponse", async () => {
    const res = await workerFetch(get("/api/dev/contracts"));
    expect(res.status).toBe(200);
    const body = ContractDescriptorsResponse.parse(await res.json());
    expect(body.routes.length).toBeGreaterThan(10);
  });
});

describe("HTTP contract — POST /api/chat", () => {
  it("a plain text turn matches ChatResponse", async () => {
    const userId = "contract-chat-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.setLLMClient(scriptedLLM([{ text: "hello" }]));
    });
    const res = await workerFetch(post("/api/chat", { userId, message: "hi" }));
    expect(res.status).toBe(200);
    ChatResponse.parse(await res.json());
  });

  it("a held turn matches ChatResponse (held branch, outcome 'held')", async () => {
    const userId = "contract-chat-held-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
    });
    const res = await workerFetch(
      post("/api/chat", { userId, message: "list inbox" }),
    );
    expect(res.status).toBe(200);
    const body = ChatResponse.parse(await res.json());
    expect(body.held?.heldCallId).toBeTruthy();
    expect(body.toolCalls.at(-1)?.outcome).toBe("held");
  });
});

// --- tools/execute (projection endpoint — every wire-shape-changing variant) --

describe("HTTP contract — POST /api/tools/execute (narrowed projection)", () => {
  it("allow-with-execution matches ExecuteToolResponse and ships no governance internals", async () => {
    const userId = "contract-exec-allow-user";
    const ciphertext = await seedCiphertext();
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      // Task grants are session-scoped: mint under the DO's single
      // active session, which /api/tools/execute resolves to the same id.
      const sessionId = instance.resolveActiveSession({ userId, agentId: "default" });
      instance.createTaskGrant("mock_email", "list", "INBOX", sessionId);
    });

    const res = await workerFetch(
      post("/api/tools/execute", {
        userId,
        toolName: "mock_email_list",
        params: { label: "INBOX" },
      }),
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Raw;
    const body = ExecuteToolResponse.parse(raw);
    expect(body.decision).toBe("allow");
    expect(body.execution?.success).toBe(true);
    // The projection's guard: the internal governance blob (auditEntry,
    // matchedEntryId, matchedSource) must be absent from the executed body.
    expect("governance" in raw).toBe(false);
    expect("auditEntry" in raw).toBe(false);
    expect("matchedEntryId" in raw).toBe(false);
    expect("matchedSource" in raw).toBe(false);
  });

  it("deny carries denyReason and matches ExecuteToolResponse", async () => {
    // No connect: the governed call denies with not_connected.
    const res = await workerFetch(
      post("/api/tools/execute", {
        userId: "contract-exec-deny-user",
        toolName: "mock_email_list",
        params: { label: "INBOX" },
      }),
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Raw;
    const body = ExecuteToolResponse.parse(raw);
    expect(body.decision).toBe("deny");
    expect(body.denyReason).toBe("not_connected");
    expect("governance" in raw).toBe(false);
  });

  it("pending ships held.heldCallId only — pendingAuditEntryId is dropped", async () => {
    const userId = "contract-exec-pending-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email"); // connected, un-granted → held
    });

    const res = await workerFetch(
      post("/api/tools/execute", {
        userId,
        toolName: "mock_email_list",
        params: { label: "INBOX" },
      }),
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Raw;
    const body = ExecuteToolResponse.parse(raw);
    expect(body.decision).toBe("pending");
    expect(body.held?.heldCallId).toBeTruthy();
    // The internal audit-entry id exists only on this variant internally —
    // assert it is absent from the wire's held object.
    expect("pendingAuditEntryId" in (raw.held as Raw)).toBe(false);
  });
});

// --- resolve (projection endpoint: info / resumed; not_found is an error) -----

describe("HTTP contract — POST /api/resolve", () => {
  it("'tell_more' returns the info variant of ResolveResponse", async () => {
    const userId = "contract-resolve-info-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
    });
    const held = ChatResponse.parse(
      await (
        await workerFetch(post("/api/chat", { userId, message: "list inbox" }))
      ).json(),
    );

    const res = await workerFetch(
      post("/api/resolve", {
        userId,
        heldCallId: held.held!.heldCallId,
        choice: "tell_more",
      }),
    );
    expect(res.status).toBe(200);
    const body = ResolveResponse.parse(await res.json());
    expect(body.status).toBe("info");
  });

  it("'session' resumes the turn: the resumed variant embeds a full ChatResponse", async () => {
    const userId = "contract-resolve-resume-user";
    const ciphertext = await seedCiphertext(); // resume executes the tool
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email", ciphertext);
      instance.setLLMClient(
        scriptedLLM([{ tools: [toolUse("toolu_1")] }, { text: "resumed fine" }]),
      );
    });
    const held = ChatResponse.parse(
      await (
        await workerFetch(post("/api/chat", { userId, message: "list inbox" }))
      ).json(),
    );

    const res = await workerFetch(
      post("/api/resolve", {
        userId,
        heldCallId: held.held!.heldCallId,
        choice: "session",
      }),
    );
    expect(res.status).toBe(200);
    const body = ResolveResponse.parse(await res.json());
    expect(body.status).toBe("resumed");
  });

  it("an unknown heldCallId is a 404 ErrorResponse, not a result variant", async () => {
    const res = await workerFetch(
      post("/api/resolve", {
        userId: "contract-resolve-404-user",
        heldCallId: "no-such-held-call",
        choice: "deny",
      }),
    );
    expect(res.status).toBe(404);
    ErrorResponse.parse(await res.json());
  });

  it("'approve_once' on an ordinary hold is a 400 ErrorResponse — the choice is spend-hold-only", async () => {
    const userId = "contract-resolve-approve-once-user";
    await runInDurableObject(stubFor(userId), (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(scriptedLLM([{ tools: [toolUse("toolu_1")] }]));
    });
    const held = ChatResponse.parse(
      await (
        await workerFetch(post("/api/chat", { userId, message: "list inbox" }))
      ).json(),
    );

    const res = await workerFetch(
      post("/api/resolve", {
        userId,
        heldCallId: held.held!.heldCallId,
        choice: "approve_once",
      }),
    );
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });
});

// --- Error envelope ------------------------------------------------------------

describe("HTTP contract — error-envelope returns match ErrorResponse", () => {
  it("validation failure (400)", async () => {
    const res = await workerFetch(post("/api/chat", { userId: "u" }));
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });

  it("kill with a non-string userId (400) — validated, not cast to idFromName", async () => {
    const res = await workerFetch(post("/api/kill", { userId: 42 }));
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });

  it("malformed JSON body (400)", async () => {
    const res = await workerFetch(
      new Request("http://localhost/api/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    ErrorResponse.parse(await res.json());
  });

  it("unknown API route (404)", async () => {
    const res = await workerFetch(get("/api/no-such-route"));
    expect(res.status).toBe(404);
    ErrorResponse.parse(await res.json());
  });

  it("unknown connect service (400) carries error_code within the envelope", async () => {
    const res = await workerFetch(post("/connect/nope?userId=u", {}));
    expect(res.status).toBe(400);
    const body = ErrorResponse.parse(await res.json());
    expect(body.error_code).toBe("UNKNOWN_SERVICE");
  });
});
