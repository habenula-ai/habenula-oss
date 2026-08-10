// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Request schemas for every /api/* endpoint, moved verbatim from
// packages/engine/src/validation/*. Plain
// z.object on purpose: requests keep the accept-set (unknown top-level
// keys strip, never reject) — strictness is a response-side decision only.
//
// Both sides of a request live here: the body schemas, and the query schemas
// for the routes that read a query string instead. A `parse*Query` helper
// belongs next to its schema, so the one place that states the shape is also
// the one place that reads `URLSearchParams`.
export {
  UserIdQuery,
  illFormedStringError,
  limitParam,
  parseUserIdQuery,
  userIdField,
  wellFormedString,
} from "./common.js";
export { ChatRequest } from "./chat.js";
export {
  ConnectCancelRequest,
  ConnectFlowStatusRequest,
  connectFlowStatusRequestError,
  parseConnectFlowStatusQuery,
} from "./connect.js";
export { DisconnectServiceRequest } from "./services.js";
export { SessionRequest } from "./session.js";
export { ToolExecuteRequest } from "./tools.js";
export { RESOLVE_CHOICES, ResolveRequest, resolveRequestError } from "./resolve.js";
export {
  TaskCancelRequest,
  TaskGetRequest,
  TasksListRequest,
  parseTaskGetQuery,
  parseTasksListQuery,
  taskCancelRequestError,
  taskGetRequestError,
} from "./tasks.js";
export { AuditListRequest, parseAuditListQuery } from "./audit.js";
export { SettingsUpdateRequest, settingsUpdateRequestError } from "./settings.js";
