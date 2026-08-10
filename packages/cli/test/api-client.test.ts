import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CatalogResponse,
  ChatResponse,
  ConnectCancelResponse,
  ConnectFlowStatusResponse,
  ConnectResponse,
  DisconnectResponse,
  ErrorResponse,
  GetSessionResponse,
  KillResponse,
  PolicyResponse,
  QuitResponse,
  ResolveResponse,
  ServicesResponse,
  StartSessionResponse,
  StatusResponse,
} from "@habenula-ai/contracts";
import {
  ApiClient,
  ApiError,
  CHAT_DEADLINE_MS,
  CONTROL_DEADLINE_MS,
  EngineUnavailableError,
  type FetchFn,
} from "../src/api-client";
import type { InternalDriver } from "../src/internal-client";

/**
 * A capturing fake for the internal drive interface. `chat` / `resolve` /
 * `getStatus` delegate to this; the WIRE behavior of
 * the real driver lives in internal-client.test.ts, so here we assert only that
 * `ApiClient` forwards to it. A fetch that throws if called proves the delegated
 * methods never touch the `/api/*` transport.
 */
function fakeInternal(
  impl: Partial<InternalDriver> = {},
): InternalDriver & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    chat: async (message) => {
      calls.push(["chat", [message]]);
      return (
        impl.chat?.(message) ??
        ({
          response: "",
          toolCalls: [],
          iterations: 1,
          usage: { inputTokens: 0, outputTokens: 0 },
        } as never)
      );
    },
    resolve: async (heldCallId, choice) => {
      calls.push(["resolve", [heldCallId, choice]]);
      return (
        impl.resolve?.(heldCallId, choice) ??
        ({ status: "info", metadata: { service: "", verb: "", noun: "", description: "" } } as never)
      );
    },
    getStatus: async () => {
      calls.push(["getStatus", []]);
      return impl.getStatus?.() ?? ({ session: null, grants: [], held: [] } as never);
    },
  };
}

const throwingFetch: FetchFn = async () => {
  throw new Error("delegated methods must not touch the /api transport");
};

/**
 * Pin a canned fixture to its wire schema before serving it, so these
 * hand-written bodies cannot drift from the contract the engine actually
 * ships (the same producer/consumer duplication, one layer
 * down). Typed `body: T` for edit-time checking; `parse` for the strict
 * runtime check.
 */
function wire<T>(schema: { parse(value: unknown): T }, body: T): T {
  return schema.parse(body);
}

interface RecordedCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

interface CannedResponse {
  status?: number;
  body: unknown;
}

function makeFetch(canned: CannedResponse | CannedResponse[]): {
  fetchFn: FetchFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(canned) ? [...canned] : [canned];
  const fetchFn: FetchFn = async (input, init) => {
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    });
    const next = queue.length === 1 ? queue[0]! : queue.shift()!;
    const status = next.status ?? 200;
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

const config = {
  apiUrl: "http://api.test",
  userId: "test-user",
  humanTouch: false,
};

describe("ApiClient", () => {
  let client: ApiClient;
  let calls: RecordedCall[];

  function setup(canned: CannedResponse | CannedResponse[]): void {
    const f = makeFetch(canned);
    calls = f.calls;
    client = new ApiClient(config, f.fetchFn);
  }

  beforeEach(() => {
    calls = [];
  });

  describe("chat", () => {
    // chat drives the trusted internal MCP interface, not /api/chat.
    // ApiClient forwards to the injected driver; the
    // JSON-RPC wire is covered in internal-client.test.ts.
    it("delegates to the internal drive interface and returns its result", async () => {
      const turn = wire(ChatResponse, {
        response: "hi",
        toolCalls: [
          { name: "email_list_messages", id: "tu_1", outcome: "success" },
        ],
        iterations: 2,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const internal = fakeInternal({ chat: async () => turn });
      const c = new ApiClient(config, throwingFetch, internal);

      const result = await c.chat("hello");

      expect(internal.calls).toEqual([["chat", ["hello"]]]);
      expect(result.response).toBe("hi");
      expect(result.iterations).toBe(2);
    });
  });

  describe("listServices", () => {
    it("GETs /api/services with userId query param", async () => {
      setup({
        body: wire(ServicesResponse, {
          services: [{ service: "email", connected_at: "2026-04-10" }],
        }),
      });

      const result = await client.listServices();

      expect(calls[0]!.url).toBe("http://api.test/api/services?userId=test-user");
      expect(calls[0]!.method).toBe("GET");
      expect(result.services).toHaveLength(1);
      expect(result.services[0]!.service).toBe("email");
    });
  });

  describe("getCatalog", () => {
    it("GETs /api/services/catalog without a userId (discovery is user-free)", async () => {
      setup({
        body: wire(CatalogResponse, {
          services: [{ service: "gmail" }, { service: "mock_email" }],
        }),
      });

      const result = await client.getCatalog();

      expect(calls[0]!.url).toBe("http://api.test/api/services/catalog");
      expect(calls[0]!.method).toBe("GET");
      expect(result.services.map((s) => s.service)).toEqual([
        "gmail",
        "mock_email",
      ]);
    });
  });

  describe("getPolicy", () => {
    // The standing-allow mutate path (POST /api/policy / setPolicy) was
    // removed — only the read-only GET remains.
    it("GETs /api/policy with userId query param", async () => {
      setup({
        body: wire(PolicyResponse, { effectiveDecision: "deny", entries: [] }),
      });

      const result = await client.getPolicy();

      expect(calls[0]!.url).toBe("http://api.test/api/policy?userId=test-user");
      expect(calls[0]!.method).toBe("GET");
      expect(result.effectiveDecision).toBe("deny");
    });
  });

  describe("kill", () => {
    it("POSTs /api/kill and returns the killed flag (no disconnected list)", async () => {
      setup({ body: wire(KillResponse, { killed: true }) });

      const result = await client.kill();

      expect(calls[0]!.url).toBe("http://api.test/api/kill");
      expect(calls[0]!.method).toBe("POST");
      expect(result.killed).toBe(true);
      // The kill no longer disconnects, so the response carries no service list.
      expect("disconnected" in result).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("POSTs /api/services/disconnect with the service", async () => {
      setup({
        body: wire(DisconnectResponse, { disconnected: "email", removed: true }),
      });

      const result = await client.disconnect("email");

      expect(calls[0]!.url).toBe("http://api.test/api/services/disconnect");
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        userId: "test-user",
        service: "email",
      });
      expect(result.disconnected).toBe("email");
      expect(result.removed).toBe(true);
    });
  });

  describe("connect", () => {
    it("POSTs /connect/<service> with userId and returns the authorize URL", async () => {
      setup({
        body: wire(ConnectResponse, {
          authorizeUrl: "http://api.test/oauth/mock_email/authorize",
          flow: "flow-123",
        }),
      });

      const result = await client.connect("mock_email");

      expect(calls[0]!.url).toBe(
        "http://api.test/connect/mock_email?userId=test-user",
      );
      expect(calls[0]!.method).toBe("POST");
      expect(result).toEqual({
        authorizeUrl: "http://api.test/oauth/mock_email/authorize",
        flow: "flow-123",
      });
    });

    it("GETs /api/connect/status with userId, service, and flow", async () => {
      setup({
        body: wire(ConnectFlowStatusResponse, { status: "pending" }),
      });

      const result = await client.getConnectFlowStatus("mock_email", "flow-9");

      expect(calls[0]!.url).toBe(
        "http://api.test/api/connect/status?userId=test-user&service=mock_email&flow=flow-9",
      );
      expect(calls[0]!.method).toBe("GET");
      expect(result).toEqual({ status: "pending" });
    });

    it("POSTs /api/connect/cancel with userId and flow", async () => {
      setup({
        body: wire(ConnectCancelResponse, { cancelled: true }),
      });

      const result = await client.cancelConnectFlow("flow-9");

      expect(calls[0]!.url).toBe("http://api.test/api/connect/cancel");
      expect(calls[0]!.method).toBe("POST");
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        userId: "test-user",
        flow: "flow-9",
      });
      expect(result).toEqual({ cancelled: true });
    });

    it("URL-encodes the service name and userId", async () => {
      const f = makeFetch({ body: wire(ConnectResponse, { connected: "a/b" }) });
      const c = new ApiClient(
        { apiUrl: "http://api.test", userId: "a b/c", humanTouch: false },
        f.fetchFn,
      );

      await c.connect("a/b");

      expect(f.calls[0]!.url).toBe(
        "http://api.test/connect/a%2Fb?userId=a%20b%2Fc",
      );
    });

    it("throws ApiError for an unknown service (400)", async () => {
      setup({
        status: 400,
        body: wire(ErrorResponse, { error: "Unknown service 'nope'" }),
      });

      await expect(client.connect("nope")).rejects.toThrow(ApiError);
      await expect(client.connect("nope")).rejects.toThrow(
        "Unknown service 'nope'",
      );
    });
  });

  describe("session lifecycle", () => {
    const view = {
      sessionId: "session-abc",
      startedAt: "2026-07-03T11:48:00.000Z",
      expiry: "2026-07-03T13:18:00.000Z",
    };

    it("startSession POSTs /api/session/start and parses a started result", async () => {
      setup({
        body: wire(StartSessionResponse, {
          status: "started",
          activeSession: view,
        }),
      });

      const result = await client.startSession();

      expect(calls[0]!.url).toBe("http://api.test/api/session/start");
      expect(calls[0]!.method).toBe("POST");
      expect(JSON.parse(calls[0]!.body!)).toEqual({ userId: "test-user" });
      expect(result).toEqual({ status: "started", activeSession: view });
    });

    it("startSession parses the 409 refusal payload as a result, NOT an ApiError", async () => {
      // The refusal is an expected outcome the REPL attaches to — a session
      // is already active and the payload names it.
      setup({
        status: 409,
        body: wire(StartSessionResponse, {
          status: "refused",
          activeSession: view,
        }),
      });

      const result = await client.startSession();

      expect(result).toEqual({ status: "refused", activeSession: view });
    });

    it("startSession still throws ApiError on other failures", async () => {
      setup({ status: 500, body: wire(ErrorResponse, { error: "boom" }) });

      await expect(client.startSession()).rejects.toThrow(ApiError);
    });

    it("quit POSTs /api/session/quit and parses { ended }", async () => {
      setup({ body: wire(QuitResponse, { ended: true }) });

      const result = await client.quit();

      expect(calls[0]!.url).toBe("http://api.test/api/session/quit");
      expect(JSON.parse(calls[0]!.body!)).toEqual({ userId: "test-user" });
      expect(result).toEqual({ ended: true });
    });

    it("getActiveSession GETs /api/session with the userId and parses { active }", async () => {
      setup({ body: wire(GetSessionResponse, { active: null }) });

      const result = await client.getActiveSession();

      expect(calls[0]!.url).toBe("http://api.test/api/session?userId=test-user");
      expect(calls[0]!.method).toBe("GET");
      expect(result).toEqual({ active: null });
    });
  });

  describe("getStatus", () => {
    // The snapshot now comes from the internal `status` drive tool, not
    // /api/status. ApiClient forwards to the driver.
    it("delegates to the internal drive interface and returns its snapshot", async () => {
      const snapshot = wire(StatusResponse, {
        session: {
          sessionId: "s1",
          startedAt: "2026-07-03T11:48:00.000Z",
          expiry: "2026-07-03T13:18:00.000Z",
        },
        grants: [
          { service: "mock_email", verb: "list", noun: "INBOX", source: "session", expiresAt: null },
        ],
        held: [],
        auditTail: null,
      });
      const internal = fakeInternal({ getStatus: async () => snapshot });
      const c = new ApiClient(config, throwingFetch, internal);

      const result = await c.getStatus();

      expect(internal.calls).toEqual([["getStatus", []]]);
      expect(result.grants).toHaveLength(1);
      expect(result.held).toEqual([]);
    });
  });

  describe("resolve", () => {
    // resolve drives the internal `resolve` tool;
    // ApiClient forwards heldCallId + choice. The not_found→404 / busy→409
    // mapping and wire framing are covered in internal-client.test.ts.
    it("delegates to the internal drive interface with heldCallId + choice", async () => {
      const info = wire(ResolveResponse, {
        status: "info",
        metadata: { service: "mock_email", verb: "list", noun: "INBOX", description: "Lists mail." },
      });
      const internal = fakeInternal({ resolve: async () => info });
      const c = new ApiClient(config, throwingFetch, internal);

      const result = await c.resolve("held-1", "tell_more");

      expect(internal.calls).toEqual([["resolve", ["held-1", "tell_more"]]]);
      expect(result.status).toBe("info");
    });

    it("propagates a thrown ApiError (e.g. 404 expired / 409 in-flight) unchanged", async () => {
      const internal = fakeInternal({
        resolve: async () => {
          throw new ApiError(404, "held call not found");
        },
      });
      const c = new ApiClient(config, throwingFetch, internal);
      await expect(c.resolve("gone", "deny")).rejects.toMatchObject({ status: 404 });
    });
  });

 describe("availability", () => {
    /** A fetch that never returns headers but honors its abort signal, the way
     * a real fetch does — a bare never-resolving promise would dodge the
     * deadline abort and hang the test. */
    const stalledFetch: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("classifies a transport reject as EngineUnavailableError(kind: 'reject') carrying the apiUrl", async () => {
      const fetchFn: FetchFn = async () => {
        throw new TypeError("fetch failed");
      };
      const c = new ApiClient(config, fetchFn);

      // getPolicy still rides the /api GET request core (getStatus moved to the
      // internal interface — its reject classification is in internal-client.test.ts).
      const promise = c.getPolicy();
      await expect(promise).rejects.toBeInstanceOf(EngineUnavailableError);
      await expect(promise).rejects.toMatchObject({
        kind: "reject",
        apiUrl: "http://api.test",
      });
    });

    it("classifies the POST path's transport reject too (new plumbing on the mutating half)", async () => {
      const fetchFn: FetchFn = async () => {
        throw new TypeError("fetch failed");
      };
      const c = new ApiClient(config, fetchFn);

      await expect(c.kill()).rejects.toMatchObject({
        name: "EngineUnavailableError",
        kind: "reject",
      });
    });

    it("a control request whose headers never arrive rejects with kind 'deadline' at CONTROL_DEADLINE_MS, not a hang", async () => {
      vi.useFakeTimers();
      const c = new ApiClient(config, stalledFetch);

      const promise = c.getStatus();
      const assertion = expect(promise).rejects.toMatchObject({
        name: "EngineUnavailableError",
        kind: "deadline",
      });
      await vi.advanceTimersByTimeAsync(CONTROL_DEADLINE_MS);
      await assertion;
    });

    it("a chat turn whose BODY stalls after headers rejects with kind 'deadline' at CHAT_DEADLINE_MS (the timer spans the body read)", async () => {
      vi.useFakeTimers();
      // Headers resolve immediately; the body read honors the abort — proving
      // the deadline timer is cleared in `finally`, not at fetch-resolve.
      const fetchFn: FetchFn = async (_input, init) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("This operation was aborted", "AbortError")),
              );
            }),
        }) as unknown as Response;
      const c = new ApiClient(config, fetchFn);

      const promise = c.chat("hello");
      let settled = false;
      const assertion = expect(
        promise.finally(() => {
          settled = true;
        }),
      ).rejects.toMatchObject({
        name: "EngineUnavailableError",
        kind: "deadline",
      });
      // Past the control deadline the chat turn is still pending — the chat
      // class gets the minutes-scale bound, not the control one.
      await vi.advanceTimersByTimeAsync(CONTROL_DEADLINE_MS);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(CHAT_DEADLINE_MS - CONTROL_DEADLINE_MS);
      await assertion;
    });

    it("a reachable-engine HTTP error is never demoted to an availability failure", async () => {
      setup({ status: 500, body: wire(ErrorResponse, { error: "boom" }) });

      const promise = client.getStatus();
      await expect(promise).rejects.toBeInstanceOf(ApiError);
      await expect(promise).rejects.not.toBeInstanceOf(EngineUnavailableError);
    });

    it("a caller-signal abort (the connect wait's cancel) rethrows raw — neither reject nor deadline", async () => {
      // an abort from any source other than the
      // layer's own timer must not be classified as an availability failure —
      // runConnect's cancel handling branches on `signal.aborted`, not type.
      const c = new ApiClient(config, stalledFetch);
      const controller = new AbortController();

      const promise = c.connect("mock_email", controller.signal);
      const assertion = expect(promise).rejects.toSatisfy(
        (err) => !(err instanceof EngineUnavailableError),
      );
      controller.abort();
      await assertion;
    });

    describe("probeHealth", () => {
      const HEALTH_BODY = { status: "ok", engine: "habenula-engine" };

      it("returns true on a 200 whose body matches the health shape", async () => {
        setup({ body: HEALTH_BODY });
        await expect(client.probeHealth()).resolves.toBe(true);
        expect(calls[0]!.url).toBe("http://api.test/api/health");
      });

      it("returns false on a transport reject (never throws)", async () => {
        const c = new ApiClient(config, async () => {
          throw new TypeError("fetch failed");
        });
        await expect(c.probeHealth()).resolves.toBe(false);
      });

      it("returns false on a non-200 (an older engine 404s the route)", async () => {
        setup({ status: 404, body: { error: "Not found" } });
        await expect(client.probeHealth()).resolves.toBe(false);
      });

      it("returns false on a 200 whose body lacks the by-value discriminant", async () => {
        // A vacuous {} — or a stray 200 carrying status:"ok" from an unrelated
        // server — must not read as a reachable engine.
        for (const body of [
          {},
          { status: "ok" },
          { status: "ok", engine: "someone-else", version: "1.0" },
          { status: "degraded", engine: "habenula-engine", version: "1.0" },
          "ok",
          null,
        ]) {
          setup({ body });
          await expect(client.probeHealth()).resolves.toBe(false);
        }
      });

      it("returns false on a non-JSON 200 body", async () => {
        const c = new ApiClient(config, async () => new Response("<html>ok</html>", { status: 200 }));
        await expect(c.probeHealth()).resolves.toBe(false);
      });
    });
  });

  describe("error handling", () => {
    it("throws ApiError with the parsed error message on non-2xx JSON", async () => {
      setup({
        status: 400,
        body: wire(ErrorResponse, { error: "service is required" }),
      });

      // getPolicy exercises the /api parse path (chat moved to the internal
      // interface — its error mapping is in internal-client.test.ts).
      await expect(client.getPolicy()).rejects.toThrow(ApiError);
      await expect(client.getPolicy()).rejects.toThrow("service is required");
    });

 it("surfaces a concise status message, not the raw HTML page, on a non-JSON 5xx", async () => {
      // A local miniflare 500 returns a full HTML error-overlay page; the REPL
      // prints ApiError.message verbatim, so the raw body must never surface.
      const html =
        "<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Error 500</h1><pre>stack…</pre></body></html>";
      const fetchFn: FetchFn = async () => new Response(html, { status: 500 });
      const c = new ApiClient(config, fetchFn);

      const promise = c.kill();
      await expect(promise).rejects.toThrow(ApiError);
      await expect(promise).rejects.toMatchObject({ status: 500, message: "engine error (500)" });
      await expect(promise).rejects.not.toThrow("<html");
    });
  });
});
