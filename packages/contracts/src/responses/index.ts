// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Response-body schemas for every /api/* endpoint. Every
// object is z.strictObject at every nesting level: an unknown key at any
// described depth fails parse, so additive drift is caught, not silently
// stripped. The only unpinned leaves are genuinely-opaque z.unknown() payloads.
export {
  ChatResponse,
  ToolCallOutcome,
  ToolCallRecord,
  UNRECOGNIZED_TOOL_NAME,
} from "./chat.js";
export { ENGINE_ID, HealthResponse } from "./health.js";
export { HeldRef } from "./held.js";
export { PolicyEntry, PolicyResponse } from "./policy.js";
export { CatalogResponse, DisconnectResponse, ServicesResponse } from "./services.js";
export { KillResponse } from "./kill.js";
export {
  ConnectCancelResponse,
  ConnectFlowStatusResponse,
  ConnectResponse,
} from "./connect.js";
export { ExecuteToolResponse } from "./tools.js";
export { ResolveResponse } from "./resolve.js";
export { AuditTail, GrantView, HeldCallRecord, StatusResponse } from "./status.js";
export {
  TaskActionDetail,
  TaskCancelResponse,
  TaskDetailResponse,
  TaskOrigin,
  TaskStatus,
  TaskSummary,
  TasksListResponse,
} from "./tasks.js";
export { AuditChainEntry, AuditListResponse } from "./audit.js";
export {
  ContractDescriptorsResponse,
  RouteContractDescriptor,
} from "./dev-contracts.js";
export {
  AuditEntryRecord,
  CommissionRunRecord,
  ConnectedServiceRecord,
  GovernanceSnapshotResponse,
  HeldCallDetailRecord,
  PolicyEntryRecord,
  TableCounts,
} from "./governance-snapshot.js";
export {
  ActiveSessionView,
  GetSessionResponse,
  QuitResponse,
  StartSessionResponse,
} from "./session.js";
export { SettingsResponse } from "./settings.js";
