// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The route ↔ contract table behind `GET /api/dev/contracts`:
 * every contract-bound route with its query schema, its request schema (input
 * side — what a client sends, before transforms) and its response schema,
 * rendered as JSON Schema via zod's native converter. The visual model page's
 * wire-hop edge detail reads this, and so does the contract fuzzer, which
 * generates its payloads from what this table publishes.
 *
 * The table is maintained by hand next to the routing in `src/index.ts` —
 * adding a contract-bound route means adding a row here — and
 * `scripts/check-contract-descriptors.cjs` fails the build when the two drift
 * in either direction. A route the engine serves and this table omits is
 * uncovered surface that reads as covered; a row for a route no longer
 * dispatched is a schema a client can generate against and never call.
 *
 * Every row states both input sides. `query` is the query string and `request`
 * is the body, so `null` on either means "this route takes no input that way"
 * rather than "this table does not say". A GET therefore carries a query schema
 * and no request; a POST that reads a body carries the reverse.
 *
 * The `/mcp` and `/internal/mcp` surfaces are deliberately absent: they speak
 * MCP, not the Zod wire contract. So are the OAuth browser routes, which answer
 * redirect HTML.
 */
import { z } from "zod";
import {
  AuditListRequest,
  AuditListResponse,
  CatalogResponse,
  ChatRequest,
  ChatResponse,
  ConnectCancelRequest,
  ConnectCancelResponse,
  ConnectFlowStatusRequest,
  ConnectFlowStatusResponse,
  ConnectResponse,
  HealthResponse,
  ContractDescriptorsResponse,
  DisconnectResponse,
  DisconnectServiceRequest,
  ExecuteToolResponse,
  GetSessionResponse,
  GovernanceSnapshotResponse,
  KillResponse,
  PolicyResponse,
  QuitResponse,
  ResolveRequest,
  ResolveResponse,
  ServicesResponse,
  SessionRequest,
  StartSessionResponse,
  StatusResponse,
  TaskCancelRequest,
  TaskCancelResponse,
  TaskDetailResponse,
  TaskGetRequest,
  TasksListRequest,
  TasksListResponse,
  ToolExecuteRequest,
  SettingsResponse,
  SettingsUpdateRequest,
  UserIdQuery,
} from "@habenula-ai/contracts";
import type { ContractDescriptorsResponse as DescriptorsShape } from "@habenula-ai/contracts";

interface RouteContract {
  route: string;
  method: "GET" | "POST";
  /** The query string this route reads; null when it reads none. */
  query: z.ZodType | null;
  /** The body this route reads; null when it reads none. */
  request: z.ZodType | null;
  response: z.ZodType;
}

const ROUTE_CONTRACTS: RouteContract[] = [
  { route: "/api/chat", method: "POST", query: null, request: ChatRequest, response: ChatResponse },
  { route: "/api/resolve", method: "POST", query: null, request: ResolveRequest, response: ResolveResponse },
  { route: "/api/tools/execute", method: "POST", query: null, request: ToolExecuteRequest, response: ExecuteToolResponse },
  { route: "/api/session/start", method: "POST", query: null, request: SessionRequest, response: StartSessionResponse },
  { route: "/api/session/quit", method: "POST", query: null, request: SessionRequest, response: QuitResponse },
  { route: "/api/session", method: "GET", query: UserIdQuery, request: null, response: GetSessionResponse },
  { route: "/api/status", method: "GET", query: UserIdQuery, request: null, response: StatusResponse },
  { route: "/api/tasks", method: "GET", query: TasksListRequest, request: null, response: TasksListResponse },
  { route: "/api/tasks/get", method: "GET", query: TaskGetRequest, request: null, response: TaskDetailResponse },
  { route: "/api/tasks/cancel", method: "POST", query: null, request: TaskCancelRequest, response: TaskCancelResponse },
  { route: "/api/audit", method: "GET", query: AuditListRequest, request: null, response: AuditListResponse },
  { route: "/api/policy", method: "GET", query: UserIdQuery, request: null, response: PolicyResponse },
  { route: "/api/settings", method: "GET", query: UserIdQuery, request: null, response: SettingsResponse },
  { route: "/api/settings", method: "POST", query: null, request: SettingsUpdateRequest, response: SettingsResponse },
  { route: "/api/kill", method: "POST", query: null, request: SessionRequest, response: KillResponse },
  { route: "/api/services", method: "GET", query: UserIdQuery, request: null, response: ServicesResponse },
  // The connectable set is discovery only and carries no user state, so this
  // route reads no parameters at all — not even a userId.
  { route: "/api/services/catalog", method: "GET", query: null, request: null, response: CatalogResponse },
  { route: "/api/services/disconnect", method: "POST", query: null, request: DisconnectServiceRequest, response: DisconnectResponse },
  // A POST whose inputs are the {service} path segment and `?userId=`, never a
  // body — `handleConnectEntry` reads url.searchParams and ignores any body. So
  // the query side carries the contract and the request side is null.
  { route: "/connect/{service}", method: "POST", query: UserIdQuery, request: null, response: ConnectResponse },
  { route: "/api/connect/status", method: "GET", query: ConnectFlowStatusRequest, request: null, response: ConnectFlowStatusResponse },
  { route: "/api/connect/cancel", method: "POST", query: null, request: ConnectCancelRequest, response: ConnectCancelResponse },
  { route: "/api/health", method: "GET", query: null, request: null, response: HealthResponse },
  { route: "/api/dev/model", method: "GET", query: UserIdQuery, request: null, response: GovernanceSnapshotResponse },
  { route: "/api/dev/contracts", method: "GET", query: null, request: null, response: ContractDescriptorsResponse },
];

/**
 * Render a schema as a JSON-friendly descriptor. `io: "input"` on the query and
 * request sides: the edge detail documents what a client sends (`userId`
 * optional, defaults applied server-side), not the post-transform value.
 * `unrepresentable: "any"` so an exotic leaf degrades to `{}` instead of
 * throwing — this is a display surface, not a validator.
 */
function describe(schema: z.ZodType, io: "input" | "output") {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
}

export function buildContractDescriptors(): DescriptorsShape {
  return {
    routes: ROUTE_CONTRACTS.map((entry) => ({
      route: entry.route,
      method: entry.method,
      query: entry.query ? describe(entry.query, "input") : null,
      request: entry.request ? describe(entry.request, "input") : null,
      response: describe(entry.response, "output"),
    })),
  };
}
