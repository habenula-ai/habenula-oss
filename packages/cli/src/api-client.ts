// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AuditListResponse,
  CatalogResponse,
  ChatResponse,
  ConnectCancelResponse,
  ConnectFlowStatusResponse,
  ConnectResponse,
  DisconnectResponse,
  ErrorResponse,
  GetSessionResponse,
  HealthResponse,
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
import { requireUsableConfig, type Config } from "./config";
import { InternalClient, type InternalDriver } from "./internal-client";
import { nodeFetch } from "./transport";

// The wire shapes are defined once in @habenula-ai/contracts and
// consumed here type-only, so no zod runtime enters the CLI. Re-exported for
// the rest of the CLI (repl-meta renders sessions and tool-call outcomes).
export type {
  ActiveSessionView,
  AuditChainEntry,
  AuditListResponse,
  GrantView,
  HeldCallRecord,
  SettingsResponse,
  StatusResponse,
  TaskActionDetail,
  TaskCancelResponse,
  TaskDetailResponse,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
  TasksListResponse,
  ToolCallOutcome,
} from "@habenula-ai/contracts";

/**
 * The confirmation choices a resolve carries (`POST /api/resolve`). The
 * canonical enum is `RESOLVE_CHOICES` in the contracts request schema; mirrored
 * here as a type so the CLI stays type-only against the package (no zod
 * runtime enters the CLI). `approve_once` is the spend hold's affirmative
 * answer: dispatches the one parked order, mints nothing.
 */
export type ResolveChoice =
  | "deny"
  | "tell_more"
  | "task"
  | "session"
  | "approve_once";

export type FetchFn = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * Machine-readable code from the error body's `error_code`, when present.
     * Callers branch on this rather than the human-readable message, which is
     * free to change without breaking them.
     */
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The typed availability failure: the engine is
 * *unavailable* — `fetch` rejected, or the request layer's own deadline
 * expired — as opposed to `ApiError` (engine reachable, returned an error).
 * `kind` is load-bearing: `formatError` picks the message variant by it, and
 * the REPL tracker's flap rule branches on it. The `message` here is a terse
 * fallback; the user-facing string is `unavailableGuidance`'s job.
 */
export class EngineUnavailableError extends Error {
  constructor(
    public readonly apiUrl: string,
    public readonly kind: "reject" | "deadline",
    cause?: unknown,
  ) {
    // Thread the underlying rejection through the standard Error `cause`
    // option rather than a shadowing own field, so `.cause` and stack
    // unwinding behave like any other wrapped error.
    super(
      kind === "deadline"
        ? `engine not responding at ${apiUrl}`
        : `engine not reachable at ${apiUrl}`,
      { cause },
    );
    this.name = "EngineUnavailableError";
  }
}

/**
 * Request deadlines: every request is bounded so a
 * stalled engine cannot hang a command. Two classes — control operations
 * (seconds-scale; subsumes the poll read's former per-read timeout) and the
 * chat turn (minutes-scale, since it fronts an LLM call). Source constants,
 * tunable; not config.
 *
 * The chat bound is DERIVED, not chosen freely: the engine's ceiling on one
 * model call is ten minutes (`REQUEST_TIMEOUT_MS` in the engine's model
 * client), and this deadline is that ceiling plus a thirty-second margin for
 * turn overhead and delivery. The margin is what makes the ceiling
 * observable: when a model hangs, the engine ends the turn at the ceiling
 * and answers on the still-open socket, so the user gets the turn's real
 * error — not this layer's generic "not responding" — and the turn gate is
 * already open when they retry. A deadline at or below the ceiling can never
 * see it fire. If either number moves, move the other; the transport adds no
 * bound of its own for the pair to fit under (see `transport.ts`).
 *
 * The generous bound is a deliberate tradeoff: it must survive a slow LLM
 * turn with several tool round-trips, yet still cap a genuinely wedged
 * engine. A turn that legitimately outlives it trips a `deadline` ("not
 * responding", never "down"), and in the REPL the next health probe restores
 * state almost at once. This is the tuning point to revisit if real agent
 * turns approach it.
 */
export const CONTROL_DEADLINE_MS = 10_000;
export const CHAT_DEADLINE_MS = 630_000;

/**
 * The CLI's client to the engine. Two transports behind one surface:
 *
 *   - the direct `/api/*` HTTP calls for connection, governance, and session
 *     operations (services, policy, kill, disconnect, connect, session, health);
 *   - the trusted internal MCP drive interface for the
 *     three agent-driving operations — `chat` / `resolve` / `getStatus` delegate
 *     to an injected `InternalDriver`, which speaks JSON-RPC over `/internal/mcp`
 *     with a caller token. Driving the agent is what reaches the (governed)
 *     control plane, so it rides the trusted surface, not the open `/api` door.
 *
 * Every `/api/*` request is keyed by the configured userId, which the Worker
 * uses to route to the per-user DO. The fetchFn is injectable so tests can
 * supply a fake without monkey-patching globals; the internal driver is
 * injectable for the same reason (default: a real `InternalClient` sharing this
 * client's fetchFn). The production default is `nodeFetch`, not the global
 * `fetch` — the global's dispatcher cuts a response whose headers take longer
 * than five minutes, which is shorter than the chat deadline this client arms
 * (see `transport.ts`).
 */
export class ApiClient {
  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchFn = nodeFetch,
    private readonly internal: InternalDriver = new InternalClient(
      config,
      fetchFn,
    ),
  ) {}

  /** The configured engine base URL — echoed in availability guidance. */
  get apiUrl(): string {
    return this.config.apiUrl;
  }

  /**
   * Run one agent turn. Drives the trusted internal MCP interface
   * via `send` — not `/api/chat` — because a turn can
   * now operate the governed control plane, which only the internal surface
   * reaches. Same `ChatResponse` shape, same busy → 409 mapping as before.
   */
  chat(message: string): Promise<ChatResponse> {
    return this.internal.chat(message);
  }

  listServices(): Promise<ServicesResponse> {
    return this.get<ServicesResponse>(
      `/api/services?userId=${encodeURIComponent(this.config.userId)}`,
    );
  }

  /** Enumerate the connectable services. Discovery only — no userId. */
  getCatalog(): Promise<CatalogResponse> {
    return this.get<CatalogResponse>("/api/services/catalog");
  }

  // The standing-allow mutate path (POST /api/policy) was removed in Issue
  // there is no permanent-allow surface to set. Grants are minted
  // through the confirmation flow. The read-only GET remains below.

  getPolicy(): Promise<PolicyResponse> {
    return this.get<PolicyResponse>(
      `/api/policy?userId=${encodeURIComponent(this.config.userId)}`,
    );
  }

  /** Spend limits + window sums (`GET /api/settings`). */
  getSettings(): Promise<SettingsResponse> {
    return this.get<SettingsResponse>(
      `/api/settings?userId=${encodeURIComponent(this.config.userId)}`,
    );
  }

  /** Set one or both spend limits in integer cents (`POST /api/settings`). */
  setSpendLimits(update: {
    monthLimitCents?: number;
    sessionLimitCents?: number;
  }): Promise<SettingsResponse> {
    return this.post<SettingsResponse>("/api/settings", {
      userId: this.config.userId,
      ...update,
    });
  }

  kill(): Promise<KillResponse> {
    return this.post<KillResponse>("/api/kill", { userId: this.config.userId });
  }

  /**
   * The interactive launch's handshake. A 409 is the refusal payload —
   * a session is already active and the caller attaches to it — so it parses
   * as a result, not an `ApiError`.
   */
  startSession(): Promise<StartSessionResponse> {
    return this.post<StartSessionResponse>(
      "/api/session/start",
      { userId: this.config.userId },
      [409],
    );
  }

  /** End the active session (frees the slot). `ended: false` when none. */
  quit(): Promise<QuitResponse> {
    return this.post<QuitResponse>("/api/session/quit", {
      userId: this.config.userId,
    });
  }

  /** The active session for `habenula status`, or `{ active: null }`. */
  getActiveSession(): Promise<GetSessionResponse> {
    return this.get<GetSessionResponse>(
      `/api/session?userId=${encodeURIComponent(this.config.userId)}`,
    );
  }

  /**
   * A bounded page of the task queue for `habenula task list` / `watch`.
   * `cursor` is the opaque `nextCursor` from a prior
   * page (omit for the first); `limit` is server-clamped. Direct `/api/tasks`
   * GET — the task reads are not drive verbs, so they stay on the public surface.
   */
  listTasks(opts?: { limit?: number; cursor?: string | null }): Promise<TasksListResponse> {
    const params = new URLSearchParams({ userId: this.config.userId });
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    return this.get<TasksListResponse>(`/api/tasks?${params.toString()}`);
  }

  /**
   * One page of the audit chain for `habenula log` and the `log dump` /
   * `log verify` walk: verbatim rows in chain order,
   * newest first. `cursor` is the opaque `nextCursor` from a prior page;
   * `limit` is server-clamped (the walk deliberately requests a large one and
   * lets the DO decide). Direct `/api/audit` GET — a read, not a drive verb.
   */
  listAuditEntries(opts?: { limit?: number; cursor?: string | null }): Promise<AuditListResponse> {
    const params = new URLSearchParams({ userId: this.config.userId });
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    return this.get<AuditListResponse>(`/api/audit?${params.toString()}`);
  }

  /**
   * One task's full record for `habenula task show <id>` — the per-action
   * breakdown and, for a `needs_input` task, the slot key(s) it awaits. A 404
   * (unknown id) surfaces as an `ApiError` the caller branches on by `.status`.
   */
  getTask(taskId: string): Promise<TaskDetailResponse> {
    const params = new URLSearchParams({
      userId: this.config.userId,
      taskId,
    });
    return this.get<TaskDetailResponse>(`/api/tasks/get?${params.toString()}`);
  }

  /**
   * Cancel a task for `habenula task cancel <id>` — the human surface,
   * authoritative over every origin. The three
   * informative outcomes (`cancelled` / `running` / `not_cancellable`) come back
   * as a `TaskCancelResponse` the caller branches on by `status`. A 404 (unknown
   * id) and a 409 (`TURN_IN_PROGRESS` — a live turn is in flight, retry) are
   * `ApiError`s the caller branches on by `.status`. There is no `amend` client
   * method — amend is MCP-only (a human amends by chatting).
   */
  cancelTask(taskId: string): Promise<TaskCancelResponse> {
    return this.post<TaskCancelResponse>("/api/tasks/cancel", {
      userId: this.config.userId,
      taskId,
    });
  }

  /**
   * The aggregate governed-session read: the active session,
   * active grants, and the one pending held call as a render-ready record — one
   * atomic snapshot. The reactive confirmation path reads only `.held`; rich
   * status reads all three.
   */
  /**
   * The governed-session snapshot. Drives the internal `status` tool,
   * not `/api/status` — `status` is one of the three
   * drive verbs the CLI moved onto the trusted surface. Same `StatusResponse`
   * shape. The control deadline still bounds it, so a poll-read timeout still
   * classifies as `kind: "deadline"` (the REPL flap rule keys on it).
   */
  getStatus(): Promise<StatusResponse> {
    return this.internal.getStatus();
  }

  /**
   * The offline health probe: `GET /api/health` under the
   * control deadline. True only on an HTTP 200 whose body passes the
   * hand-rolled shape guard; false on any reject, non-200, non-JSON, or shape
   * mismatch. Never throws — the offline loop treats any negative as "still
   * down". Commands never preflight this; it serves only the REPL's offline
   * probing (and `just dev` readiness, which curls the route directly).
   */
  async probeHealth(): Promise<boolean> {
    // Deliberately does NOT route through `request`: that core throws
    // `EngineUnavailableError` on a down engine, but the probe's contract is
    // to never throw — a negative is just "still down". So it owns its own
    // deadline timer here rather than reusing the shared one.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_DEADLINE_MS);
    try {
      const res = await this.fetchFn(this.url("/api/health"), {
        signal: controller.signal,
      });
      if (res.status !== 200) return false;
      return isHealthShape(JSON.parse(await res.text()));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve a held tool call with one of the confirmation choices. Only the result
   * variants (`info` — the call stays parked; `resumed` — the turn continued)
   * come back as a `ResolveResponse`. The failure statuses are `ApiError`s the
   * caller branches on by `.status`: 404 is an expired/unknown held call
   * ("ask again"), and 409 is a turn-in-flight collision ("try again", the call
   * stays parked). The 409 branch is dead before the turn gate lands and live
   * the moment it does — wired here so a racing resume never falls through to
   * the generic error path.
   */
  resolve(heldCallId: string, choice: ResolveChoice): Promise<ResolveResponse> {
    return this.internal.resolve(heldCallId, choice);
  }

  /**
   * Disconnect a service. Idempotent — `removed` is whether a connection
   * actually existed, so the caller can distinguish a real disconnect from a
   * no-op on an unknown or not-connected name.
   */
  disconnect(service: string): Promise<DisconnectResponse> {
    return this.post<DisconnectResponse>("/api/services/disconnect", {
      userId: this.config.userId,
      service,
    });
  }

  /**
   * Begin connecting a service through the single connect entry
   * (`POST /connect/{service}`). Returns the provider `authorizeUrl` to open
   * for an OAuth service, or `{ connected }` for a credential-less service.
   * Throws `ApiError` (400) for an unknown service name. Accepts a `signal` so
   * a cancel (Ctrl-C) during this opening POST is honored, not just during the
   * wait that follows it.
   */
  connect(service: string, signal?: AbortSignal): Promise<ConnectResponse> {
    const path = `/connect/${encodeURIComponent(service)}?userId=${encodeURIComponent(this.config.userId)}`;
    return this.post<ConnectResponse>(path, {}, [], signal);
  }

  /**
   * The per-flow status read the connect wait loop polls:
   * a coarse enum only — pending, connected, denied,
   * or expired. Accepts a `signal` so the caller can bound a specific read —
   * the wait's final confirm-poll on cancel must not turn a prompt return
   * into a hang on an unresponsive Worker.
   */
  getConnectFlowStatus(
    service: string,
    flow: string,
    signal?: AbortSignal,
  ): Promise<ConnectFlowStatusResponse> {
    return this.get<ConnectFlowStatusResponse>(
      `/api/connect/status?userId=${encodeURIComponent(this.config.userId)}&service=${encodeURIComponent(service)}&flow=${encodeURIComponent(flow)}`,
      signal,
    );
  }

  /**
   * Drop a pending connect flow. Idempotent —
   * `cancelled` reports whether a pending row existed; the wait loop's
   * best-effort abandon ignores it. Accepts a `signal` so the caller can
   * bound this cleanup POST — a cancel must not hang on an unresponsive
   * Worker with the socket half-open.
   *
   * Keyed on `flow` alone, unlike `getConnectFlowStatus` which also takes
   * `service`: the flow handle is a high-entropy token that is the primary key
   * of the pending-flow row, so a delete-by-flow is unambiguous. The status
   * read carries `service` for a different reason — it cross-checks the row's
   * service and consults the connected-services table — not because cancel
   * needs it. The asymmetry is intentional.
   */
  cancelConnectFlow(
    flow: string,
    signal?: AbortSignal,
  ): Promise<ConnectCancelResponse> {
    return this.post<ConnectCancelResponse>(
      "/api/connect/cancel",
      { userId: this.config.userId, flow },
      [],
      signal,
    );
  }

  private get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, undefined, CONTROL_DEADLINE_MS, [], signal);
  }

  private post<T>(
    path: string,
    body: unknown,
    okStatuses: number[] = [],
    signal?: AbortSignal,
    deadlineMs: number = CONTROL_DEADLINE_MS,
  ): Promise<T> {
    return this.request<T>(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      deadlineMs,
      okStatuses,
      signal,
    );
  }

  /**
   * The shared request core — the CLI's single availability-detection point.
   * It owns the deadline timer, which is what makes
   * `kind` knowable: a timed-out fetch and a connection-refused fetch both
   * reject through the same channel, so only the layer that armed the timer
   * can tell them apart (the `timedOut` flag). The timer spans the WHOLE
   * request — a fetchFn may resolve at the headers and leave `parse<T>`
   * streaming the body (`nodeFetch` resolves only after buffering it) — so it
   * is cleared only in `finally`, never at fetch-resolve; a stalled body
   * classifies as `deadline` exactly like stalled headers.
   *
   * Classification on a rejection, in order: an `ApiError` from `parse`
   * rethrows unchanged (a reachable-engine HTTP error is never demoted to an
   * availability failure); a caller-signal abort (the connect wait's cancel /
   * per-read bounds) is neither reject nor deadline and
   * rethrows raw, ahead of the deadline check so a caller cancel that races
   * the layer's timer wins; the layer's own expired deadline becomes
   * `kind: "deadline"`; a reject with no `Response` becomes `kind: "reject"`;
   * and a post-`Response` non-availability failure rethrows unchanged — the engine
   * was reachable.
   *
   * Post-`Response` failures: "headers arrived" is taken as proof the engine
   * was reachable, so a later failure that is not the deadline and not a
   * caller abort rethrows raw (exit 1, no guidance). With the production
   * transport that path carries only non-transport failures from a reachable
   * engine (a malformed body in `parse<T>`): `nodeFetch` buffers the body
   * before resolving, so an engine that crashes mid-stream rejects before any
   * `Response` exists and classifies as an availability failure like stalled
   * headers. A streaming fetchFn injected by a test can still reject
   * mid-body after the `Response`; that rethrows raw, same rule.
   */
  private async request<T>(
    path: string,
    init: { method: string; headers: Record<string, string>; body: string } | undefined,
    deadlineMs: number,
    okStatuses: number[] = [],
    callerSignal?: AbortSignal,
  ): Promise<T> {
    // The one choke point for a carried config fault: an unusable config refuses
    // here, before anything is dialled, rather than at load time where it would
    // also have taken out `--help` and the offline `log verify --file`.
    requireUsableConfig(this.config);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let gotResponse = false;
    try {
      const res = await this.fetchFn(this.url(path), { ...init, signal });
      gotResponse = true;
      return await this.parse<T>(res, okStatuses);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // A caller-signal abort (the connect wait's cancel / per-read bound)
      // is neither reject nor deadline — rethrow raw. Checked
      // BEFORE `timedOut` so a caller cancel that races the layer's own
      // deadline expiry is still reported as the user's cancel, not demoted to
      // an availability failure. The layer's timer aborts `controller`, never
      // `callerSignal`, so `callerSignal.aborted` is true only on a real caller
      // abort.
      if (callerSignal?.aborted) throw err;
      if (timedOut) {
        throw new EngineUnavailableError(this.config.apiUrl, "deadline", err);
      }
      if (!gotResponse) {
        throw new EngineUnavailableError(this.config.apiUrl, "reject", err);
      }
      // Post-`Response` failure: headers arrived, so the engine was reachable.
      // Rethrown raw — including a mid-stream connection reset (the accepted
      // gap above). See the classification note in this method's doc comment.
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private url(path: string): string {
    return new URL(path, this.config.apiUrl).toString();
  }

  /**
   * Parse a response body. `okStatuses` lists non-2xx statuses whose bodies
   * are expected results rather than errors (e.g. the 409 refusal payload
   * from `startSession`).
   */
  private async parse<T>(res: Response, okStatuses: number[] = []): Promise<T> {
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      // Default to a concise status line, never the raw body: a local miniflare
      // 5xx (or any dead-Worker/proxy page) returns a full HTML error overlay,
      // and the REPL prints `ApiError.message` verbatim — so a raw fall-through
      // dumps reams of HTML to the terminal. A real contract error
      // envelope overrides this with its human-readable `error`.
      let message = `engine error (${res.status})`;
      let errorCode: string | undefined;
      try {
        // Partial: a non-contract body (proxy error page, dead Worker) may
        // lack `error`, so the shared envelope is bound defensively here.
        const json = JSON.parse(text) as Partial<ErrorResponse>;
        if (json.error) message = json.error;
        errorCode = json.error_code;
      } catch {
        // Non-JSON error body (HTML error page) — keep the concise status line.
      }
      throw new ApiError(res.status, message, errorCode);
    }
    return JSON.parse(text) as T;
  }
}

/**
 * The engine identifier the probe discriminates on, typed as the contract's
 * `engine` literal. This is the binding that keeps the CLI's by-value check in
 * step with the schema: if the contract literal ever changes, this assignment
 * stops compiling. A bare `=== "habenula-engine"` inside the guard would not —
 * a type predicate's body is an unchecked assertion, so the string alone could
 * silently drift from the contract while still type-checking.
 */
const EXPECTED_ENGINE: HealthResponse["engine"] = "habenula-engine";

/**
 * Hand-rolled shape guard for the health probe: the discriminant is asserted
 * BY VALUE — `status === "ok"` and the `EXPECTED_ENGINE` identifier — so a
 * vacuous `{}`, or a stray 200 from an unrelated server at a mistyped URL,
 * never reads as reachable. No zod: the CLI consumes
 * contracts type-only, and the check gates on nothing beyond the discriminant
 * (the route carries no other fields).
 *
 * Exported for the engine-lifecycle port classifier (src/engine/probe.ts),
 * which must answer "is this an engine?" with the same discriminator rather
 * than a second copy of it.
 */
export function isHealthShape(body: unknown): body is HealthResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.status === "ok" && b.engine === EXPECTED_ENGINE;
}
