// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HabenulaEnv } from "./env";
import { importEncryptionKey, encryptCredential } from "@habenula-ai/credentials";
import { CORS_HEADERS, json, rejectNonLocal } from "./http";
import { validateCredentialKey } from "./credential-guard";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  handleMockAuthorize,
  lookupService,
  missingProviderEnv,
  MOCK_AUTHORIZE_PATH,
  mockProvider,
  OAUTH_PROVIDERS,
  parseOAuthState,
  randomHex,
  SERVICES,
} from "@habenula-ai/tools";
import type { OAuthProviderId, OAuthProviderStrategy } from "@habenula-ai/tools";
import { respond } from "./respond";
import { PHASE0_AGENT_ID } from "./agent/phase0";
import { createMcpHandler } from "agents/mcp";
import { buildCommissionServer } from "./mcp/commission-server";
import { buildInternalServer } from "./mcp/internal-server";
import { buildContractDescriptors } from "./dev-model/contract-descriptors";
import { renderModelPage } from "./dev-model/page";
import {
  CatalogResponse,
  ChatRequest,
  ContractDescriptorsResponse,
  GovernanceSnapshotResponse,
  ChatResponse,
  ConnectCancelRequest,
  ConnectCancelResponse,
  ConnectFlowStatusResponse,
  connectFlowStatusRequestError,
  ConnectResponse,
  DisconnectResponse,
  DisconnectServiceRequest,
  ENGINE_ID,
  AuditListResponse,
  ErrorResponse,
  ExecuteToolResponse,
  GetSessionResponse,
  HealthResponse,
  illFormedStringError,
  KillResponse,
  PolicyResponse,
  QuitResponse,
  ResolveRequest,
  resolveRequestError,
  ResolveResponse,
  ServicesResponse,
  SessionRequest,
  StartSessionResponse,
  StatusResponse,
  parseAuditListQuery,
  parseConnectFlowStatusQuery,
  parseTaskGetQuery,
  parseTasksListQuery,
  parseUserIdQuery,
  TaskCancelRequest,
  taskCancelRequestError,
  TaskCancelResponse,
  TaskDetailResponse,
  taskGetRequestError,
  TasksListResponse,
  ToolExecuteRequest,
  SettingsResponse,
  SettingsUpdateRequest,
  settingsUpdateRequestError,
} from "@habenula-ai/contracts";

import type { ExecuteToolResult } from "./agent/user-agent";
import { UpstreamLLMError, UpstreamResponseError } from "./llm/errors";

export { UserAgent } from "./agent/user-agent";

/**
 * Whether `err` is the engine-owned error class called `name` — either of the
 * two upstream classes in `llm/errors.ts`, whichever the caller asks for.
 * The error is thrown inside the UserAgent DO and crosses the DO→Worker
 * RPC boundary, which flattens it to a plain `Error`: the class prototype is
 * dropped and the original `"<name>: <message>"` becomes the tunneled `message`
 * (so `.name` is `"Error"`, not the class name). Match the class name in
 * either position — `.name` for a same-isolate throw, or the message prefix for
 * the RPC-tunneled one — so the classification survives the boundary. Only our
 * own error produces that prefix, so there is no untrusted-input false positive.
 */
function isNamedError(err: unknown, name: string): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === name || err.message.startsWith(`${name}: `);
}

function isUpstreamLLMError(err: unknown): boolean {
  return isNamedError(err, UpstreamLLMError.name);
}

function isUpstreamResponseError(err: unknown): boolean {
  return isNamedError(err, UpstreamResponseError.name);
}

/**
 * Map an error thrown out of a DO RPC into a structured response. Three
 * outcomes, and the split is who failed:
 *
 * - The upstream was unreachable, overloaded, or timed out → `503`, which the
 *   CLI presents as "try again".
 * - The upstream answered with something unusable → `502`. Retrying may help
 *   (a model is stochastic) but the fault is on the other side of the wire and
 *   the message says so, because for a self-hoster the fix is their runtime.
 * - Anything else → a structured `500` — never the bare text `500 Internal
 *   Server Error` the runtime returns for an uncaught throw, which reads as a
 *   hard fault and leaves the caller no signal that a retry might succeed.
 *
 * Only the last one is an engine-bug signal, and only the last one is logged
 * as one.
 */
function rpcFailureResponse(err: unknown): Response {
  if (isUpstreamLLMError(err)) {
    return respond(
      ErrorResponse,
      {
        error: "The assistant is temporarily unavailable — please try again.",
        error_code: "UPSTREAM_UNAVAILABLE",
      },
      503,
    );
  }
  if (isUpstreamResponseError(err)) {
    return respond(
      ErrorResponse,
      {
        error:
          "The assistant returned a response Habenula could not use — please try again.",
        error_code: "UPSTREAM_INVALID_RESPONSE",
      },
      502,
    );
  }
  // eslint-disable-next-line no-console -- boundary telemetry: an unexpected throw is an engine-bug signal.
  console.error("unhandled error in API handler", err);
  return respond(
    ErrorResponse,
    { error: "Internal server error", error_code: "INTERNAL" },
    500,
  );
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new InvalidBodyError();
  }
}

class InvalidBodyError extends Error {
  constructor() {
    super("Request body must be valid JSON");
    this.name = "InvalidBodyError";
  }
}

/**
 * Constant-time string equality. Compares
 * SHA-256 digests, not the raw strings: the digests are always 32 bytes, so
 * the compare loop runs in fixed time regardless of input length — no length
 * oracle and no early-exit timing side channel on a partial match.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/**
 * The `/internal/mcp` caller-token check.
 * Requires `Authorization: Bearer <t>` with `t` matching `INTERNAL_MCP_TOKEN`.
 * Fails closed when the secret is unset (no trusted caller can exist), and
 * treats a missing header exactly like a wrong token — the presented value
 * defaults to "" and flows through the same constant-time compare, so the two
 * are indistinguishable to the caller (no oracle).
 */
async function internalCallerAuthorized(
  request: Request,
  env: HabenulaEnv,
): Promise<boolean> {
  const expected = env.INTERNAL_MCP_TOKEN ?? "";
  if (expected.length === 0) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  return constantTimeEqual(presented, expected);
}

// Once-per-isolate flag for the credential-key refusal log line: the 503 body
// repeats on every request, but the terminal message should not.
let credentialKeyWarned = false;

export default {
  async fetch(
    request: Request,
    env: HabenulaEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Loopback guard before ALL routing, OPTIONS included (fail-closed:
    // a non-loopback preflight is refused). LOCALHOST_ONLY defaults on;
    // a future hosted deploy must explicitly set it "false".
    if (env.LOCALHOST_ONLY !== "false") {
      const denied = rejectNonLocal(request);
      if (denied) return denied;
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // The deliberate liveness route: state-free by
    // design — no userId, no DO read — because it is unauthenticated and a
    // hosted deploy exposes it to the open internet. Registered before the
    // /api/* 404 fall-through.
    if (url.pathname === "/api/health" && request.method === "GET") {
      return handleHealth();
    }
    // Fail-closed credential-key guard: every route
    // below refuses to run under a missing, malformed, or publicly known
    // placeholder CREDENTIAL_ENCRYPTION_KEY, so real credentials are never
    // encrypted under a world-known key on any run path. Health stays above
    // the guard: it is the pure liveness probe, and a 503
    // there would report "engine down" for what is a config fault.
    const keyRefusal = validateCredentialKey(env.CREDENTIAL_ENCRYPTION_KEY);
    if (keyRefusal) {
      if (!credentialKeyWarned) {
        credentialKeyWarned = true;
        // eslint-disable-next-line no-console -- boundary telemetry: the refusal must reach the wrangler-dev terminal, not only the response body.
        console.error(keyRefusal);
      }
      return respond(ErrorResponse, { error: keyRefusal }, 503);
    }
    if (url.pathname === "/api/services/disconnect" && request.method === "POST") {
      return handleDisconnect(request, env);
    }
    // The connectable set (discovery only — the connect route stays the
    // authority on unknown names), distinct from the connected-services
    // listing below. No user state: safe to serve without a userId.
    if (url.pathname === "/api/services/catalog" && request.method === "GET") {
      return respond(CatalogResponse, {
        services: SERVICES.map((s) => ({ service: s.service })),
      });
    }
    if (url.pathname === "/api/services" && request.method === "GET") {
      return handleListServices(request, env);
    }
    if (url.pathname === "/api/kill" && request.method === "POST") {
      return handleKillSwitch(request, env);
    }
    // GET /api/policy is the read-only policy-state query. The POST mutate
    // path (the standing-allow toggle) was removed — there is no
    // permanent-allow surface to toggle anymore.
    if (url.pathname === "/api/policy" && request.method === "GET") {
      return handleGetPolicy(request, env);
    }
    // The spend-settings surface: read limits + window
    // sums, set limits. Same auth posture as every /api route — the loopback
    // guard and the userId key; the payload is integer limits, no credentials.
    if (url.pathname === "/api/settings" && request.method === "GET") {
      return handleGetSettings(request, env);
    }
    if (url.pathname === "/api/settings" && request.method === "POST") {
      return handlePostSettings(request, env);
    }
    // Debug-only direct tool execution, gated by DEBUG_MODE on top of the
    // loopback guard (same pattern as the dev visual model below). The route
    // drives a governed call with no conversation behind it — a debugging
    // surface, never an intended feature — and a gated-off route is
    // indistinguishable from an absent one (404), so it doesn't advertise
    // itself.
    if (url.pathname === "/api/tools/execute" && request.method === "POST") {
      if (!debugModeEnabled(env)) {
        return respond(ErrorResponse, { error: "Not found" }, 404);
      }
      return handleToolExecute(request, env);
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/resolve" && request.method === "POST") {
      return handleResolve(request, env);
    }
    // Session lifecycle: the interactive launch's handshake
    // (start, refuse-guarded), the explicit end (quit), and the status read.
    if (url.pathname === "/api/session/start" && request.method === "POST") {
      return handleStartSession(request, env);
    }
    if (url.pathname === "/api/session/quit" && request.method === "POST") {
      return handleQuit(request, env);
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      return handleGetSession(request, env);
    }
    // The aggregate governed-session read: session + active
    // grants + every pending held call, as one atomic snapshot.
    if (url.pathname === "/api/status" && request.method === "GET") {
      return handleGetStatus(request, env);
    }
    // The task management surface: the cross-origin
    // queue list, one task's full per-action detail, and the human-surface
    // cancel. Same `userId`-keyed routing. `amend` is deliberately MCP-only —
    // there is no `/api/tasks/amend` route (a human amends by chatting).
    if (url.pathname === "/api/tasks" && request.method === "GET") {
      return handleListTasks(request, env);
    }
    if (url.pathname === "/api/tasks/get" && request.method === "GET") {
      return handleGetTask(request, env);
    }
    if (url.pathname === "/api/tasks/cancel" && request.method === "POST") {
      return handleCancelTask(request, env);
    }
    // The audit read surface: rows out in chain order for
    // client-side verification. Rows, never a verdict.
    if (url.pathname === "/api/audit" && request.method === "GET") {
      return handleListAudit(request, env);
    }
    // Dev visual model: read-only observability, gated by VISUAL_MODEL
    // on top of the loopback guard. Gated-off routes are indistinguishable
    // from absent ones (404), so the surface doesn't advertise itself.
    if (url.pathname === "/api/dev/model" && request.method === "GET") {
      if (!visualModelEnabled(env)) {
        return respond(ErrorResponse, { error: "Not found" }, 404);
      }
      return handleGetModelSnapshot(request, env);
    }
    if (url.pathname === "/api/dev/contracts" && request.method === "GET") {
      if (!visualModelEnabled(env)) {
        return respond(ErrorResponse, { error: "Not found" }, 404);
      }
      return respond(ContractDescriptorsResponse, buildContractDescriptors());
    }
    if (url.pathname === "/dev/model" && request.method === "GET") {
      if (!visualModelEnabled(env)) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(renderModelPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // Per-flow lifecycle for the connect wait: the status
    // read the CLI polls and the cancel that drops a pending flow. New routes
    // under /api/*; the connect entry and callback predate that convention
    // and stay where they are.
    if (url.pathname === "/api/connect/status" && request.method === "GET") {
      return handleConnectFlowStatus(request, env);
    }
    if (url.pathname === "/api/connect/cancel" && request.method === "POST") {
      return handleConnectCancel(request, env);
    }
    // The inbound MCP commission surface: a per-request,
    // stateless McpServer over Streamable HTTP. userId is the same
    // unauthenticated routing mechanism as every other route.
    if (url.pathname === "/mcp") {
      const userId = url.searchParams.get("userId") ?? "demo-user";
      return createMcpHandler(buildCommissionServer(env, userId))(
        request,
        env,
        ctx,
      );
    }
    // The trusted internal MCP surface: the drive
    // interface (send / resolve / status) and the only surface that reaches
    // the control plane — `send` runs the turn with origin:"internal", which
    // offers the governed control-plane tools. Its trust predicate is the
    // caller token, NOT network locality. The check runs BEFORE
    // dispatch: a missing OR wrong token both 401 identically (no oracle), and
    // an unconfigured token fails closed (no trusted caller exists). The token
    // authenticates the caller — it is not an OAuth credential and never enters
    // the model context (Hard Invariant #1). `rejectNonLocal` still runs for
    // this route (as for all routes) as defense-in-depth, not the predicate.
    if (url.pathname === "/internal/mcp") {
      if (!(await internalCallerAuthorized(request, env))) {
        return json({ error: "unauthorized" }, 401);
      }
      const userId = url.searchParams.get("userId") ?? "demo-user";
      // createMcpHandler defaults its served route to "/mcp" and 404s any other
      // pathname — pin it to this route so the internal surface is reachable.
      return createMcpHandler(buildInternalServer(env, userId), {
        route: "/internal/mcp",
      })(request, env, ctx);
    }

    // Single connect entry: catalog dispatch by service type. POST because
    // every branch mutates state (PKCE state for OAuth, the connection row for
    // a credential-less service).
    if (url.pathname.startsWith("/connect/") && request.method === "POST") {
      let service: string;
      try {
        service = decodeURIComponent(url.pathname.slice("/connect/".length));
      } catch {
        // Malformed percent-encoding (e.g. `/connect/%`) — decodeURIComponent
        // throws URIError. Reject as a bad request rather than letting it
        // escape the fetch handler as a 500.
        return respond(ErrorResponse, { error: "Malformed service name in path" }, 400);
      }
      return handleConnectEntry(request, env, service);
    }
    // The mock provider's simulated authorization server (mock-internal). The
    // catalog check is supplied here so the mock module need not import the
    // assembler: resolve the state's service to its declared scopes only when
    // it is genuinely a mock-provider OAuth service. The state loader is
    // injected the same way so the DO reach stays at this composition-root
    // edge.
    if (url.pathname === MOCK_AUTHORIZE_PATH && request.method === "GET") {
      return handleMockAuthorize(
        request,
        (service) => {
          const def = lookupService(service);
          if (
            !def ||
            def.connect.type !== "oauth" ||
            OAUTH_PROVIDERS[def.connect.provider] !== mockProvider
          ) {
            return null;
          }
          return { scopes: def.connect.scopes };
        },
        (userId, stateKey) => getUserStub(env, userId).loadOAuthState(stateKey),
        json,
      );
    }
    // One shared callback handler serves every provider's registered
    // callbackPath (/callback/google, /callback/mock). The provider is
    // derived from which registered path matched, never parsed from the URL.
    if (request.method === "GET" && url.pathname.startsWith("/callback/")) {
      for (const strategy of Object.values(OAUTH_PROVIDERS)) {
        if (url.pathname === strategy.callbackPath) {
          return handleOAuthCallback(request, env, strategy);
        }
      }
      // An unmatched /callback/* path is a real dead-end, not the fall-through
      // 200 below. A provider redirecting to a removed callback (e.g. an old
      // /callback/gmail still registered in a console) must get a diagnostic,
      // not a silent "ok" that leaves the CLI polling to timeout.
      return json(
        { error: "Unknown OAuth callback path — restart connect" },
        404,
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return respond(ErrorResponse, { error: "Not found" }, 404);
    }

    return new Response("ok");
  },
} satisfies ExportedHandler<HabenulaEnv>;

/**
 * `GET /api/health`: answers "is the engine process
 * serving requests". Both response values are compile-time constants, so the
 * route touches no runtime or user state; the CLI treats a probe as reachable
 * only on a 200 whose body matches the `HealthResponse` shape. It carries no
 * build version — the route is unauthenticated, so it discloses only that
 * an engine is serving.
 */
function handleHealth(): Response {
  return respond(HealthResponse, {
    status: "ok",
    engine: ENGINE_ID,
  });
}

function getUserStub(env: HabenulaEnv, userId: string) {
  const id = env.USER_AGENT.idFromName(userId);
  return env.USER_AGENT.get(id);
}

/** Dev visual model gate. Fail-closed: only exactly "true" enables. */
function visualModelEnabled(env: HabenulaEnv): boolean {
  return env.VISUAL_MODEL === "true";
}

/**
 * The DEBUG_MODE gate for `POST /api/tools/execute`. Fail-closed like the
 * visual model's: only exactly "true" opens it.
 */
function debugModeEnabled(env: HabenulaEnv): boolean {
  return env.DEBUG_MODE === "true";
}

/**
 * The visual model's snapshot read. Same `userId`-keyed routing as
 * every other read; the DO composes the whole snapshot in one invocation, so
 * the page always renders one consistent instant.
 */
async function handleGetModelSnapshot(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const snapshot = await stub.readModelSnapshot(userId);

  return respond(GovernanceSnapshotResponse, snapshot);
}


/**
 * The provider's redirect URI: its registered callbackPath resolved against a
 * base origin. The begin-flow and the token exchange must derive this
 * identically — Google rejects an exchange whose redirect_uri differs from the
 * authorize-time value (RFC 6749 §4.1.3) — so both sites share this one derivation.
 *
 * The base is resolved most-specific-first: a per-provider
 * `OAUTH_REDIRECT_BASE_URL_<PROVIDER>` (e.g. `OAUTH_REDIRECT_BASE_URL_SLACK`),
 * then the global `OAUTH_REDIRECT_BASE_URL`, then the incoming request URL. The
 * env override exists because deriving the redirect from `request.url` ties its
 * scheme and host to how the request physically arrives — behind a tunnel that
 * terminates to `http://localhost`, the redirect comes out `http://…`, which
 * Slack rejects (it accepts only pre-registered HTTPS URIs, no localhost
 * exception). Setting the base to a stable public origin decouples the redirect
 * from the transport.
 *
 * The per-provider tier exists because the base is otherwise shared across every
 * provider: setting the global var to tunnel Slack would also move Google's
 * redirect off `http://localhost` (which Google, unlike Slack, accepts), forcing
 * a needless Google console re-registration. Scoping the override to one provider
 * leaves the others on their fallback. Only the origin of the configured base is
 * used — the callbackPath is absolute, so any path on the base is discarded.
 *
 * Throws when a base is set but unparseable or not an http(s) origin, naming
 * the exact var that supplied it. That is an operator misconfiguration, not
 * client input, so both call sites catch the throw and return a structured 500
 * carrying the message rather than letting it escape as an opaque runtime 500.
 *
 * Exported so a unit test can assert the begin-flow and the callback derive an
 * identical URI directly — that agreement is the §4.1.3 invariant.
 */
export function resolveCallbackUrl(
  strategy: OAuthProviderStrategy,
  request: Request,
  env: HabenulaEnv,
  providerId: OAuthProviderId,
): string {
  // Per-provider vars are looked up by constructed key, so a new provider needs
  // no code change here — only a HabenulaEnv declaration (src/env.ts) for typed access. The key
  // is built from the OAuth *provider* id (e.g. `google`), not the connect name
  // the user types (`gmail`) — so gmail's var is OAUTH_REDIRECT_BASE_URL_GOOGLE.
  const perProviderKey = `OAUTH_REDIRECT_BASE_URL_${providerId.toUpperCase()}`;
  const vars = env as unknown as Record<string, string | undefined>;
  const perProvider = vars[perProviderKey];
  // `||`, not `??`: an empty string is a set-but-blank var (an easy `.dev.vars`
  // slip). It must fall through to the global, then the request URL — the
  // documented precedence — not pin the base to "" and revert to the request.
  const base = perProvider || env.OAUTH_REDIRECT_BASE_URL;
  if (base) {
    // Name the var that actually supplied the bad value, not the global one.
    const sourceKey = perProvider ? perProviderKey : "OAUTH_REDIRECT_BASE_URL";
    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      throw new Error(`${sourceKey} is not a valid absolute URL: ${base}`);
    }
    // Parseable is not enough: `localhost:8787` (missing scheme) and `mailto:x`
    // both parse — into a hostless, non-http URL that would yield a nonsense
    // redirect_uri. The redirect must be an http(s) origin, so reject the rest
    // here rather than emitting the garbage to the provider.
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error(`${sourceKey} must be an http(s) origin: ${base}`);
    }
    return new URL(strategy.callbackPath, baseUrl).toString();
  }
  return new URL(strategy.callbackPath, request.url).toString();
}

/**
 * How long a pending authorization flow stays consumable. Long enough for a
 * user to read a consent screen, short enough that an abandoned flow's row
 * ages out on its own rather than needing a sweep.
 */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Single connect entry. Looks the service up in the catalog and dispatches by
 * connect type: OAuth services run their provider strategy's begin-flow and
 * return the `authorizeUrl` (the caller opens it; the provider's registered
 * `GET /callback/{provider}` completes the connect); credential-less (`none`)
 * services connect directly; unknown names are rejected. Because a
 * credential-less connect can only name a catalog-declared `none` service, no
 * reconnect can null a live OAuth token.
 */
async function handleConnectEntry(
  request: Request,
  env: HabenulaEnv,
  service: string,
): Promise<Response> {
  const definition = lookupService(service);
  if (!definition) {
    // Machine-readable code so the CLI's discovery hint keys off the code, not
    // this prose (which is free to change without breaking the hint).
    return respond(
      ErrorResponse,
      { error: `Unknown service '${service}'`, error_code: "UNKNOWN_SERVICE" },
      400,
    );
  }

  if (definition.connect.type === "none") {
    const url = new URL(request.url);
    const { userId } = parseUserIdQuery(url.searchParams);
    // No userId colon guard here: this branch packs userId into nothing — it
    // flows only into idFromName() (colons are legal in DO names) and a bound
    // SQL param. The OAuth handlers keep their own guard because they encode
    // userId into the `${userId}:${randomPart}` OAuth state.
    const stub = getUserStub(env, userId);
    await stub.connectService(service);
    return respond(ConnectResponse, { connected: service });
  }

  // OAuth: run the provider's begin-flow, which returns the authorize URL.
  // Generic across providers — the service contributes only its scopes; a
  // consistency test guarantees the provider key resolves a strategy.
  const strategy = OAUTH_PROVIDERS[definition.connect.provider];

  // Refuse an unconfigured provider before any flow work. With the client id
  // absent, `beginAuth` coerces `undefined` into the authorize URL and the
  // provider answers with an opaque `invalid_client` page that names nothing
  // the operator can act on; an id-only deployment gets the same page one hop
  // later at the token exchange. Checked ahead of the request's own parsing
  // because it is a property of the deployment, not the input, and ahead of
  // `beginAuth` so no OAuth state row is written for a flow that cannot
  // complete. The requirement is declared on the strategy, so a new provider
  // needs no branch here.
  const missingEnv = missingProviderEnv(strategy, env);
  if (missingEnv.length > 0) {
    return respond(
      ErrorResponse,
      {
        error:
          `${service} is not configured: the ${definition.connect.provider} ` +
          `OAuth client needs ${missingEnv.join(" and ")}. ` +
          `Add them to .env (container) or .dev.vars (wrangler dev), ` +
          `then restart the engine.`,
        // Machine-readable so a client can recognize an unconfigured
        // deployment without matching the prose above, which is free to change.
        error_code: "PROVIDER_NOT_CONFIGURED",
      },
      400,
    );
  }

  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);
  if (userId.includes(":")) {
    return respond(ErrorResponse, { error: "userId must not contain ':'" }, 400);
  }

  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const randomPart = randomHex(16);
  const fullState = `${userId}:${randomPart}`;
  const now = Date.now();

  // Resolved against the configured base (or the request origin) — the same
  // value the callback recomputes, because both derive it the same way. A base
  // that is set but malformed is an operator misconfiguration: surface it as a
  // structured 500 naming the bad var, not an opaque runtime throw.
  let redirectUri: string;
  try {
    redirectUri = resolveCallbackUrl(
      strategy,
      request,
      env,
      definition.connect.provider,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid OAuth redirect base";
    return respond(ErrorResponse, { error: message }, 500);
  }
  const { authorizeUrl, authCode } = strategy.beginAuth(env, {
    scopes: definition.connect.scopes,
    state: fullState,
    codeChallenge: challenge,
    redirectUri,
  });

  const stub = getUserStub(env, userId);
  await stub.storeOAuthState(randomPart, {
    code_verifier: verifier,
    code_challenge: challenge,
    service,
    auth_code: authCode,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + OAUTH_STATE_TTL_MS).toISOString(),
    status: null,
  });

  // `flow` is the state key's randomPart — the handle the CLI polls and
  // cancels by. It already transits the browser as
  // the OAuth `state` parameter, so returning it exposes nothing new; the
  // PKCE verifier is the confidential half and never leaves the DO.
  return respond(ConnectResponse, { authorizeUrl, flow: randomPart });
}

/**
 * The per-flow status read behind the connect wait loop.
 * Routed to the DO by the request's own userId, so a flow handle can only
 * ever index into that user's DO — a foreign flow cannot be named. The body
 * is the coarse four-value enum only: no provider error prose, no verifier,
 * no credential material.
 *
 * Connection-state visibility: the row-absent branch of `readConnectFlowStatus`
 * answers `connected`/`pending` from `isServiceConnected` alone, so a caller
 * who knows only `(userId, service)` — not a valid flow handle — can learn
 * whether that service is connected. This is the same exposure `GET
 * /api/services` already gives unauthenticated (userId is the routing
 * mechanism, not auth, across the whole skeleton), so it is not a new leak.
 * When authentication lands it must cover both endpoints together.
 */
async function handleConnectFlowStatus(
  request: Request,
  env: HabenulaEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseConnectFlowStatusQuery(url.searchParams);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: connectFlowStatusRequestError(parsed.error) },
      400,
    );
  }
  const { userId, service, flow } = parsed.data;

  const stub = getUserStub(env, userId);
  const status = await stub.readConnectFlowStatus(service, flow);
  return respond(ConnectFlowStatusResponse, { status });
}

/**
 * Cancel a pending connect flow: delete its oauth_state
 * row so no orphan survives an abandoned attempt. Idempotent 200 either way —
 * `cancelled` reports whether a row existed, an observability/test signal the
 * CLI's best-effort abandon ignores.
 */
async function handleConnectCancel(
  request: Request,
  env: HabenulaEnv,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }
  const parsed = ConnectCancelRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "userId and flow are required" },
      400,
    );
  }

  const stub = getUserStub(env, parsed.data.userId);
  const cancelled = await stub.cancelOAuthFlow(parsed.data.flow);
  return respond(ConnectCancelResponse, { cancelled });
}

async function handleDisconnect(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = DisconnectServiceRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "service is required" },
      400,
    );
  }
  const { userId, service } = parsed.data;

  const stub = getUserStub(env, userId);
  const removed = await stub.disconnectService(service);

  return respond(DisconnectResponse, { disconnected: service, removed });
}

async function handleListServices(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const services = await stub.listConnectedServices();

  return respond(ServicesResponse, { services });
}

async function handleKillSwitch(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  // Same body shape as the session routes (userId only). A non-string userId
  // is rejected as a contract 400 rather than reaching idFromName() and
  // escaping as a 500 — kill was the one POST handler left on a bare cast.
  const parsed = SessionRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "userId must be a string" },
      400,
    );
  }
  const { userId } = parsed.data;

  const stub = getUserStub(env, userId);
  await stub.killSwitch();

  // Kill is deny-all only: it clears governance state but preserves
  // connections and credentials, so there is no disconnected-services list.
  return respond(KillResponse, { killed: true });
}

async function handleGetPolicy(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const entries = await stub.getStandingEntries();
  // With the standing-allow surface removed, the only standing
  // entry is the default-deny floor — there is no permanent allow to report,
  // so the effective standing decision is always deny. Grants live in session/
  // task entries, surfaced through their own future status view.
  const effectiveDecision = "deny" as const;

  const result: PolicyResponse = {
    effectiveDecision,
    entries: entries.map((e) => ({
      id: e.id,
      source: e.source,
      service: e.service,
      verb: e.verb,
      noun: e.noun,
      decision: e.decision,
      priority: e.priority,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt ?? null,
    })),
  };

  return respond(PolicyResponse, result);
}

/** `GET /api/settings` — spend limits, defaults-applied flags, window sums. */
async function handleGetSettings(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  // Unlike most GET reads, this one can genuinely throw: the window sums are
  // live SUM queries and the ledger helpers throw on storage failure — the
  // failure the spend check maps to `unavailable`. Surface it as the
  // structured error contract, not a raw 500 (mirrors the POST path).
  let settings: Awaited<ReturnType<typeof stub.readSpendSettings>>;
  try {
    settings = await stub.readSpendSettings();
  } catch (err) {
    return rpcFailureResponse(err);
  }

  return respond(SettingsResponse, settings);
}

/**
 * `POST /api/settings` — set one or both spend limits (integer cents; the
 * contract rejects an empty update). Echoes the post-write read.
 */
async function handlePostSettings(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = SettingsUpdateRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: settingsUpdateRequestError(parsed.error) },
      400,
    );
  }
  const { userId, monthLimitCents, sessionLimitCents } = parsed.data;

  const stub = getUserStub(env, userId);
  let settings: Awaited<ReturnType<typeof stub.writeSpendLimits>>;
  try {
    settings = await stub.writeSpendLimits({
      ...(monthLimitCents !== undefined ? { monthLimitCents } : {}),
      ...(sessionLimitCents !== undefined ? { sessionLimitCents } : {}),
    });
  } catch (err) {
    return rpcFailureResponse(err);
  }

  return respond(SettingsResponse, settings);
}

async function handleToolExecute(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = ToolExecuteRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "toolName is required" },
      400,
    );
  }
  const { userId, toolName, params: toolParams } = parsed.data;

  const stub = getUserStub(env, userId);

  // The RPC stub maps this return type to `never` because the tool result's
  // opaque `execution.data?: unknown` fails the Rpc.Serializable check; the
  // runtime value is the structured-cloned ExecuteToolResult, so name it.
  //
  // `executeToolDirect` is the GATED variant: this route owns no turn, and
  // without serialization two concurrent money-verb calls both price against
  // pre-dispatch ledger totals and both commit past the cap.
  const gated = (await stub.executeToolDirect({
    toolName,
    toolParams,
    userId,
    agentId: PHASE0_AGENT_ID,
  })) as ExecuteToolResult | { busy: true };

  if ("busy" in gated) {
    // Same shape the resolve route ships for the same reason.
    return respond(
      ErrorResponse,
      {
        error: "A turn is already in progress — nothing was executed; try again.",
        error_code: "TURN_IN_PROGRESS",
      },
      409,
    );
  }
  const result = gated;

  // Internal→wire projection: the wire carries the
  // decision, the governed tuple, the execution result, and the held-call id.
  // The governance internals (auditEntry, matchedEntryId/matchedSource,
  // pendingAuditEntryId) never ship. Explicit mapping code, not a Zod
  // transform; the DO's executeTool() return is unchanged.
  const wire: ExecuteToolResponse = {
    decision: result.governance.decision,
    service: result.governance.service,
    verb: result.governance.verb,
    noun: result.governance.noun,
    execution: result.execution,
    denyReason: result.denyReason,
    held: result.held && { heldCallId: result.held.heldCallId },
  };
  return respond(ExecuteToolResponse, wire);
}

/** The busy sentinel is exactly `{ busy: true }` — check the value, not just
 *  the key, so a future result variant that happens to grow a `busy` field
 *  can never be swallowed into the 409 path. */
function isTurnBusy(result: object): result is { busy: true } {
  return "busy" in result && (result as { busy: unknown }).busy === true;
}

async function handleChat(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = ChatRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "message is required" },
      400,
    );
  }
  const { userId, message } = parsed.data;

  const stub = getUserStub(env, userId);
  let result: Awaited<ReturnType<typeof stub.chat>>;
  try {
    // `/api/chat` is the local interactive surface, gated by network locality
    // only (no caller token). It runs as `human`, so it can task external
    // services but is NEVER offered the control-plane tools — reaching the
    // control plane requires the token-gated `/internal/mcp` surface
    // (`origin: "internal"`).
    result = await stub.chat({
      message,
      userId,
      agentId: PHASE0_AGENT_ID,
      origin: "human",
    });
  } catch (err) {
    // A failed LLM call (Anthropic outage/overload) re-throws out of the loop
    // and the DO — map it to a structured 503/500 instead of a raw text 500.
    return rpcFailureResponse(err);
  }

  // Turn gate: a turn is already mid-flight. The
  // status-only refusal ships as the error envelope, never a result variant
  // (return-kind rule; busy carries no data).
  if (isTurnBusy(result)) {
    return respond(
      ErrorResponse,
      {
        error:
          "A turn is already in progress — wait for it to finish or resolve the pending confirmation first.",
        error_code: "TURN_IN_PROGRESS",
      },
      409,
    );
  }

  // ConversationLoopResult is structurally assignable to the ChatResponse
  // mirror; if the two ever diverge, this line fails to typecheck.
  return respond(ChatResponse, result);
}

async function handleResolve(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = ResolveRequest.safeParse(body);
  if (!parsed.success) {
    return respond(ErrorResponse, { error: resolveRequestError(parsed.error) }, 400);
  }
  const { userId, heldCallId, choice } = parsed.data;

  const stub = getUserStub(env, userId);
  let result: Awaited<ReturnType<typeof stub.resolveConfirmation>>;
  try {
    result = await stub.resolveConfirmation({
      heldCallId,
      choice,
      userId,
      agentId: PHASE0_AGENT_ID,
    });
  } catch (err) {
    // The resume path re-invokes the LLM (resumeHeldTurn), so it has the same
    // upstream-failure exposure as chat — map it, don't leak a raw 500.
    return rpcFailureResponse(err);
  }
  if (result.status === "not_found") {
    // not_found never ships as a result body — it is one of the error sites,
    // so ResolveResponse deliberately does not model it.
    return respond(ErrorResponse, { error: "held call not found" }, 404);
  }
  if (result.status === "invalid_choice") {
    // A choice invalid for the hold's kind (a spending hold
    // refuses the grant-minting answers; an ordinary hold refuses
    // approve_once). An error site like not_found, so ResolveResponse gains no
    // new variant. `error_code` so a client branches on the code, not prose.
    return respond(
      ErrorResponse,
      { error: result.reason, error_code: "INVALID_CHOICE" },
      400,
    );
  }
  // Turn gate: a resume (or another turn) is mid-flight; the call stays
  // parked and unresolved. The resolve() branches on this 409 and
  // re-prompts (the branch was wired ahead of this landing).
  if (result.status === "busy") {
    return respond(
      ErrorResponse,
      {
        error:
          "A turn is already in progress — the call stays parked; try again.",
        error_code: "TURN_IN_PROGRESS",
      },
      409,
    );
  }
  return respond(ResolveResponse, result);
}

/**
 * The interactive launch's handshake. A refusal — a
 * session is already active — is 409 Conflict carrying the refusal payload
 * (the active session's descriptor), so the client can attach and name it.
 * The DO created no second row either way. `agentId` is the shared
 * single-agent constant — the boundary supplies it, not the caller.
 */
async function handleStartSession(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = SessionRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "userId must be a string" },
      400,
    );
  }
  const { userId } = parsed.data;

  const stub = getUserStub(env, userId);
  const result = await stub.startSession({ userId, agentId: PHASE0_AGENT_ID });

  // The 409 refusal is a result, not an error envelope: it validates against
  // StartSessionResponse at whichever status it ships (return-kind rule).
  return respond(StartSessionResponse, result, result.status === "refused" ? 409 : 200);
}

/** Explicit session end (`habenula quit`). Idempotent: `{ ended: false }` when none. */
async function handleQuit(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = SessionRequest.safeParse(body);
  if (!parsed.success) {
    return respond(
      ErrorResponse,
      { error: illFormedStringError(parsed.error) ?? "userId must be a string" },
      400,
    );
  }
  const { userId } = parsed.data;

  const stub = getUserStub(env, userId);
  const result = await stub.endSession("quit");

  return respond(QuitResponse, result);
}

/**
 * The active-session read for `habenula status`. One shape either way:
 * `{ active: ActiveSessionView | null }` — expired sessions are reaped by the
 * DO before reporting, so this never shows a timed-out session as active.
 */
async function handleGetSession(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const active = await stub.getActiveSession();

  return respond(GetSessionResponse, { active });
}

/**
 * The aggregate governed-session read for the rich CLI status and the reactive
 * confirmation prompt. Same `userId`-keyed routing as every
 * other read (`handleGetPolicy`), no new auth surface. The DO composes session
 * + grants + held in one invocation, so the client gets an atomic snapshot.
 */
async function handleGetStatus(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId } = parseUserIdQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const status = await stub.readStatus();

  return respond(StatusResponse, status);
}

/**
 * `GET /api/tasks` — the cross-origin task queue as a bounded page. Same
 * `userId`-keyed routing as every other read;
 * the DO reaps expired sessions before listing so a returned status is never
 * stale. `?limit=` (clamped in the DO) caps the page; `?cursor=` is the opaque
 * keyset token from a prior page's `nextCursor`. A blank or non-numeric `limit`
 * is passed as undefined so the DO falls back to its default — that rule lives
 * in `parseTasksListQuery`, shared with the audit page.
 */
async function handleListTasks(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId, limit, cursor } = parseTasksListQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const tasks = await stub.listTasks({ limit, cursor });

  return respond(TasksListResponse, tasks);
}

/**
 * `GET /api/audit` — one page of the audit chain, newest first, verbatim rows
 * for client-side verification. Same `userId`-keyed routing
 * as every other read, behind the same two guards (credential-key gate,
 * `rejectNonLocal`) — no auth of its own. `?limit=` clamps in the DO;
 * `?cursor=` is the opaque keyset token from a prior page's `nextCursor`; the
 * blank-limit-is-absent rule lives in `parseAuditListQuery`. NO filter
 * parameters exist, so no caller can produce a page set that looks complete
 * and is not.
 */
async function handleListAudit(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const { userId, limit, cursor } = parseAuditListQuery(url.searchParams);

  const stub = getUserStub(env, userId);
  const page = await stub.listAuditEntries({ limit, cursor });

  return respond(AuditListResponse, page);
}

/**
 * `GET /api/tasks/get?taskId=` — one task's full record, including its
 * per-action breakdown and, for a `needs_input` task, the published slot key(s)
 * it awaits. A missing `taskId` is a 400; an unknown one
 * is a 404. Metadata only — never tool output, credentials, or conversation.
 */
async function handleGetTask(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseTaskGetQuery(url.searchParams);
  if (!parsed.success) {
    return respond(ErrorResponse, { error: taskGetRequestError(parsed.error) }, 400);
  }
  const { userId, taskId } = parsed.data;

  const stub = getUserStub(env, userId);
  const detail = await stub.readTaskDetail(taskId);
  if (detail === null) {
    return respond(ErrorResponse, { error: "Task not found" }, 404);
  }

  return respond(TaskDetailResponse, detail);
}

/**
 * `POST /api/tasks/cancel` — the HUMAN cancel surface.
 * Authoritative over EVERY origin: the user cancels a task of any origin,
 * including a runaway `mcp_commission` task, without falling back to
 * `habenula kill` (so `surface: "human"`, never refused on origin). Modelled on
 * `handleResolve`. The three informative outcomes (`cancelled` / `running` /
 * `not_cancellable`) ship as a 200 `TaskCancelResponse`; `not_found` is a 404
 * and a transient `busy` (a live turn is in flight) is a 409 `TURN_IN_PROGRESS`.
 * There is no amend route — amend is MCP-only (a human amends by chatting).
 */
async function handleCancelTask(
  request: Request,
  env: HabenulaEnv
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return respond(ErrorResponse, { error: "Request body must be valid JSON" }, 400);
  }

  const parsed = TaskCancelRequest.safeParse(body);
  if (!parsed.success) {
    return respond(ErrorResponse, { error: taskCancelRequestError(parsed.error) }, 400);
  }
  const { userId, taskId } = parsed.data;

  const stub = getUserStub(env, userId);
  let result: Awaited<ReturnType<typeof stub.cancelTask>>;
  try {
    result = await stub.cancelTask({
      taskId,
      surface: "human",
      userId,
      agentId: PHASE0_AGENT_ID,
    });
  } catch (err) {
    // A storage-layer throw (e.g. a CHECK constraint on a DO whose table predates
    // the widened status enum) must surface as a structured error, not an
    // unhandled raw 500 that gives the CLI nothing to report.
    return rpcFailureResponse(err);
  }

  if (result.status === "not_found") {
    // not_found never ships as a result body — it is an error site, so
    // TaskCancelResponse deliberately does not model it (the return-kind rule).
    return respond(ErrorResponse, { error: "Task not found" }, 404);
  }
  if (result.status === "forbidden") {
    // The human surface is authoritative over every origin, so it never refuses
    // on origin — this is unreachable here. Map it defensively rather than
    // letting an impossible variant fall through to the strict responder.
    return respond(ErrorResponse, { error: "Cancel refused" }, 403);
  }
  if (result.status === "busy") {
    return respond(
      ErrorResponse,
      {
        error: "A turn is already in progress — the task stays queued; try again.",
        error_code: "TURN_IN_PROGRESS",
      },
      409,
    );
  }
  // cancelled | running | resolving | not_cancellable — all ship 200 so the
  // client parses one shape and branches on `status`.
  return respond(TaskCancelResponse, result);
}

/**
 * Shared OAuth callback for every provider, routed by which registered
 * callbackPath matched. Validates the same signed state and consumes it
 * atomically, then hands validation of the returned code and the credential
 * exchange to the provider strategy. A user denial (?error=) stamps the flow
 * `denied` — without consuming it — so the CLI's status poll can observe the
 * outcome; the observing CLI then deletes the row via
 * cancel.
 */
async function handleOAuthCallback(
  request: Request,
  env: HabenulaEnv,
  strategy: OAuthProviderStrategy,
): Promise<Response> {
  const url = new URL(request.url);

  // Providers redirect with ?error=access_denied when the user denies consent.
  // Stamp the flow denied so the CLI's status poll can observe the failure
  // providers echo `state` on the error redirect
  // (Google does, per OAuth 2.0), so parse it and look the flow up exactly as
  // the consent path does. Guarded the same way too: the row loads raw (a
  // flow that lapsed after authorize is still stamped, not degraded to
  // expired) and stamps only when its service resolves to this callback's
  // provider strategy — a foreign-provider state is never stamped. An
  // unparseable state opens no denial channel. The response stays the
  // browser-facing 400 either way.
  //
  // The raw-load and the stamp are two separate stub RPCs, not one
  // transaction; the interleaving is intentionally benign. If the row is
  // consumed (approve) or superseded (a fresh connect inserts a *new*
  // randomPart) between them, the `UPDATE ... WHERE state_key` simply finds
  // no matching row and no-ops — a stamp can never land on another flow.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const denied = parseOAuthState(url.searchParams.get("state"));
    if (denied) {
      const stub = getUserStub(env, denied.userId);
      const stateData = await stub.loadOAuthStateRaw(denied.randomPart);
      if (stateData) {
        const definition = lookupService(stateData.service);
        if (
          definition &&
          definition.connect.type === "oauth" &&
          OAUTH_PROVIDERS[definition.connect.provider] === strategy
        ) {
          await stub.markOAuthFlowDenied(denied.randomPart);
        }
      }
    }
    return json({ error: `Authorization failed: ${oauthError}` }, 400);
  }

  const code = url.searchParams.get("code");
  const parsed = parseOAuthState(url.searchParams.get("state"));

  if (!code || !parsed) {
    return json({ error: "Missing code or state parameter" }, 400);
  }
  const { userId, randomPart } = parsed;

  const stub = getUserStub(env, userId);
  // Load (not consume) first: the strategy is chosen by which callbackPath
  // matched, and the state names the concrete service. Verify the two agree
  // before consuming — a state delivered to the wrong provider's callback must
  // be rejected without destroying the in-flight connect, so the real callback
  // can still consume it. The per-route handlers used to make a cross-provider
  // delivery structurally impossible; the shared callback does not, so the
  // check is explicit here and precedes the one-time consume.
  const stateData = await stub.loadOAuthState(randomPart);
  if (!stateData) {
    return json({ error: "Invalid or expired OAuth state" }, 400);
  }

  const definition = lookupService(stateData.service);
  if (
    !definition ||
    definition.connect.type !== "oauth" ||
    OAUTH_PROVIDERS[definition.connect.provider] !== strategy
  ) {
    return json({ error: "OAuth state does not match this callback" }, 400);
  }

  // Identical to the begin-flow's value (same registered path, same base) —
  // Google's token exchange rejects a redirect_uri that differs from the
  // authorize-time one (RFC 6749 §4.1.3). Derived BEFORE consuming the one-time
  // state: a base that is set but malformed must fail without destroying the
  // in-flight connect, so the user can fix the config and retry the same
  // callback. Surfaced as a 500 naming the bad var, as the begin-flow does — but
  // via raw json(), not the ErrorResponse contract envelope begin-flow returns:
  // this is the browser redirect target, not an /api/* contract endpoint, so
  // every response here stays raw JSON (matching the 400s above).
  let redirectUri: string;
  try {
    redirectUri = resolveCallbackUrl(
      strategy,
      request,
      env,
      definition.connect.provider,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid OAuth redirect base";
    return json({ error: message }, 500);
  }

  // Agreement confirmed and the redirect resolved — now atomically consume the
  // one-time state. A lost race (state consumed between the load and here)
  // surfaces as expired.
  const consumed = await stub.consumeOAuthState(randomPart);
  if (!consumed) {
    return json({ error: "Invalid or expired OAuth state" }, 400);
  }
  // The connecting service's declared scopes, from the catalog — the single
  // source of truth. The mock mints its credential with these; Google ignores
  // them and reads its granted scopes from the token response.
  const scopes = definition.connect.scopes;
  let tokens;
  try {
    tokens = await strategy.exchangeCode(env, {
      query: url.searchParams,
      state: consumed,
      redirectUri,
      scopes,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Token exchange failed";
    return json({ error: message }, 400);
  }

  const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
  const payload = await encryptCredential(encKey, tokens);
  await stub.connectService(consumed.service, JSON.stringify(payload));

  return json({ success: true, service: consumed.service });
}
