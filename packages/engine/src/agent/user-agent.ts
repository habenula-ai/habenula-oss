// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HabenulaEnv } from "../env";
import { Agent } from "agents";
import {
  importEncryptionKey,
  SingleFlightRefresher,
  CredentialNotFoundError,
  loadCredential,
  type CredentialRowStore,
  type StoredCredential,
} from "@habenula-ai/credentials";
import {
  evaluatePolicy,
  evaluateSpend,
  WILDCARD_DENY_ID,
  type PolicyEntry,
  type SpendBreach,
} from "@habenula-ai/governance";
import { lookupTool, publishedDataSlots, REFRESH_FNS } from "@habenula-ai/tools";
import { TABLES } from "../data/ddl";
import type { EngineSql } from "../data/helpers/types";
import * as connectedServicesData from "../data/helpers/connected-services";
import * as sessionStateData from "../data/helpers/session-state";
import * as heldToolCallsData from "../data/helpers/held-tool-calls";
import * as oauthStateData from "../data/helpers/oauth-state";
import * as policyEntriesData from "../data/helpers/policy-entries";
import * as auditLogData from "../data/helpers/audit-log";
import * as commissionRunsData from "../data/helpers/commission-runs";
import type { CommissionRunsRow } from "../data/schemas/commission-runs";
import * as tableCountsData from "../data/helpers/table-counts";
import * as spendLedgerData from "../data/helpers/spend-ledger";
import * as userSettingsData from "../data/helpers/user-settings";
import type {
  AuditEntryParams as WriteAuditEntryParams,
  AuditEntryResult as WriteAuditEntryResult,
  AuditOrigin,
  CloserBasis,
  ReferencingAuditEntryParams,
} from "../data/helpers/audit-log";
import type { OAuthStateData } from "../oauth/types";
import {
  createLLMClient,
  readLLMConfig,
  type LLMConfig,
} from "../llm/create-llm-client";
import { wrapTurnState, parseTurnState } from "../llm/canonical";
import {
  recordToolName,
  runConversationLoop,
  type ConversationLoopResult,
  type HeldTurnState,
  type ResumeState,
  type RunOrigin,
  type ToolCallOutcome,
  type ToolCallRecord,
} from "../llm/conversation";
import type {
  StatusResponse,
  AuditChainEntry,
  AuditListResponse,
  AuditTail,
  GrantView,
  HeldCallRecord,
  TaskActionDetail,
  TaskDetailResponse,
  TaskSummary,
  TasksListResponse,
  HeldCallDetailRecord,
  GovernanceSnapshotResponse,
  SettingsResponse,
} from "@habenula-ai/contracts";
import { COMMISSION_ORIGIN_NOTICE, HABENULA_SYSTEM_PROMPT } from "../llm/system-prompt";
import { fenceUntrusted } from "../llm/untrusted-fence";
import { buildToolDefinitions } from "../llm/tool-definitions";
import {
  CONTROL_PLANE_REFUSAL,
  CONTROL_PLANE_SERVICE,
  controlPlaneAllowed,
  isControlPlaneTool,
} from "../llm/control-plane";
import type {
  LLMClient,
  LLMMessage,
  LLMToolResultBlock,
  LLMToolUseBlock,
} from "../llm/types";

/**
 * Session lifetime: 90 minutes from the recorded session start. The
 * single expiry source for a session — session grants and held calls are all
 * anchored to `session_state.started_at + SESSION_LIFETIME_MS`.
 */
const SESSION_LIFETIME_MS = 90 * 60 * 1000;

/**
 * Bounded window for the visual-model snapshot's audit and commission lists
 * — newest N, with the full count riding alongside as `total`.
 */
const SNAPSHOT_WINDOW = 50;

/**
 * The terminal audit `error_message` that closes a hold whose tool dispatched
 * but whose outcome was lost to a crash. Shared by the two paths that can
 * discover such a row — a retried `resolveConfirmation` and the chat-path heal
 * (`healCrashedDispatchHolds`) — so one crash reads the same on the
 * accountability surface however it is recovered.
 */
const DISPATCH_RECOVERY_ERROR = "Recovered after interruption — outcome unknown";

/**
 * The `tool_result` content fed to the LLM for such a call. Deliberately NOT an
 * error and deliberately not "may or may not have executed": the `dispatched`
 * marker proves the call ran, so the model must read the turn as complete and
 * not re-trigger a side-effecting tool. The real outcome is `error` (unknown)
 * on the audit row above — the record never claims the success this steering
 * string implies.
 */
const DISPATCH_RECOVERY_RESULT = "Tool completed (result unavailable after interruption).";

export interface ExecuteToolParams {
  toolName: string;
  toolParams: Record<string, unknown>;
  userId: string;
  agentId: string;
  /** Provenance of the action. Defaults to 'human'. */
  origin?: AuditOrigin;
  /**
   * The trust surface the run came in on — the DISPATCH half of the two-surface
   * boundary. A `habenula` control-plane tool is refused unless this is
   * `internal`, whatever the model named. Omitted defaults to `human`, which
   * fails closed: a caller that does not state its surface (the direct
   * `POST /api/tools/execute` route, which is gated by network locality alone)
   * does not reach the control plane. Never wire-supplied — every entry point
   * sets it from the surface it is, not from the request body.
   */
  runOrigin?: RunOrigin;
  /** The commission run a held call belongs to; null on the CLI path. */
  runId?: string | null;
  epochId?: string;
  timestamp?: string;
}

/**
 * Why a deny decision happened. Surfaced through ExecuteToolResult so the
 * conversation loop and the CLI can distinguish "the service is not
 * connected" (fix: connect a service) from "the service is connected but its
 * stored credential's granted scopes don't cover this tool" (fix: re-connect
 * to grant the wider scope) from "the user's policy
 * denied this" (fix: change the policy). All three share decision === "deny"
 * but the appropriate user remediation is completely different.
 */
export type DenyReason = "not_connected" | "needs_authorization" | "policy";

export interface ExecuteToolResult {
  governance: GovernancePipelineResult;
  execution?: {
    success: boolean;
    data?: unknown;
    error?: string;
  };
  /**
   * Set when governance.decision === "deny". Undefined for allow/confirm — and
   * undefined on the one deny that names no remediation, the boundary refusal
   * below. A caller reading this field to decide what to tell the user must
   * therefore check `boundaryRefused` too, not treat a missing reason as
   * "policy".
   */
  denyReason?: DenyReason;
  /**
   * Set when the deny is the two-surface boundary refusing a control-plane tool
   * named by a run that may not reach it. Deliberately NOT a `DenyReason`: that
   * vocabulary is the closed set of remediations a caller can act on, and this
   * refusal has none. It travels beside `denyReason` rather than inside it so
   * the wire keeps its three values while the engine can still tell the model
   * the boundary refused the call instead of letting it read as a policy deny.
   */
  boundaryRefused?: boolean;
  /**
   * Set when governance.decision === "pending" — the call was parked to ask
   * the user. Carries the held-call id and the pending audit
   * entry id so the conversation loop can persist the in-flight turn state.
   * No dispatch happened and no outcome entry was written.
   */
  held?: { heldCallId: string; pendingAuditEntryId: string };
}

/**
 * The outcome of resolveConfirmation():
 *  - not_found: the held-call id did not match (stale/wrong/expired) — nothing
 *    executed.
 *  - info: "Tell me more" — the registry metadata block; held call untouched.
 *  - resumed: a grant or deny resolved the call and the turn re-ran (the loop
 *    result may itself be held again if a parked call needs confirmation).
 */
export type ConfirmationResolution =
  | { status: "not_found" }
  | { status: "busy" }
  | {
      status: "info";
      metadata: { service: string; verb: string; noun: string; description: string };
    }
  | { status: "resumed"; result: ConversationLoopResult }
  /**
   * The choice is not valid for this hold's kind: a spend
   * hold accepts only `deny` and `approve_once` — a session-scoped answer
   * would silently raise the ceiling, and permission already passed so there
   * is no grant to mint — and an ordinary hold rejects `approve_once`
   * symmetrically. Rejected engine-side so no client can mint a ceiling,
   * regardless of what a UI renders; the route maps this to a 400.
   */
  | { status: "invalid_choice"; reason: string };

/**
 * The active session as surfaced to the boundary (`habenula status`, the
 * launch handshake). Row fields plus the computed 90-minute expiry instant
 * in camelCase, matching the other TS-facing shapes.
 * `expiry` is null when `started_at` is unparseable (a poisoned anchor —
 * the same corruption `sessionStartedAt` guards against): the view degrades
 * rather than throwing. Defense-in-depth — the reaper ends poisoned rows, so
 * the reaping callers should never see one.
 */
export interface ActiveSessionView {
  sessionId: string;
  startedAt: string;
  expiry: string | null;
}

/**
 * The outcome of `startSession`. `refused` carries the
 * session that blocked the start so the client can attach and name it; the DO
 * created no second row either way — that is the single-active guarantee.
 */
export type StartSessionResult =
  | { status: "started"; activeSession: ActiveSessionView }
  | { status: "refused"; activeSession: ActiveSessionView };

/** The outcome of `endSession` — `ended: false` when there was nothing to end. */
export interface EndSessionResult {
  ended: boolean;
}

/**
 * Commission input caps (plan-pinned). Enforced at the MCP boundary AND at
 * the DO itself — the DO never trusts the boundary alone (the F4 rationale),
 * and an unbounded goal/data would bloat the shared conversation buffer.
 */
export const COMMISSION_GOAL_MAX_CHARS = 4_000;
export const COMMISSION_DATA_MAX_CHARS = 16_000;

/**
 * The bounded-queue depth for pending `mcp_commission` tasks.
 * Replaces the earlier one-unresolved-commission cap: several commissions may
 * wait, but no more than this, so an untrusted client cannot pile up unbounded
 * work. Never applies to `human`-origin turns (the trusted CLI is never
 * starved). The policy-configurable version is future work.
 */
export const MAX_PENDING_COMMISSIONS = 8;

/**
 * The outcome of `commissionGoal`. `busy` means no
 * run was created — the client retries; `reason` is a fixed engine
 * vocabulary, never model text.
 */
export type CommissionOutcome =
  | { status: "busy"; reason: "turn_in_flight" | "held_call_pending" | "commission_pending" }
  | {
      runId: string;
      status: Exclude<commissionRunsData.CommissionRunStatus, "running">;
    };

/**
 * What `readCommissionRun` reports to `habenula_result`.
 * Run-level status plus the finer, metadata-only additions: the
 * per-action breakdown (`statusDetail`) and — for a `needs_input` run — the
 * published slot key(s) it awaits. Never tool output, credentials, or
 * conversation content (the closed surface is preserved).
 */
export interface CommissionRunView {
  runId: string;
  status: commissionRunsData.CommissionRunStatus;
  statusDetail: TaskActionDetail[] | null;
  awaitedSlotKeys: string[] | null;
}

/**
 * The outcome of `provideTaskInput` behind `habenula_provide`.
 * `busy` = a live turn is in flight (retry). `not_found` = no such task
 * or it owns no input hold. `not_awaiting_input` = the task is not parked on
 * `needs_input`. Otherwise the task's status after the resumed call settles —
 * `awaiting_confirmation` when the provided value still needs a grant (bind ≠
 * grant), `needs_input` again if a required slot is still unbound, or a terminal
 * status.
 */
export type ProvideTaskInputResult =
  | { status: "busy" }
  | { status: "not_found" }
  | {
      status: "not_awaiting_input";
      currentStatus: commissionRunsData.CommissionRunStatus;
    }
  // The supplied keys don't intersect the slot(s) the task awaits — a
  // deterministic boundary refusal (like an unknown key), returned BEFORE any
  // mutation or audit write, so a client cannot churn the task/audit log by
  // providing values it never asked for.
  | { status: "no_matching_slot"; awaitedSlotKeys: string[] }
  | { taskId: string; status: commissionRunsData.CommissionRunStatus };

/**
 * The outcome of `cancelTask`. Cancel authority is split
 * by surface: `surface: "human"` (CLI/HTTP) is authoritative over every origin;
 * `surface: "mcp"` is own-task-scoped and yields `forbidden` on a cross-origin
 * cancel. `busy` = a live turn is in flight (retry). `running` = the target
 * holds the live turn and is never cancelled mid-flight (retry once it parks).
 * `not_cancellable` = the task is already terminal. `cancelled` carries the
 * status the task held before the cancel (always a parked state).
 */
export type CancelTaskResult =
  | { status: "cancelled"; taskId: string; previousStatus: commissionRunsData.CommissionRunStatus }
  | { status: "running"; taskId: string }
  | { status: "busy"; taskId: string }
  // A hold on this task is mid-resolve (dispatched/answered): its action already
  // ran or was decided, and its terminal audit outcome is owed by the resolve
  // path. Cancelling would record a false "never ran" disposition, so it is
  // refused until the resolve settles (then the task is terminal anyway).
  | { status: "resolving"; taskId: string }
  | { status: "not_cancellable"; taskId: string; currentStatus: commissionRunsData.CommissionRunStatus }
  | { status: "not_found" }
  | { status: "forbidden" };

/**
 * The outcome of `amendTask` behind `habenula_amend`.
 * Amend is MCP-only and own-task-scoped, so `forbidden` guards a non-commission
 * task. `busy` = a live turn is in flight (retry). `running` = the task holds the
 * live turn (retry once it parks). `not_amendable` = the task is not in an
 * amendable (parked) state. Otherwise the task's (unchanged) status after the
 * corrected data is persisted — amend re-supplies data, it does not resume.
 */
export type AmendTaskResult =
  | { status: "busy"; taskId: string }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "running"; taskId: string }
  | { status: "not_amendable"; currentStatus: commissionRunsData.CommissionRunStatus }
  | { taskId: string; status: commissionRunsData.CommissionRunStatus };

/**
 * `GET /api/tasks` view bounds. The list is capped so a
 * DO holding a long commission history never returns an unbounded payload;
 * `?limit=` is clamped to `[1, TASK_LIST_MAX_LIMIT]` and defaults to
 * `TASK_LIST_DEFAULT_LIMIT`. The bound is on the *view* only — task rows are
 * never pruned (they stay the queue's forensic surface).
 */
export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 200;

/**
 * The pinned terminal mapping, computed from the
 * run-cumulative toolCalls[].outcome — the loop accumulates records across
 * cascades via the persisted held state, so "none succeeded" is well-defined
 * for a multi-hold run. `completed` for any success or a zero-action turn
 * (mixed outcomes report completed — per-action truth is the audit log);
 * `denied` when actions were attempted, none succeeded, and every failure was
 * a refusal; `failed` when at least one errored. A THROWN turn maps to
 * `failed` at the call site (fresh turns only — a thrown resume is not
 * terminal; the retry applies).
 */
export function commissionTerminalStatus(
  toolCalls: ToolCallRecord[],
): "completed" | "denied" | "failed" {
  const attempted = toolCalls.filter((c) => c.outcome !== "held");
  if (attempted.length === 0) return "completed";
  if (attempted.some((c) => c.outcome === "success")) return "completed";
  return attempted.some((c) => c.outcome === "error") ? "failed" : "denied";
}

/**
 * A short, human-readable label for a task, derived from its goal. Used when the `label` column is unset. The goal is external-agent-
 * authored text, so the label inherits that provenance — a client renderer
 * sanitizes it, exactly as it does the goal itself. First non-empty line,
 * clipped to a readable length.
 */
export function deriveTaskLabel(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const base = firstLine.length > 0 ? firstLine : goal.trim();
  // Clip by code point, not UTF-16 unit, so an emoji or other astral character
  // at the boundary is never split into a lone surrogate.
  const chars = [...base];
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : base;
}

/** Parse the stored per-action status detail (a JSON array), null-safe. */
function parseStatusDetail(raw: string | null): TaskActionDetail[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Guard a corrupted non-array value (e.g. `"{}"`): fall back to null rather
    // than letting a malformed shape reach the strict wire contract and 500.
    return Array.isArray(parsed) ? (parsed as TaskActionDetail[]) : null;
  } catch {
    return null;
  }
}

/** Parse the stored awaited-slot-key list (a JSON array), null-safe. */
function parseAwaitedSlotKeys(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return null;
  }
}

/**
 * True when an `oauth_state` row's `expires_at` is at or before now.
 *
 * A string comparison, and deliberately so: `expires_at` is a fixed-width
 * ISO-8601 UTC string (`Date.toISOString()`), a form whose lexicographic order
 * is its chronological order, so `<=` reads as "at or before". Comparing here
 * in JS rather than in SQL also keeps this path clear of the `strftime` trap
 * `queryPolicyEntries` documents. The three oauth call sites share this so the
 * reasoning is stated once.
 */
function isOAuthStateExpired(expiresAt: string): boolean {
  return expiresAt <= new Date().toISOString();
}

/**
 * Clamp a client-supplied `?limit=` to `[1, TASK_LIST_MAX_LIMIT]`, defaulting a
 * missing/NaN value to `TASK_LIST_DEFAULT_LIMIT`.
 */
function clampTaskListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TASK_LIST_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > TASK_LIST_MAX_LIMIT) return TASK_LIST_MAX_LIMIT;
  return n;
}

/**
 * The opaque keyset cursor for `GET /api/tasks` pagination:
 * the last row's `(created_at, id)`, base64-wrapped so the client treats it
 * as opaque and passes it back verbatim as `?cursor=`. `created_at` (ISO) and
 * `id` are ASCII, so `btoa` never throws on the join.
 */
function encodeTaskCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`);
}

/** Decode a `?cursor=` back to its `(created_at, id)` keyset, or undefined for a
 * missing/malformed token (fail-safe: a bad cursor yields the first page, never
 * a thrown 500). */
function decodeTaskCursor(
  cursor: string | null | undefined,
): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = atob(cursor);
    const sep = decoded.indexOf("|");
    if (sep < 0) return undefined;
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return undefined;
  }
}

/**
 * `GET /api/audit` page bounds. The default serves
 * `habenula log`'s newest-page read; the cap bounds a full `log verify` /
 * `log dump` walk's per-page payload — audit rows are fatter than task rows
 * (`parameters_metadata` alone is capped at 10 KB by extractMetadata), so a
 * 200-row page is ~220 KB typically and ~2 MB worst case. The CLI's walk
 * requests a deliberately large limit and lets this clamp decide, so raising
 * the cap here widens a walk's covered range with no CLI change.
 */
export const AUDIT_PAGE_DEFAULT_LIMIT = 20;
export const AUDIT_PAGE_MAX_LIMIT = 200;

/**
 * Clamp a client-supplied `?limit=` to `[1, AUDIT_PAGE_MAX_LIMIT]`, defaulting
 * a missing/NaN value to `AUDIT_PAGE_DEFAULT_LIMIT` — `clampTaskListLimit`'s
 * shape over the audit bounds.
 */
function clampAuditPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return AUDIT_PAGE_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > AUDIT_PAGE_MAX_LIMIT) return AUDIT_PAGE_MAX_LIMIT;
  return n;
}

/**
 * The opaque keyset cursor for `GET /api/audit`: the page's last row's
 * `(epoch_id, sequence_num)`, base64-wrapped like the task cursor. Both
 * halves are ASCII, so `btoa` never throws on the join.
 */
function encodeAuditCursor(epochId: string, sequenceNum: number): string {
  return btoa(`${epochId}|${sequenceNum}`);
}

/**
 * Decode a `?cursor=` back to its `(epoch_id, sequence_num)` keyset, or
 * undefined for a missing/malformed token (fail-safe: a bad cursor yields the
 * first page — safe here because the CLI walk's stall check catches a cursor
 * that restarts at page one). The sequence half must decode to a non-negative
 * integer NUMBER: `sequence_num` has integer affinity, so binding a malformed
 * half back as a string would let SQLite's numeric coercion turn it into 0
 * and silently return the wrong page.
 */
function decodeAuditCursor(
  cursor: string | null | undefined,
): { epochId: string; sequenceNum: number } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = atob(cursor);
    const sep = decoded.indexOf("|");
    if (sep < 0) return undefined;
    const rawSequence = decoded.slice(sep + 1);
    if (!/^\d+$/.test(rawSequence)) return undefined;
    const sequenceNum = Number(rawSequence);
    if (!Number.isSafeInteger(sequenceNum)) return undefined;
    return { epochId: decoded.slice(0, sep), sequenceNum };
  } catch {
    return undefined;
  }
}

/** Map a stored audit row to its wire shape: snake to camel, verbatim, no
 * projection. */
function auditChainEntryFromRow(row: auditLogData.AuditChainRow): AuditChainEntry {
  return {
    epochId: row.epoch_id,
    sequenceNum: row.sequence_num,
    prevHash: row.prev_hash,
    id: row.id,
    timestamp: row.timestamp,
    userId: row.user_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    origin: row.origin,
    service: row.service,
    verb: row.verb,
    noun: row.noun,
    toolName: row.tool_name,
    parametersMetadata: row.parameters_metadata,
    decision: row.decision,
    outcome: row.outcome,
    errorMessage: row.error_message,
    decisionEntryId: row.decision_entry_id,
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
    hash: row.hash,
    epochPrevHash: row.epoch_prev_hash,
  };
}

/** Project a task row to the wire summary. */
function taskSummaryFromRow(
  row: Pick<
    CommissionRunsRow,
    "id" | "origin" | "goal" | "status" | "label" | "created_at" | "updated_at"
  >,
): TaskSummary {
  return {
    taskId: row.id,
    origin: row.origin,
    status: row.status,
    label: row.label ?? deriveTaskLabel(row.goal),
    goal: row.goal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface GovernancePipelineParams {
  toolName: string;
  params: Record<string, unknown>;
  userId: string;
  agentId: string;
  sessionId: string;
  entries: PolicyEntry[];
  /** Provenance recorded on the audit entry. Defaults to 'human'. */
  origin?: AuditOrigin;
  /** Override for testing epoch boundaries. */
  epochId?: string;
  /** Override for testing. */
  timestamp?: string;
  /** Override the default deny reason in the audit log. */
  denyReason?: string;
  /**
   * When true, a no-affirmative-grant result becomes `pending` (the call is
   * held to ask the user) rather than a plain deny. Set on the main tool path;
   * left false where there is no confirmation path (e.g. the not-connected
   * pre-check, which is a connect-a-service problem, not a grant gap).
   */
  askable?: boolean;
}

/**
 * Why a money-verb call is held for spending approval, persisted as JSON in
 * `held_tool_calls.spend_context`. Amounts and limits
 * only — never cart contents; the metadata-only posture holds.
 */
export interface SpendHoldContext {
  /** The bound quote's total in integer cents; null when undecodable. */
  amountCents: number | null;
  reason: "over_limit" | "unpriced" | "totals_unavailable";
  breaches: SpendBreach[];
  /** What is being bought, for the confirmation surface (service-supplied). */
  summary?: string;
}

const SPEND_REASONS = ["over_limit", "unpriced", "totals_unavailable"] as const;

/**
 * Read a persisted spend context, validating its SHAPE — not merely that it
 * parses. The field is engine-written, so a wrong-shaped value means a
 * corrupted or tampered row, and both readers must fail CLOSED: a `null` here
 * would demote a spending hold to an ordinary one, which accepts `session` and
 * mints a grant on a money verb, and would ship `{}` to the confirmation
 * surface where the CLI renders `$NaN` and iterates undefined breaches.
 *
 * Returns `undefined` for "no context" (an ordinary hold) and `null` for
 * "there IS a context but it is unreadable" — the caller keeps treating the
 * row as a spending hold and offers only the spend answers.
 */
function parseSpendContext(
  json: string | null,
): SpendHoldContext | null | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  const amountOk =
    c.amountCents === null ||
    (typeof c.amountCents === "number" && Number.isSafeInteger(c.amountCents));
  const reasonOk =
    typeof c.reason === "string" &&
    (SPEND_REASONS as readonly string[]).includes(c.reason);
  const summaryOk =
    c.summary === undefined ||
    (typeof c.summary === "string" && c.summary.length <= 120);
  if (!amountOk || !reasonOk || !summaryOk || !Array.isArray(c.breaches)) return null;
  const breaches: SpendBreach[] = [];
  for (const raw of c.breaches) {
    if (typeof raw !== "object" || raw === null) return null;
    const b = raw as Record<string, unknown>;
    if (
      (b.window !== "session" && b.window !== "month") ||
      !Number.isSafeInteger(b.limitCents) ||
      !Number.isSafeInteger(b.spentCents)
    ) {
      return null;
    }
    breaches.push({
      window: b.window,
      limitCents: b.limitCents as number,
      spentCents: b.spentCents as number,
    });
  }
  return {
    amountCents: c.amountCents as number | null,
    reason: c.reason as SpendHoldContext["reason"],
    breaches,
    ...(c.summary !== undefined ? { summary: c.summary as string } : {}),
  };
}

export interface GovernancePipelineResult {
  // allow | deny | pending — `pending` is produced when an askable call finds
  // no affirmative grant, or when a money-verb allow breaches the
  // spending cap (a breach asks, it never blocks). The
  // decision audit entry is already written by the time this returns.
  decision: "allow" | "deny" | "pending";
  auditEntry: WriteAuditEntryResult;
  service: string;
  verb: string;
  noun: string;
  /** The policy entry that authorized this call (for consume-on-use). */
  matchedEntryId?: string;
  matchedSource?: string;
  /** Set when the spend stage flipped an allow to pending — the hold's context. */
  spendContext?: SpendHoldContext;
}

/**
 * Per-user Durable Object. This release runs a single DO per user
 * that will later split into coordinator + worker DOs.
 */
export { CredentialNotFoundError };

export class UserAgent extends Agent<HabenulaEnv> {
  private readonly refresher = new SingleFlightRefresher();
  private conversationMessages: LLMMessage[] = [];
  private llmClient: LLMClient | null = null;
  private llmConfig: LLMConfig | null = null;

  /**
   * The turn-in-flight marker:
   * serializes the conversation loop across every origin — chat, commission,
   * and confirmation-resume all mutate the one shared buffer across await
   * points, so two may never run together. Deliberately in-memory, NOT
   * SQLite: a crash bypasses `finally`, and a persisted flag would wedge the
   * DO permanently (the spec's named lockout); an isolate death kills the
   * turn with the flag, so a fresh instance booting `false` is the truth.
   */
  private turnInFlight = false;

  /**
   * Run a loop-owning body under the marker. The check-and-set is synchronous
   * before the body's first await (the DO is single-threaded between awaits,
   * so there is no TOCTOU), and the `finally` clears on every exit path —
   * success, parking as a held call, and error/throw alike.
   */
  private async withTurnGate<T>(
    busy: () => T,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.turnInFlight) return busy();
    this.turnInFlight = true;
    try {
      return await run();
    } finally {
      this.turnInFlight = false;
    }
  }

  /**
   * The agents SDK `this.sql` tagged template, bound once so data helpers
   * (data/helpers/*) can issue queries without re-binding at every call site
   * — bound `this` avoids a lost-`this` bug.
   */
  private readonly sqlTag: EngineSql = this.sql.bind(this) as EngineSql;

  constructor(ctx: DurableObjectState, env: HabenulaEnv) {
    super(ctx, env);
    this.migrate();
  }

  /** Inject an LLM client (for tests). */
  setLLMClient(client: LLMClient): void {
    this.llmClient = client;
  }

  private getLLMClient(): LLMClient {
    if (this.llmClient) return this.llmClient;
    this.llmClient = createLLMClient(this.getLLMConfig());
    return this.llmClient;
  }

  /**
   * The deployment's LLM config tuple, read once per DO instance
   * (deployment-static — a live session never changes provider mid-flight).
   * Also the source of the model/maxTokens the
   * conversation-loop call sites pass.
   */
  private getLLMConfig(): LLMConfig {
    if (this.llmConfig) return this.llmConfig;
    this.llmConfig = readLLMConfig(this.env);
    return this.llmConfig;
  }

  /** Run a conversation turn through the LLM with governance-gated tool execution. */
  async chat(params: {
    message: string;
    userId: string;
    agentId?: string;
    /**
     * Which trust surface the turn came in on.
     * Decides whether the control-plane tools are offered this turn — only
     * `internal` (the token-gated `/internal/mcp` surface) gets them
     * — defaults to `human` (fail-closed): the local
     * `/api/chat` path passes no origin and must NOT reach the control plane on
     * network locality alone. The internal MCP host passes `internal` explicitly.
     */
    origin?: RunOrigin;
  }): Promise<ConversationLoopResult | { busy: true }> {
    const { message, userId, agentId = "default", origin = "human" } = params;
    // Turn gate first: a second chat arriving while any turn (chat,
    // commission, or resume) is mid-flight is refused, not interleaved into
    // the shared buffer. The boundary maps this to HTTP 409.
    return this.withTurnGate<ConversationLoopResult | { busy: true }>(
      () => ({ busy: true }),
      async () => {

    // Lazy reaper: close out any session that passed its 90-min cap —
    // write the held call's terminal denied outcome + session.end (effective
    // instant) and sweep the held row. No alarm; this is the "next DO activity"
    // hook. Runs before the guard so an expired prior session's held row is
    // reaped, not just skipped.
    this.reapExpiredSessions();

    // Heal a crash-orphaned mid-dispatch hold BEFORE the guard: a
    // human hold marked `dispatched` with no `answered` is not awaiting a
    // decision, so status renders nothing for it, yet the guard below would
    // refuse every turn on it. Closing it out here is what keeps the two
    // readers from disagreeing. The tool is never re-dispatched.
    const healedDispatches = this.healCrashedDispatchHolds(userId, agentId);

    // Held-call guard, scoped to the human task: refuse a new chat turn
    // only if the HUMAN conversation itself
    // has a parked confirmation (a held row with run_id === null). Appending a
    // user message onto a buffer that ends in an unanswered tool_use would wedge
    // it — the Anthropic API rejects any tool_use not immediately answered by a
    // tool_result, so every later turn would 400. A parked *commission* hold no
    // longer blocks chat: commissions run on their own throwaway buffer and
    // never touch this.conversationMessages, so the human turn is safe to
    // proceed. No LLM call, no message-array mutation.
    const outstandingHeld = this.firstUnresolvedHeldCallId((r) => r.run_id === null);
    if (outstandingHeld) {
      return {
        response:
          "A tool call is awaiting your confirmation. Please resolve the pending request before sending another message.",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        iterations: 0,
        held: { heldCallId: outstandingHeld },
      };
    }

    // Repair an orphaned trailing tool_use: a held-call sweep (quit, kill,
    // timeout reap, superseded reap) resolves the parked call's AUDIT side but
    // cannot reach this in-memory buffer, which still ends with the
    // assistant's unanswered tool_use — a shape the API rejects on every later
    // turn (the exact wedge the guard above exists to prevent). The guard just
    // proved no live held call remains, so a trailing tool_use can only be
    // that orphan.
    this.repairOrphanedToolUse(healedDispatches);

    // Lazily establish / attach the active session: a
    // direct /api/chat call with no prior startSession still gets a session,
    // and `status` reflects it. The DO owns the id — the boundary no longer
    // chooses it — so a "for this session" grant approved on one turn persists
    // to the next. Each executeTool re-derives the same active session (the
    // idempotent attach), so no id is threaded through the loop.
    // reap → held-guard → establish order preserved.
    this.resolveActiveSession({ userId, agentId });

    // Surface the full tool catalog each turn, tagged by connection status.
    // connected_services is strongly-consistent DO SQLite, so the tags reflect
    // live connections; buildToolDefinitions lists connected tools first. The
    // control-plane tools are offered only on the trusted `internal` surface.
    // That is the OFFER half of the boundary, and it is not the boundary on its
    // own — the dispatch gate below is the other half. Governance is the
    // backstop under both, never a substitute for either.
    const connectedServices = this.listConnectedServices().map((s) => s.service);
    const tools = buildToolDefinitions(connectedServices, {
      allowControlPlane: controlPlaneAllowed(origin),
    });

    const llmConfig = this.getLLMConfig();
    return runConversationLoop({
      userMessage: message,
      client: this.getLLMClient(),
      model: llmConfig.model,
      maxTokens: llmConfig.maxTokens,
      tools,
      system: HABENULA_SYSTEM_PROMPT,
      // The same origin gates the offer above and the dispatch below, so a name
      // the model emits without being offered it is refused rather than parked.
      executeTool: (toolName, toolParams) =>
        this.executeToolForLoop({
          toolName,
          toolParams,
          userId,
          agentId,
          runOrigin: origin,
        }),
      messages: this.conversationMessages,
      // Record the run's trust surface on the held turn so resume re-derives
      // the control-plane flag rather than defaulting it.
      persistHeldTurn: (heldCallId, state) => {
        this.storeHeldTurnState(heldCallId, wrapTurnState({ ...state, origin }));
      },
    });
      },
    );
  }

  /**
   * Adapt executeTool to the conversation loop's ExecuteToolFn shape,
   * translating a `pending` governance decision into the loop's held signal.
   */
  private async executeToolForLoop(params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    userId: string;
    agentId: string;
    origin?: AuditOrigin;
    /**
     * The run's trust surface, carried to the dispatch gate. Every loop call
     * site states it: the axis is not derivable from `origin`, because `human`
     * covers both the locality-gated `/api/chat` path and the token-gated
     * internal drive surface.
     */
    runOrigin?: RunOrigin;
    runId?: string | null;
  }): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    denied?: boolean;
    notConnected?: boolean;
    needsAuthorization?: boolean;
    boundaryRefused?: boolean;
    held?: boolean;
    heldCallId?: string;
    pendingAuditEntryId?: string;
  }> {
    // Verbatim data binding: a whole-value
    // {{data.<key>}} parameter is substituted BEFORE registry lookup, noun
    // extraction, governance, and audit — the literal never transits the
    // model, and everything downstream evaluates the real value. Commission
    // turns and run-linked resumes substitute; a chat turn (no runId) never.
    if (params.runId) {
      params = {
        ...params,
        toolParams: this.substituteRunData(params.runId, params.toolParams),
      };
    }
    const result = await this.executeTool(params);
    if (result.governance.decision === "pending" && result.held) {
      return {
        success: false,
        held: true,
        heldCallId: result.held.heldCallId,
        pendingAuditEntryId: result.held.pendingAuditEntryId,
      };
    }
    const denied = result.governance.decision === "deny";
    return {
      success: result.execution?.success ?? false,
      data: result.execution?.data,
      error: result.execution?.error,
      denied,
      notConnected: denied && result.denyReason === "not_connected",
      needsAuthorization: denied && result.denyReason === "needs_authorization",
      boundaryRefused: denied && result.boundaryRefused === true,
    };
  }

  /**
   * Run a commissioned goal as a normal governed turn.
   * Admission order: turn gate → reap →
   * held-slot guard → one-unresolved-commission cap → orphan repair → derive
   * session (tagged mcp_commission on create) → create run → loop. Blocks
   * until first hold or completion; the client polls habenula_result.
   */
  async commissionGoal(params: {
    goal: string;
    data?: Record<string, string>;
    userId: string;
    agentId: string;
  }): Promise<CommissionOutcome> {
    // Fail-closed key validation at the DO itself (0028B review F4): the MCP
    // boundary rejects unpublished keys gracefully first, but the label lines
    // composeCommissionMessage renders interpolate these keys as plain prose,
    // so the DO must never trust the boundary alone. A violation here is a
    // programmer error on a future caller, not a client flow — throw.
    if (params.goal.length === 0 || params.goal.length > COMMISSION_GOAL_MAX_CHARS) {
      throw new Error(
        `commissionGoal: goal length out of bounds (1..${COMMISSION_GOAL_MAX_CHARS})`,
      );
    }
    if (params.data) {
      const published = publishedDataSlots();
      const unknown = Object.keys(params.data).filter((k) => !published.has(k));
      if (unknown.length > 0) {
        throw new Error(
          `commissionGoal: unpublished data keys: ${unknown.join(", ")}`,
        );
      }
      const total = Object.values(params.data).reduce((n, v) => n + v.length, 0);
      if (total > COMMISSION_DATA_MAX_CHARS) {
        throw new Error(
          `commissionGoal: data values exceed ${COMMISSION_DATA_MAX_CHARS} characters`,
        );
      }
    }
    return this.withTurnGate<CommissionOutcome>(
      () => ({ status: "busy", reason: "turn_in_flight" }),
      async () => {
        this.reapExpiredSessions();
        // Bounded-queue admission, replacing the earlier
        // one-unresolved-commission cap and its held_call_pending guard: a
        // parked hold no longer blocks a new commission, and several pending
        // commissions may wait — up to MAX_PENDING_COMMISSIONS.
        //
        // The crash-orphan reconciliation is PRESERVED and runs as part of the
        // cap count, not replaced by a raw count(*). The reap just expired any
        // run whose session passed its cap. A `running` row found HERE is
        // necessarily crash-orphaned — turn-in-flight still serializes, so no
        // commission is actually mid-turn while we hold the marker: with a
        // surviving run-linked hold its TRUE state is awaiting_confirmation,
        // hold-less it failed. An awaiting run whose session ENDED without its
        // sweep (a lost kill TX2) is expired — the read-time belt applies at
        // the cap too, so a stranded or truly-failed run never consumes a slot.
        // Only `mcp_commission` runs count toward the cap; `human` is never
        // capped.
        const nonTerminal = commissionRunsData.selectNonTerminalRuns(this.sqlTag);
        const now = new Date().toISOString();
        let pendingCount = 0;
        for (const r of nonTerminal) {
          if (r.status === "running") {
            const liveHold = heldToolCallsData.selectHeldCallForRun(this.sqlTag, r.id);
            commissionRunsData.updateCommissionStatus(
              this.sqlTag,
              r.id,
              liveHold ? "awaiting_confirmation" : "failed",
              now,
            );
            if (liveHold && r.origin === "mcp_commission") pendingCount++;
            continue;
          }
          if (
            sessionStateData.readSessionEndedAt(this.sqlTag, r.session_id) !== null
          ) {
            // Ended-session belt: expire the stranded run so it never consumes a
            // cap slot. `expireRun` (not `updateCommissionStatus`) so a
            // `needs_input` run — now in this non-terminal set — is reached too.
            commissionRunsData.expireRun(this.sqlTag, r.id, now);
          } else if (r.origin === "mcp_commission") {
            pendingCount++;
          }
        }
        if (pendingCount >= MAX_PENDING_COMMISSIONS) {
          return { status: "busy", reason: "commission_pending" };
        }
        // No repairOrphanedToolUse() here: under per-task isolation a fresh
        // commission runs on its own throwaway buffer (below) and cannot inherit
        // an orphaned tool_use from another task's swept hold. The human buffer's
        // orphan repair stays in chat().
        const sessionId = this.resolveActiveSession({
          userId: params.userId,
          agentId: params.agentId,
          origin: "mcp_commission",
        });
        const runId = crypto.randomUUID();
        commissionRunsData.insertCommissionRun(this.sqlTag, {
          id: runId,
          goal: params.goal,
          data: params.data ? JSON.stringify(params.data) : null,
          sessionId,
          createdAt: new Date().toISOString(),
        });

        const connectedServices = this.listConnectedServices().map(
          (s) => s.service,
        );
        // Trust boundary: a commission-originated run is
        // the external inbound surface and is NEVER offered the control-plane
        // tools — its loop cannot even see `kill`/`disconnect`/`status`. That is
        // the OFFER half; the `runOrigin: "commission"` below carries the same
        // rule to the DISPATCH half, which refuses a control-plane name the
        // model emits anyway. Governance is the backstop under both.
        const tools = buildToolDefinitions(connectedServices, {
          allowControlPlane: controlPlaneAllowed("commission"),
        });
        // Per-task context: a commission runs on its own
        // buffer, never the shared human buffer (this.conversationMessages), so
        // a fresh commission turn can never append onto or inherit another
        // task's conversation. The buffer's durable form is the per-hold
        // turn_state snapshot: on park the loop persists it (persistHeldTurn ->
        // storeHeldTurnState), and resumeHeldTurn rebuilds it from turn_state —
        // so this in-memory array is only ever the live turn's scratch.
        const commissionMessages: LLMMessage[] = [];
        try {
          // Inside the try: a misconfigured LLM env (readLLMConfig throws)
          // must resolve the already-inserted run as `failed`, not escape as
          // a 500 that leaves the row stuck `running`.
          const llmConfig = this.getLLMConfig();
          const result = await runConversationLoop({
            userMessage: composeCommissionMessage(params.goal, params.data),
            client: this.getLLMClient(),
            model: llmConfig.model,
            maxTokens: llmConfig.maxTokens,
            tools,
            system: `${HABENULA_SYSTEM_PROMPT}\n\n${COMMISSION_ORIGIN_NOTICE}`,
            executeTool: (toolName, toolParams) =>
              this.executeToolForLoop({
                toolName,
                toolParams,
                userId: params.userId,
                agentId: params.agentId,
                origin: "mcp_commission",
                runOrigin: "commission",
                runId,
              }),
            messages: commissionMessages,
            persistHeldTurn: (heldCallId, state) => {
              this.storeHeldTurnState(
                heldCallId,
                wrapTurnState({ ...state, origin: "commission" }),
              );
            },
          });
          const now = new Date().toISOString();
          if (result.held) {
            commissionRunsData.updateCommissionStatus(
              this.sqlTag,
              runId,
              "awaiting_confirmation",
              now,
            );
            return this.commissionOutcomeFor(runId);
          }
          commissionRunsData.updateCommissionStatus(
            this.sqlTag,
            runId,
            commissionTerminalStatus(result.toolCalls),
            now,
          );
          return this.commissionOutcomeFor(runId);
        } catch {
          // A thrown FRESH commission turn is terminal `failed` (the pinned
          // mapping); the loop already rolled the buffer back. Report rather
          // than rethrow: the client's answer is the run status.
          commissionRunsData.updateCommissionStatus(
            this.sqlTag,
            runId,
            "failed",
            new Date().toISOString(),
          );
          return this.commissionOutcomeFor(runId);
        }
      },
    );
  }

  /**
   * The run's actual stored status after a guarded write. The write may have
   * been absorbed by a terminal that landed mid-turn (quit/kill/read-time
   * expiry); the client's answer is the run status, so
   * report the row, never the intent.
   */
  private commissionOutcomeFor(runId: string): {
    runId: string;
    status: Exclude<commissionRunsData.CommissionRunStatus, "running">;
  } {
    const row = commissionRunsData.readCommissionRun(this.sqlTag, runId)!;
    return {
      runId,
      status: row.status as Exclude<
        commissionRunsData.CommissionRunStatus,
        "running"
      >,
    };
  }

  /**
   * The status read behind `habenula_result`. Read-time expiry is the
   * load-bearing guard: the reap first writes `expired`
   * for any capped session's runs, and the ended-session belt below covers a
   * missed best-effort sweep (kill TX2), so a run can never report
   * awaiting_confirmation against a dead session forever. Run metadata only —
   * never tool output, credentials, or conversation content.
   */
  readCommissionRun(runId: string): CommissionRunView | null {
    this.reapExpiredSessions();
    let run = commissionRunsData.readCommissionRun(this.sqlTag, runId);
    if (!run) return null;
    // Crash repair: a `running` run with no turn in flight can only mean the
    // isolate died mid-turn — a live commission turn holds the marker at every
    // point this read can execute (single-threaded between awaits). Repair to
    // `failed`, the crash counterpart of commissionGoal's catch.
    // (While an unrelated turn holds the marker, an orphaned run transiently
    // reports `running`; it self-corrects on the next idle read.) If the
    // crash landed between the held-park and the awaiting write, the run's
    // TRUE state is awaiting — a live run-linked hold is still resolvable,
    // so repairing it to `failed` would lie while the side effect can still
    // fire. Only a hold-less orphan is genuinely failed.
    if (run.status === "running" && !this.turnInFlight) {
      const liveHold = heldToolCallsData.selectHeldCallForRun(this.sqlTag, runId);
      commissionRunsData.updateCommissionStatus(
        this.sqlTag,
        runId,
        liveHold ? "awaiting_confirmation" : "failed",
        new Date().toISOString(),
      );
      run = commissionRunsData.readCommissionRun(this.sqlTag, runId)!;
    }
    if (
      run.status === "running" ||
      run.status === "awaiting_confirmation" ||
      run.status === "needs_input"
    ) {
      const endedAt = sessionStateData.readSessionEndedAt(
        this.sqlTag,
        run.session_id,
      );
      if (endedAt !== null) {
        // `expireRun` (not `updateCommissionStatus`) so a `needs_input` run,
        // whose absorbing guard `updateCommissionStatus` excludes, is expired
        // too when its session ended without its sweep (lost kill TX2).
        commissionRunsData.expireRun(
          this.sqlTag,
          runId,
          new Date().toISOString(),
        );
        run = commissionRunsData.readCommissionRun(this.sqlTag, runId)!;
      }
    }
    return {
      runId: run.id,
      status: run.status as CommissionRunView["status"],
      statusDetail: parseStatusDetail(run.status_detail),
      awaitedSlotKeys: parseAwaitedSlotKeys(run.awaited_slot_keys),
    };
  }

  /**
   * One task's full record behind `GET /api/tasks/get`.
   * The task summary plus the per-action breakdown and, for a `needs_input`
   * task, the published slot key(s) it awaits. Read-time expiry runs first (via
   * `readCommissionRun`'s reap) so a listed status is never stale. Returns null
   * for an unknown id. Metadata only — the closed surface holds.
   */
  readTaskDetail(taskId: string): TaskDetailResponse | null {
    // Route through readCommissionRun so the same read-time expiry / crash
    // repair applies, then re-read the row for the summary fields.
    const view = this.readCommissionRun(taskId);
    if (!view) return null;
    const row = commissionRunsData.readCommissionRun(this.sqlTag, taskId);
    if (!row) return null;
    return {
      task: taskSummaryFromRow({ ...row, status: view.status }),
      statusDetail: view.statusDetail,
      awaitedSlotKeys: view.awaitedSlotKeys,
    };
  }

  /**
   * Every task the user's DO holds, newest first, behind `GET /api/tasks`
   * — cross-origin by construction (no origin filter):
   * `mcp_commission` tasks today, and forward-compatible with `human`-origin
   * tasks once a phase creates them. Reaps expired sessions first so a listed
   * status reflects the stored truth, not a stale awaiting.
   *
   * Bounded and paged: `limit` is clamped and the page carries a
   * `nextCursor` keyset token (null on the last page), so a DO holding a long
   * history never returns an unbounded payload. Rows are never pruned — the
   * bound is on the view, not retention (the record stays the forensic surface).
   * Fetches one extra row to decide whether a further page
   * exists without a second count query.
   */
  listTasks(params?: { limit?: number; cursor?: string | null }): TasksListResponse {
    this.reapExpiredSessions();
    const limit = clampTaskListLimit(params?.limit);
    const before = decodeTaskCursor(params?.cursor);
    const rows = commissionRunsData.listTasks(this.sqlTag, {
      limit: limit + 1,
      before,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeTaskCursor(last.created_at, last.id) : null;
    return { tasks: page.map((row) => taskSummaryFromRow(row)), nextCursor };
  }

  /**
   * One page of the audit chain, newest first, behind `GET /api/audit`.
   * Rows go out verbatim — every hashed column plus
   * `hash` and `epochPrevHash`, snake to camel with no projection — so a
   * client can recompute every hash on a surface the engine does not control.
   * The engine returns rows, never a verdict.
   *
   * Follows `listTasks`'s paging shape: clamp, fetch `limit + 1` rows to
   * decide `hasMore` without a count query, keyset `nextCursor`. It does NOT
   * call `reapExpiredSessions()` — that is a write, and this route is
   * read-only.
   */
  listAuditEntries(params?: { limit?: number; cursor?: string | null }): AuditListResponse {
    const limit = clampAuditPageLimit(params?.limit);
    const before = decodeAuditCursor(params?.cursor);
    const rows = auditLogData.selectAuditChainPage(this.sqlTag, {
      limit: limit + 1,
      before,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeAuditCursor(last.epoch_id, last.sequence_num) : null;
    return { entries: page.map((row) => auditChainEntryFromRow(row)), nextCursor };
  }

  /**
   * Append one governed action's outcome to a task's per-action status detail
   * — called at each terminal audit-outcome site with the
   * governance tuple already derived, so the detail carries the real noun (the
   * run-cumulative `toolCalls` record carries only the tool name). A no-op for a
   * non-commission action (`runId === null` — a human turn keeps no task record)
   * or an unreadable run. Metadata only: `(service, verb, noun, outcome)`, never
   * the action's return payload — the closed surface holds.
   */
  private appendActionDetail(
    runId: string | null | undefined,
    detail: TaskActionDetail,
  ): void {
    if (!runId) return;
    const row = commissionRunsData.readCommissionRun(this.sqlTag, runId);
    if (!row) return;
    const existing = parseStatusDetail(row.status_detail) ?? [];
    existing.push(detail);
    commissionRunsData.updateTaskStatusDetail(
      this.sqlTag,
      runId,
      JSON.stringify(existing),
      new Date().toISOString(),
    );
  }

  /**
   * Fail-closed validation of a commission `data` map,
   * reused by `habenula_provide`: only published slot keys
   * (the closed vocabulary), total within the data cap. The untrusted MCP
   * boundary rejects a violation gracefully first, so a violation reaching the DO
   * is a programmer error on a future caller — throw, never silently accept.
   */
  private assertPublishedData(
    data: Record<string, string>,
    caller = "provideTaskInput",
  ): void {
    const published = publishedDataSlots();
    const unknown = Object.keys(data).filter((k) => !published.has(k));
    if (unknown.length > 0) {
      throw new Error(`${caller}: unpublished data keys: ${unknown.join(", ")}`);
    }
    const total = Object.values(data).reduce((n, v) => n + v.length, 0);
    if (total > COMMISSION_DATA_MAX_CHARS) {
      throw new Error(
        `${caller}: data values exceed ${COMMISSION_DATA_MAX_CHARS} characters`,
      );
    }
  }

  /**
   * Answer a `needs_input` task and resume it. Binds the
   * client's supplied values into the run's `data` map — same slot vocabulary,
   * size cap, and verbatim `{{data.<key>}}` binding as the original commission,
   * so client values never round-trip through the model — then re-attempts the
   * parked call through the full governance pipeline. The value now binds, so the
   * call dispatches, is denied, or — bind ≠ grant — routes to confirmation.
   * Input-only and own-task-scoped: it cannot approve, deny, or reach a
   * tool, preserving the closed surface.
   */
  async provideTaskInput(params: {
    taskId: string;
    data: Record<string, string>;
    userId: string;
    agentId?: string;
  }): Promise<ProvideTaskInputResult> {
    this.assertPublishedData(params.data);

    // Reap first: a provide arriving after the 90-minute
    // session lapse — the expected shape when a client asks its human for the
    // value and comes back later — must see the expired run and refuse, not
    // resurrect a dead task (mutate it, mint a fresh session as a side effect,
    // and leave an approvable confirmation hold on an expired run). This mirrors
    // the read-time expiry belt readCommissionRun opens with.
    this.reapExpiredSessions();

    const run = commissionRunsData.readCommissionRun(this.sqlTag, params.taskId);
    if (!run) return { status: "not_found" };
    if (run.status !== "needs_input") {
      return { status: "not_awaiting_input", currentStatus: run.status };
    }
    // The supplied keys must intersect the slot(s) the task awaits.
    // Providing only published-but-unawaited keys would clear needs_input,
    // re-attempt, and re-park — an unbounded audit-log grind with no cycle cap.
    // Refuse deterministically here, before any mutation or audit write.
    const awaitedKeys = parseAwaitedSlotKeys(run.awaited_slot_keys) ?? [];
    const providedKeys = Object.keys(params.data);
    if (awaitedKeys.length > 0 && !providedKeys.some((k) => awaitedKeys.includes(k))) {
      return { status: "no_matching_slot", awaitedSlotKeys: awaitedKeys };
    }
    // Cap the MERGED data map, not only the incoming one: repeated
    // provides could otherwise grow run.data toward (published-key count × cap).
    const existingData = run.data
      ? (JSON.parse(run.data) as Record<string, string>)
      : {};
    const mergedData = { ...existingData, ...params.data };
    const mergedSize = Object.values(mergedData).reduce((n, v) => n + v.length, 0);
    if (mergedSize > COMMISSION_DATA_MAX_CHARS) {
      throw new Error(
        `provideTaskInput: merged data values exceed ${COMMISSION_DATA_MAX_CHARS} characters`,
      );
    }
    const hold = heldToolCallsData.selectInputHoldForTask(this.sqlTag, params.taskId);
    if (!hold) return { status: "not_found" };
    // turn_state rides the canonical envelope: parse it rather
    // than raw JSON so a legacy/newer-version blob degrades to a safe refusal
    // instead of a mis-parse.
    const parsed = parseTurnState(hold.turn_state);
    if (!parsed.ok || !parsed.state.heldCall) return { status: "not_found" };
    const turnState = parsed.state;

    return this.withTurnGate<ProvideTaskInputResult>(
      () => ({ status: "busy" }),
      async () => {
        const agentId = params.agentId ?? "default";
        const now = new Date().toISOString();
        // Bind the supplied values into the run's data map and leave needs_input,
        // so the ordinary terminal / awaiting writes apply once the call settles.
        // (mergedData was validated for size before the gate.)
        commissionRunsData.updateRunData(
          this.sqlTag,
          params.taskId,
          JSON.stringify(mergedData),
          now,
        );
        commissionRunsData.clearNeedsInput(this.sqlTag, params.taskId, now);

        const heldCall = turnState.heldCall;
        // Crash marker: mark the input hold `dispatched`
        // BEFORE the re-attempt's side effect, so a crash between dispatch and
        // the resume round-trip never re-dispatches the tool on a later resolve.
        // In the re-park / confirmation (held) branch this row is deleted and
        // the marker is moot; in the executed/denied branch the `answered`
        // payload below supersedes it.
        this.storeHeldTurnState(
          hold.id,
          wrapTurnState({ ...turnState, dispatched: true }),
        );
        // Re-attempt the parked call through the full pipeline. Substitution now
        // finds the value; governance may allow (dispatch), deny, or pend.
        const result = await this.executeToolForLoop({
          toolName: heldCall.name,
          toolParams: heldCall.input,
          userId: params.userId,
          agentId,
          origin: "mcp_commission",
          // An input hold belongs to a commission run by construction (only a
          // run-linked call parks one), so the re-attempt runs on the external
          // surface and the control plane stays out of reach.
          runOrigin: "commission",
          runId: params.taskId,
        });

        // Close the input park's pending audit entry: the re-attempt
        // above wrote its own governed pair, and the input hold is consumed
        // below on either branch, so this is the terminal that pairs the park's
        // `pending` — without it that entry dangles forever.
        this.closeInputParkAudit(hold.pending_audit_entry_id, now);

        if (result.held) {
          // The re-attempt parked again — either a confirmation hold (bind ≠
          // grant) or, if a required slot is still unbound, a fresh input
          // hold. executeToolForLoop ran outside the conversation loop, so the
          // new hold carries only a seed; graft the parked conversation onto it
          // (its row id is the handle a resolver targets; the tool_use id inside
          // stays the conversation's), then drop the stale input hold. Mark the
          // task awaiting only when it is NOT a re-parked input hold.
          const grafted: HeldTurnState = {
            ...turnState,
            dispatched: undefined,
            answered: undefined,
            directExecute: undefined,
          };
          this.storeHeldTurnState(result.heldCallId!, wrapTurnState(grafted));
          heldToolCallsData.deleteHeldToolCall(this.sqlTag, hold.id);
          const reRead = commissionRunsData.readCommissionRun(
            this.sqlTag,
            params.taskId,
          )!;
          if (reRead.status !== "needs_input") {
            commissionRunsData.updateCommissionStatus(
              this.sqlTag,
              params.taskId,
              "awaiting_confirmation",
              now,
            );
          }
        } else {
          // Executed or denied: feed the result back into the conversation and
          // let it run to its terminal, reusing the confirmation resume
          // machinery. The action already dispatched/denied in
          // executeToolForLoop (audit + per-action detail recorded there);
          // resume does NOT re-dispatch.
          //
          // A boundary refusal reads as itself, never as a policy deny — the
          // same distinction the dispatch and resolve sites make. Reachable
          // only for an input hold parked on a control-plane tool by an engine
          // that predates the dispatch gate; the gate now refuses that call
          // before one can be parked.
          const resolvedResult: LLMToolResultBlock = {
            type: "tool_result",
            tool_use_id: heldCall.id,
            content: result.boundaryRefused
              ? CONTROL_PLANE_REFUSAL
              : result.denied
                ? "Denied by policy"
                : fenceUntrusted(
                    result.success
                      ? JSON.stringify(result.data ?? null)
                      : (result.error ?? "Tool execution failed"),
                  ),
            is_error: result.denied || !result.success,
          };
          // Boundary first: a refusal sets `denied` too, and the client record
          // must carry the distinction the model's tool_result above already
          // does.
          const resolvedOutcome: ToolCallOutcome = result.boundaryRefused
            ? "boundary_refused"
            : result.denied
              ? "denied"
              : result.success
                ? "success"
                : "error";
          // Unfenced copy of the same text for the client record. A
          // denial is engine prose the client renders from `outcome`, so only
          // the genuine execution failure carries one.
          const resolvedError =
            resolvedOutcome === "error"
              ? (result.error ?? "Tool execution failed")
              : undefined;
          // Persist the produced answer into the input hold BEFORE the resume
          // LLM round-trip: if resume throws, the row
          // survives carrying `answered`, so pendingHeldRecordFor skips it (it
          // is not a fresh confirmation) and a resolve funnels into the
          // idempotent answered branch instead of re-dispatching the tool.
          const answeredState: HeldTurnState = {
            ...turnState,
            answered: { resolvedResult, resolvedOutcome, resolvedError },
          };
          this.storeHeldTurnState(hold.id, wrapTurnState(answeredState));
          const resolution = await this.resumeAndFinalize({
            heldCallId: hold.id,
            turnState: answeredState,
            userId: params.userId,
            agentId,
            origin: "mcp_commission",
            runId: params.taskId,
            resolvedResult,
            resolvedOutcome,
            resolvedError,
          });
          this.recordRunAfterResolve(params.taskId, resolution);
        }

        const finalRun = commissionRunsData.readCommissionRun(
          this.sqlTag,
          params.taskId,
        )!;
        return { taskId: params.taskId, status: finalRun.status };
      },
    );
  }

  /**
   * Cancel a task. Cancel
   * authority is split by SURFACE, not origin: `surface: "human"` (the CLI/HTTP
   * user) is authoritative over EVERY task — it stops a runaway `mcp_commission`
   * task without falling back to `habenula kill`; `surface: "mcp"` is
   * own-task-scoped and refuses a cross-origin cancel (`forbidden`). A `running`
   * task holds the single live turn and is refused with `running` (retry once it
   * parks) — `habenula kill` is the escape hatch for a truly-stuck one. A
   * terminal task is `not_cancellable`. Cancelling a parked task closes its
   * hold's pending audit entry, sweeps the hold, and writes the terminal
   * `cancelled` status — all in one transaction so the hash chain and the
   * run/hold state are never observed mid-cancel (Hard Invariant 3). Cancel
   * ABANDONS the task: unlike resolve/provide it never resumes the conversation.
   */
  async cancelTask(params: {
    taskId: string;
    surface: "human" | "mcp";
    /** Recorded on the cancel's audit entry. NOT an authorization input — MCP
     * scoping is by the task's `origin` (see the class docstring above). */
    userId: string;
    agentId?: string;
  }): Promise<CancelTaskResult> {
    // The gate is entered BEFORE any authorization or status read, and every such
    // read happens inside it. `withTurnGate` refuses rather than waits, so the
    // pre-gate path used to be synchronous-by-accident; putting the checks inside
    // means they stay authoritative even if a future edit adds an `await` above.
    return this.withTurnGate<CancelTaskResult>(
      () => ({ status: "busy", taskId: params.taskId }),
      async () => {
        this.reapExpiredSessions();
        const row = commissionRunsData.readCommissionRun(this.sqlTag, params.taskId);
        if (!row) return { status: "not_found" };
        // Surface authority. `human` (CLI/HTTP) is authoritative over every
        // origin. `mcp` is scoped to `mcp_commission` tasks — origin-scoped, NOT
        // per-client (there is no inbound client identity), so this refuses a
        // cross-ORIGIN cancel, not another client's task. See the docstring.
        if (params.surface === "mcp" && row.origin !== "mcp_commission") {
          return { status: "forbidden" };
        }
        const status = row.status;
        // A running task holds the live turn. Inside the gate `turnInFlight` is
        // ours, so a stored `running` here is a crash orphan rather than a live
        // turn — `readCommissionRun`'s repair cannot run under our own gate, so
        // refuse conservatively with the specific status instead of cancelling a
        // row whose true state is still being determined.
        if (status === "running") return { status: "running", taskId: params.taskId };
        if (status !== "awaiting_confirmation" && status !== "needs_input") {
          return {
            status: "not_cancellable",
            taskId: params.taskId,
            currentStatus: status,
          };
        }
        const now = new Date().toISOString();
        // EVERY hold the run owns, not just the first: a crash inside
        // `provideTaskInput` can leave two rows on one run, and a survivor would
        // keep a dangling `pending` entry and stay independently resolvable.
        const holds = heldToolCallsData.selectHeldCallsForRun(this.sqlTag, params.taskId);
        // A hold that is mid-resolve (`dispatched`/`answered`) has already run or
        // decided its action; its terminal audit outcome belongs to the resolve
        // path, which owns the recovery. Cancelling it would write "cancelled,
        // never ran" over a call that DID run and delete the recovery marker, so
        // the hash chain would faithfully record a false disposition. Refuse the
        // whole cancel — the resolve path must finish first.
        if (holds.some((h) => this.turnStateHasResolution(h.turn_state))) {
          return { status: "resolving", taskId: params.taskId };
        }
        this.ctx.storage.transactionSync(() => {
          for (const h of holds) {
            // Close each parked hold's `pending` audit entry BEFORE the state
            // mutation (audit-before-execute, same txn): without it the entry
            // dangles unresolved after the hold row is swept.
            this.writeHeldCancelOutcome(h.pending_audit_entry_id, now, params.surface);
            heldToolCallsData.deleteHeldToolCall(this.sqlTag, h.id);
          }
          // Audit the cancel ITSELF, unconditionally — a hold-less cancel still
          // moves a task terminal, and "who cancelled task Y, from which
          // surface, when" must be a first-class row on the accountability
          // surface rather than smuggled into a held-call closer's message.
          // Same shape as `writeSessionEnd`'s lifecycle entry.
          this.writeTaskCancelAudit({
            userId: params.userId,
            agentId: params.agentId ?? "default",
            sessionId: row.session_id,
            taskId: params.taskId,
            surface: params.surface,
            timestamp: now,
          });
          commissionRunsData.cancelRun(this.sqlTag, params.taskId, now);
        });
        return { status: "cancelled", taskId: params.taskId, previousStatus: status };
      },
    );
  }

  /**
   * Amend a task's client-held `data`.
   * MCP-only and own-task-scoped: amend re-supplies a value only the
   * commissioning client has, so there is no HTTP route and no CLI command — a
   * human amends by chatting. It rides the SAME boundary validation (published
   * keys, size cap) and verbatim `{{data.<key>}}` binding as `provideTaskInput`
   * and the original commission, so client values never round-trip through the
   * model. Amend PERSISTS the corrected data; it does NOT resume — that is
   * `provide`'s job.
   *
   * **Amend is restricted to `needs_input`, the same state `provideTaskInput`
   * accepts, and deliberately REFUSES an `awaiting_confirmation` task.** That
   * narrows the rule that cancel and amend apply to parked tasks, and
   * the reason is the design's own property: the human approves the substituted
   * REAL value in view. A held call parks the model's raw `{{data.<key>}}` input
   * and `resolveConfirmation` substitutes the run's CURRENT `data` at resolve
   * time, so amending a task the user is already being prompted about would let an
   * untrusted client swap the recipient AFTER the user read the prompt and BEFORE
   * they approve — the approval, the derived noun, the minted grant, the audit
   * metadata, and the dispatch would all carry the swapped value. That is a
   * bait-and-switch on the confirmation surface, so the state is refused outright.
   * A client that must change a value on a task awaiting approval waits for the
   * user to deny it, or cancels and re-commissions.
   *
   * A `running` task refuses amend; any other state is `not_amendable`. The
   * persist runs under the turn gate so it never mutates data underneath a turn.
   */
  async amendTask(params: {
    taskId: string;
    data: Record<string, string>;
    /** Not an authorization input — scoping is by the task's `origin`. */
    userId: string;
    agentId?: string;
  }): Promise<AmendTaskResult> {
    this.assertPublishedData(params.data, "amendTask");
    // Gate first, then read: every authorization and status check below is inside
    // it, so none of them can be raced by a future `await` added above.
    return this.withTurnGate<AmendTaskResult>(
      () => ({ status: "busy", taskId: params.taskId }),
      async () => {
        this.reapExpiredSessions();
        const run = commissionRunsData.readCommissionRun(this.sqlTag, params.taskId);
        if (!run) return { status: "not_found" };
        // Origin-scoped (NOT per-client — there is no inbound client identity).
        if (run.origin !== "mcp_commission") return { status: "forbidden" };
        const status = run.status;
        if (status === "running") return { status: "running", taskId: params.taskId };
        // `needs_input` ONLY — see the docstring for why `awaiting_confirmation`
        // is refused rather than amended.
        if (status !== "needs_input") {
          return { status: "not_amendable", currentStatus: status };
        }
        // Merge + cap the FULL data map (not only the incoming keys), the same
        // discipline as provideTaskInput, so repeated amends cannot grow the map
        // past the cap.
        const existingData = run.data
          ? (JSON.parse(run.data) as Record<string, string>)
          : {};
        const mergedData = { ...existingData, ...params.data };
        const mergedSize = Object.values(mergedData).reduce((n, v) => n + v.length, 0);
        if (mergedSize > COMMISSION_DATA_MAX_CHARS) {
          throw new Error(
            `amendTask: merged data values exceed ${COMMISSION_DATA_MAX_CHARS} characters`,
          );
        }
        commissionRunsData.updateRunData(
          this.sqlTag,
          params.taskId,
          JSON.stringify(mergedData),
          new Date().toISOString(),
        );
        return { taskId: params.taskId, status };
      },
    );
  }

  /**
   * Substitute a run's verbatim data values into tool params ({{data.<key>}}
   * whole-value placeholders). Shared by the loop closure and the resolve
   * path — the RESOLVE path must substitute too: a held call parks the
   * model's RAW input, and noun derivation, grant minting, audit metadata,
   * and dispatch all read from it on resolve.
   */
  private substituteRunData(
    runId: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const run = commissionRunsData.readCommissionRun(this.sqlTag, runId);
    if (!run?.data) return params;
    return substituteDataPlaceholders(
      params,
      JSON.parse(run.data) as Record<string, string>,
    );
  }

  /**
   * Record a run's transition after a resolve completes:
   * a cascade re-hold moves back to awaiting_confirmation; a finished resume
   * writes the pinned terminal mapping over the run-cumulative outcomes. A
   * thrown resume never reaches here — the run stays awaiting_confirmation
   * and the retry applies. No-op for CLI-direct holds (runId null).
   */
  private recordRunAfterResolve(
    runId: string | null,
    resolution: ConfirmationResolution,
  ): void {
    if (!runId || resolution.status !== "resumed") return;
    const now = new Date().toISOString();
    if (resolution.result.held) {
      commissionRunsData.updateCommissionStatus(
        this.sqlTag,
        runId,
        "awaiting_confirmation",
        now,
      );
      return;
    }
    commissionRunsData.updateCommissionStatus(
      this.sqlTag,
      runId,
      commissionTerminalStatus(resolution.result.toolCalls),
      now,
    );
  }

  /**
   * Resolve a held call. The choices:
   *  - "deny": single-use, no grant. The held call resolves to a denied
   *    outcome; the LLM sees only the fixed minimal string.
   *  - "tell_more": returns the tool's registry metadata block. No mutation,
   *    no resume — the user stays in confirmation.
   *  - "task": a single-use grant, consumed the instant it authorizes its one
   *    call (consume-before-execute).
   *  - "session": a session-scoped grant valid until the session ends.
   *
   *  - "approve_once": a SPENDING hold's affirmative. It
   *    dispatches the one parked money-verb call and mints nothing — permission
   *    already passed, so there is no grant to make.
   *
   * A spending hold accepts only `deny`, `tell_more`, and `approve_once`; an
   * ordinary hold rejects `approve_once`. A choice that does not apply to the
   * hold's kind returns `invalid_choice`, which the route maps to a 400.
   *
   * On a grant choice the parked call is re-evaluated and the turn re-invokes
   * the LLM. Resolution binds to `heldCallId`; a stale/wrong id is rejected.
   */
  async resolveConfirmation(params: {
    heldCallId: string;
    choice: "deny" | "tell_more" | "task" | "session" | "approve_once";
    userId: string;
    agentId?: string;
  }): Promise<ConfirmationResolution> {
    const held = this.loadHeldCall(params.heldCallId);
    if (!held) {
      // Resolution binding: a non-matching/stale/expired held-call id is
      // rejected — never executes anything.
      return { status: "not_found" };
    }

    const agentId = params.agentId ?? "default";
    // Defend against a malformed/empty turn_state (a held row whose conversation
    // loop never populated it — the insert default is '' — or a legacy/corrupt
    // row). Degrade to the same not_found path as a stale/missing id rather than
    // throwing an unhandled SyntaxError. Mirrors turnStateIsAnswered's guard.
    const parsed = parseTurnState(held.turnState);
    if (!parsed.ok && parsed.reason === "future_version") {
      // tell_more keeps its no-mutation contract even on an unreadable hold:
      // a client probing with the read-only choice must not destroy it.
      if (params.choice === "tell_more") {
        return { status: "not_found" };
      }
      // Fail-safe: the envelope was stamped by NEWER code —
      // e.g. a rollback landed while this hold was parked. The state cannot be
      // parsed without risking mis-execution, so the hold is unresumable:
      // close its pending audit entry with a terminal deny and delete the row.
      // The tool identity lives inside the unreadable state, hence "unknown"
      // (the same fallback a registry miss uses).
      this.ctx.storage.transactionSync(() =>
        this.closeDecisionEntryInTxn(
          {
            userId: params.userId,
            agentId,
            sessionId: held.sessionId,
            toolName: "unknown",
            service: "unknown",
            verb: "execute",
            noun: "unknown",
            decision: "deny",
            origin: held.runId ? "mcp_commission" : "human",
            parametersMetadata: extractMetadata({}),
            outcome: "error",
            errorMessage:
              "Held call unresumable: turn_state was written by a newer engine version",
            decisionEntryId: held.pendingAuditEntryId,
            latencyMs: 0,
          },
          "observed",
        ),
      );
      this.deleteHeldCall(params.heldCallId);
      // A run-linked hold must also resolve its commission run — every other
      // resolve path routes through recordRunAfterResolve; without this the
      // run sits `awaiting_confirmation` against a hold that no longer exists
      // until the session reap expires it.
      if (held.runId) {
        commissionRunsData.updateCommissionStatus(
          this.sqlTag,
          held.runId,
          "denied",
          new Date().toISOString(),
        );
      }
      return { status: "not_found" };
    }
    if (!parsed.ok || !parsed.state.heldCall) {
      return { status: "not_found" };
    }
    const turnState = parsed.state;
    // Gate opens HERE — immediately after loadHeldCall and the parse guards,
    // NOT after the tell_more early-return: the answered/dispatched branches
    // below re-run the loop, and a concurrent second resolve enters through
    // the answered branch while a resume is in flight.
    // A tell_more mid-resolve is refused busy too — on an answered row it is
    // itself a resume, not a read.
    return this.withTurnGate<ConfirmationResolution>(
      () => ({ status: "busy" }),
      async () => {
    const heldCall = turnState.heldCall;
    // Provenance follows the held call's run link: a run-linked hold is a
    // commissioned action, and every entry that closes it says so.
    const actionOrigin: AuditOrigin = held.runId ? "mcp_commission" : "human";
    // A held call parks the model's RAW input; a run-linked hold substitutes
    // the run's verbatim data values here, so the noun, the minted grant, the
    // audit metadata, and the dispatch all see the real value — the same
    // pre-governance binding the loop closure applies.
    const heldInput = held.runId
      ? this.substituteRunData(held.runId, heldCall.input)
      : heldCall.input;
    const registry = lookupTool(heldCall.name);
    const service = registry?.service ?? "unknown";
    const verb = registry?.verb ?? "execute";
    const noun = registry ? registry.nounExtractor(heldInput) : "unknown";
    // The dispatch gate again, at the resolve site. `executeTool` refuses a
    // control-plane call from an untrusted surface before it can ever park, so
    // no hold this engine creates reaches here — but a hold parked by an engine
    // that predates the gate outlives the deploy that fixes it, and answering
    // one would execute the action the gate exists to refuse. The refusal is
    // routed through the deny branch below: nothing dispatches, and an
    // affirmative answer mints no grant.
    const boundaryRefused =
      isControlPlaneTool(heldCall.name) &&
      !controlPlaneAllowed(this.heldRunOrigin(turnState, held.runId));

    // Hold-kind choice restriction, enforced BEFORE
    // the crash-recovery branches below — those resume a call and must not be
    // a way around the restriction (a `session` answer on a dispatched
    // spending hold would otherwise mint a ceiling, and `approve_once` on a
    // dispatched ordinary hold would be accepted).
    //
    // A spending hold refuses `task`/`session`: a session-scoped answer would
    // silently raise the ceiling for ninety minutes, and permission already
    // passed so there is no grant to mint. `tell_more` IS allowed — it returns
    // registry metadata, mints nothing, mutates nothing, and leaves the call
    // parked, so the spec's stated reason for the restriction does not reach
    // it; refusing it would make the one prompt that moves money the only one
    // where the user cannot ask what the tool does. `approve_once` is refused
    // symmetrically on an ordinary hold. Enforced engine-side, so no client
    // can mint a ceiling regardless of what its UI renders.
    //
    // `undefined` = no context (ordinary hold); `null` = a context that will
    // not validate, which stays a SPENDING hold (fail closed) rather than
    // decaying into a grant-mintable one.
    const spendCtx = parseSpendContext(held.spendContext);
    const isSpendHold = spendCtx !== undefined;
    if (isSpendHold && (params.choice === "task" || params.choice === "session")) {
      return {
        status: "invalid_choice",
        reason: "a spending hold accepts only deny, tell_more, or approve_once",
      };
    }
    if (!isSpendHold && params.choice === "approve_once") {
      return {
        status: "invalid_choice",
        reason: "approve_once applies only to a spending hold",
      };
    }

    // Idempotent retry: if a previous resolve already
    // dispatched/denied this call but the resume LLM round-trip threw, the held
    // row survives carrying the produced answer. Resume from it directly — do
    // NOT mint another grant or re-dispatch the tool. This makes a resume
    // failure recoverable and a double-resolve safe.
    if (turnState.answered) {
      const retried = await this.resumeAndFinalize({
        heldCallId: params.heldCallId,
        turnState,
        userId: params.userId,
        agentId,
        origin: actionOrigin,
        runId: held.runId,
        resolvedResult: turnState.answered.resolvedResult,
        resolvedOutcome: turnState.answered.resolvedOutcome,
        resolvedError: turnState.answered.resolvedError,
      });
      this.recordRunAfterResolve(held.runId, retried);
      return retried;
    }

    // Crash-after-dispatch recovery: the tool was
    // dispatched on a prior resolve but the engine crashed before persisting
    // `answered`. The grant is committed and the side-effecting call already
    // ran — do NOT re-dispatch (a second send/delete would double-execute).
    // Resume with a generic completed result; the real result was lost with
    // the crash, but the tool's effect is not repeated.
    if (turnState.dispatched) {
      // The tool_result fed to a resumed LLM stays non-error so the model
      // treats the turn as complete and does not re-trigger a side-effecting
      // call. The recorded OUTCOME, however, tracks the audit entry below
      // (`error` — outcome unknown), not that steering result: the outcome
      // label is the observable record (wire toolCalls, commission terminal
      // status), and it must never claim success the audit log denies. This
      // matters most for a directExecute hold, where the synthesized outcome is
      // the only signal the caller gets.
      const recoveredResult: LLMToolResultBlock = {
        type: "tool_result",
        tool_use_id: heldCall.id,
        content: DISPATCH_RECOVERY_RESULT,
        is_error: false,
      };
      const recoveredState: HeldTurnState = {
        ...turnState,
        answered: {
          resolvedResult: recoveredResult,
          resolvedOutcome: "error",
          // The client's reason for this `error` is the same string the audit
          // entry below records, so the wire and the log tell one story.
          // The LLM keeps the non-error steering result above; only the
          // observable outcome says the result was lost.
          resolvedError: DISPATCH_RECOVERY_ERROR,
        },
      };
      // One transaction, two writes that must never be observed apart:
      //
      //  1. Close the audit pair the crash left open — the `pending` decision
      //     entry has no terminal outcome, because the post-dispatch outcome
      //     write never ran.
      //  2. Persist `answered`, exactly as the grant/deny path does before its
      //     own resume. Without it a thrown resume below left the row carrying
      //     only `dispatched`, the guard forced a retry, and the retry re-entered
      //     THIS branch — appending a second terminal outcome against the one
      //     decision entry. `idx_decision_entry` is not UNIQUE, so that landed
      //     silently as two contradictory closes of one decision.
      //
      // Persisted together, a retry after a thrown resume takes the `answered`
      // branch above and writes no audit at all.
      this.ctx.storage.transactionSync(() => {
        this.closeDecisionEntryInTxn(
          this.dispatchRecoveryAuditParams({
            toolName: heldCall.name,
            input: heldInput,
            userId: params.userId,
            agentId,
            sessionId: held.sessionId,
            pendingAuditEntryId: held.pendingAuditEntryId,
            origin: actionOrigin,
          }),
          "observed",
        );
        heldToolCallsData.updateHeldTurnState(
          this.sqlTag,
          params.heldCallId,
          wrapTurnState(recoveredState),
        );
      });
      const recovered = await this.resumeAndFinalize({
        heldCallId: params.heldCallId,
        turnState: recoveredState,
        userId: params.userId,
        agentId,
        origin: actionOrigin,
        runId: held.runId,
        resolvedResult: recoveredResult,
        resolvedOutcome: "error",
        resolvedError: DISPATCH_RECOVERY_ERROR,
      });
      this.recordRunAfterResolve(held.runId, recovered);
      return recovered;
    }


    // "Tell me more": registry-authored metadata only. service/verb/
    // description come from the Habenula tool registry. The noun is derived by
    // the registry's nounExtractor but its input is LLM-controlled (e.g. a
    // mailbox label), so it is sanitized to labeled, escaped data — never
    // rendered as prose — so a prompt-injected agent cannot author the approval
    // surface. No mutation, the held call stays parked.
    if (params.choice === "tell_more") {
      return {
        status: "info",
        metadata: {
          service,
          verb,
          noun: sanitizeNoun(noun),
          description: registry?.description ?? "No description available.",
        },
      };
    }

    let resolvedResult: LLMToolResultBlock;
    let resolvedOutcome: ToolCallOutcome;
    // Unfenced failure text for the client record. Stays undefined on
    // the deny branch: "Denied by user" is engine prose the client already
    // renders from `outcome`, not a tool-authored reason.
    let resolvedError: string | undefined;
    // Non-null once the dispatch branch below has BOTH built `answered` and
    // persisted it, inside the same transaction as its outcome entry. The
    // common write further down then reuses that state instead of repeating it.
    let dispatchAnswered: HeldTurnState | null = null;

    if (params.choice === "deny" || boundaryRefused) {
      // "Deny": single-use, no grant. The LLM sees only "Denied by user" — or,
      // on a boundary refusal, the engine's fixed refusal string, so the record
      // never reports the user's decision as the reason it did not run.
      const refusal = boundaryRefused ? CONTROL_PLANE_REFUSAL : "Denied by user";
      if (boundaryRefused) {
        // eslint-disable-next-line no-console -- boundary alarm: same signal the dispatch gate raises, for a hold that predates it.
        console.error("control-plane boundary refusal", {
          service,
          verb,
          runOrigin: this.heldRunOrigin(turnState, held.runId),
          heldCallId: params.heldCallId,
        });
      }
      this.ctx.storage.transactionSync(() =>
        this.closeDecisionEntryInTxn(
          {
            userId: params.userId,
            agentId,
            sessionId: held.sessionId,
            toolName: heldCall.name,
            service,
            verb,
            noun,
            decision: "deny",
            origin: actionOrigin,
            parametersMetadata: extractMetadata(heldInput),
            outcome: "error",
            errorMessage: refusal,
            decisionEntryId: held.pendingAuditEntryId,
            latencyMs: 0,
          },
          "observed",
        ),
      );
      resolvedResult = {
        type: "tool_result",
        tool_use_id: heldCall.id,
        content: refusal,
        is_error: true,
      };
      // The user's "deny" and the boundary's refusal share this branch because
      // neither dispatches, but they are not the same answer to report: one is
      // the user's decision, which they can revisit, and the other is the
      // engine's, which they cannot.
      resolvedOutcome = boundaryRefused ? "boundary_refused" : "denied";
      // Record the denied action in the task's per-action detail. The
      // breakdown's vocabulary is coarser than the wire's on purpose — a task
      // action reads as denied either way, and the refusal reason is already on
      // the audit row this branch just closed.
      this.appendActionDetail(held.runId, { service, verb, noun, outcome: "denied" });
    } else {
      // Affirmative choices. `approve_once` (spend hold) mints nothing —
      // permission already passed when this call was parked or resumed, so
      // the only thing being approved is this one order at this one amount
      // (every subsequent over-cap action asks again).
      // `task`/`session` (ordinary hold) mint the scoped grant first.
      let taskGrantId: string | undefined;
      if (params.choice === "task") {
        taskGrantId = this.createTaskGrant(service, verb, noun, held.sessionId);
      } else if (params.choice === "session") {
        this.createSessionGrant(service, verb, noun, held.sessionId);
      }

      // Spend check on resume (site two): a money-verb
      // call resumed by a grant has passed permission but not the cap, so the
      // check runs again before dispatch. On a breach the SAME held row
      // re-parks as a spend hold, in ONE transaction: a fresh pending audit
      // entry (spend snapshot in metadata, amount in cost_usd), a terminal
      // outcome closing the SUPERSEDED pending entry so no entry is left
      // dangling, and the row's pending link + spend context rewritten. The
      // turn state is untouched, so the parked call stays resumable. Skipped
      // Also runs for approve_once, so a cap the user LOWERED while the order
      // sat parked binds the approval — the shipped promise is that a lowered
      // cap binds the next spend check, and an approval is a spend check. The
      // re-park is idempotent: the same row re-parks with the new amounts and
      // the user is asked again against the limit they just set.
      //
      // The authorizing task grant is consumed BEFORE the re-park, not
      // deferred to the eventual dispatch. Leaving it live across the parked
      // window let ONE single-use "for this task" answer authorize TWO
      // dispatches: any other call matching the same (service, verb, noun) —
      // a fresh commission, or a direct execute — could redeem the live grant
      // while the user was still deciding, and the later approval dispatched
      // again. The single-use answer is spent either way (approve, deny, or
      // expiry), so consuming it here loses nothing: `approve_once` dispatches
      // on the hold's own authority and consults no policy entry.
      if (registry?.spend) {
        const stage = this.runSpendStage(registry.spend, heldInput, held.sessionId);
        // An `approve_once` whose amount STILL breaches the same context the
        // user is answering is the approval itself — re-parking there would
        // loop forever. Only a context that changed under them (a lowered cap,
        // or spend that landed while they decided) re-parks.
        const alreadyAnswered =
          params.choice === "approve_once" &&
          spendCtx != null &&
          stage.holdContext !== undefined &&
          JSON.stringify(stage.holdContext) === JSON.stringify(spendCtx);
        if (stage.holdContext && !alreadyAnswered) {
          const chained: SpendHoldContext = { ...stage.holdContext };
          const supersededPendingId = held.pendingAuditEntryId;
          const auditSnapshot = {
            ...extractMetadata(heldInput),
            // Amounts and limits only — the grant id stays on the row's
            // spend_context and out of the hash-framed metadata.
            spend: stage.holdContext,
          };
          const pendingEntry = this.ctx.storage.transactionSync(() => {
            // Close the permission hold's pending entry: it is superseded by
            // the spending hold, so it gets its terminal here rather than
            // being orphaned when the row's pending link is rewritten.
            this.closeDecisionEntryInTxn(
              {
                userId: params.userId,
                agentId,
                sessionId: held.sessionId,
                toolName: heldCall.name,
                service,
                verb,
                noun,
                decision: "pending",
                origin: actionOrigin,
                parametersMetadata: extractMetadata(heldInput),
                outcome: "success",
                errorMessage: "Superseded by a spending confirmation",
                decisionEntryId: supersededPendingId,
                latencyMs: 0,
              },
              "observed",
            );
            const entry = auditLogData.insertAuditEntryInTxn(this.sqlTag, {
              userId: params.userId,
              agentId,
              sessionId: held.sessionId,
              toolName: heldCall.name,
              service,
              verb,
              noun,
              decision: "pending",
              origin: actionOrigin,
              parametersMetadata: auditSnapshot,
              // pending is not a failure; mirrors the pipeline's pending entry.
              outcome: "success",
              latencyMs: 0,
              costUsd: stage.costUsd,
            });
            heldToolCallsData.reholdForSpend(
              this.sqlTag,
              params.heldCallId,
              entry.id,
              JSON.stringify(chained),
            );
            if (taskGrantId) {
              policyEntriesData.consumeTaskGrant(
                this.sqlTag,
                taskGrantId,
                new Date().toISOString(),
              );
            }
            return entry;
          });
          void pendingEntry;
          // The chained hold rides the existing resumed-with-held wire shape
          // (ChatResponse.held) — same held id, so the caller re-prompts.
          const chainedResolution: ConfirmationResolution = {
            status: "resumed",
            result: {
              response: "",
              toolCalls: [
                {
                  name: recordToolName(heldCall.name),
                  id: heldCall.id,
                  outcome: "held",
                },
              ],
              usage: { inputTokens: 0, outputTokens: 0 },
              iterations: 0,
              held: { heldCallId: params.heldCallId },
            },
          };
          this.recordRunAfterResolve(held.runId, chainedResolution);
          return chainedResolution;
        }
      }

      // For a task grant, consume BEFORE execute (fail-closed): a crash
      // mid-execute can never re-authorize.
      if (taskGrantId) {
        this.consumeTaskGrant(taskGrantId);
      }
      // Mark dispatched BEFORE the await: a crash between a
      // successful dispatch and persisting `answered` must not re-dispatch on
      // retry. With a session grant the grant survives, so without this marker
      // a retry would re-run a side-effecting tool. Committed pre-await; the DO
      // is single-threaded so this write lands before dispatch begins.
      this.storeHeldTurnState(
        params.heldCallId,
        wrapTurnState({ ...turnState, dispatched: true }),
      );
      const execution = await this.dispatchTool(
        heldCall.name,
        heldInput,
        params.userId,
      );
      // Provider-authored content (success data or error text) is fenced as
      // untrusted before it reaches the LLM —
      // the mirror of classifyToolResult's success/error branches. Built BEFORE
      // the outcome write: `JSON.stringify` over provider-authored data is the
      // one step here that can throw, and throwing ahead of the write leaves the
      // row plainly unrecovered rather than closed-but-unrecorded.
      resolvedResult = {
        type: "tool_result",
        tool_use_id: heldCall.id,
        content: fenceUntrusted(
          execution.success
            ? JSON.stringify(execution.data ?? null)
            : (execution.error ?? "Tool execution failed"),
        ),
        is_error: !execution.success,
      };
      resolvedOutcome = execution.success ? "success" : "error";
      resolvedError = execution.success
        ? undefined
        : (execution.error ?? "Tool execution failed");
      dispatchAnswered = {
        ...turnState,
        answered: { resolvedResult, resolvedOutcome, resolvedError },
      };
      // The money-verb outcome + ledger write share one transaction; the
      // spend hold's deferred authorizing grant is spent in it too.
      // `answered` rides that transaction as well — see
      // writeOutcomeWithSpend: closing the decision entry without recording
      // that it closed is what let a recovery path close it a second time.
      this.writeOutcomeWithSpend({
        auditParams: {
          userId: params.userId,
          agentId,
          sessionId: held.sessionId,
          toolName: heldCall.name,
          service,
          verb,
          noun,
          decision: "allow",
          origin: actionOrigin,
          parametersMetadata: extractMetadata(heldInput),
          outcome: execution.success ? "success" : "error",
          errorMessage: execution.error,
          decisionEntryId: held.pendingAuditEntryId,
          latencyMs: 0,
        },
        tool: registry,
        toolParams: heldInput,
        persistAnswered: {
          heldCallId: params.heldCallId,
          turnState: wrapTurnState(dispatchAnswered),
        },
      });
      // Record the dispatched action in the task's per-action detail.
      this.appendActionDetail(held.runId, {
        service,
        verb,
        noun,
        outcome: execution.success ? "executed" : "errored",
      });
    }

    // Persist the produced answer into the held row BEFORE the resume LLM
    // round-trip, so a resume failure leaves a recoverable, already-answered
    // held call (retry will not re-dispatch). The grant/deny side effects above
    // are already committed; only the LLM resume remains. The dispatch branch is
    // the exception: it has already written this row, atomically with the
    // outcome entry it had to close in the same breath.
    const answeredState: HeldTurnState =
      dispatchAnswered ?? {
        ...turnState,
        answered: { resolvedResult, resolvedOutcome, resolvedError },
      };
    if (dispatchAnswered === null) {
      this.storeHeldTurnState(params.heldCallId, wrapTurnState(answeredState));
    }

    const resolution = await this.resumeAndFinalize({
      heldCallId: params.heldCallId,
      turnState: answeredState,
      userId: params.userId,
      agentId,
      origin: actionOrigin,
      runId: held.runId,
      resolvedResult,
      resolvedOutcome,
      resolvedError,
    });
    this.recordRunAfterResolve(held.runId, resolution);
    return resolution;
      },
    );
  }

  /**
   * Resume the turn and delete the held row only on success.
   * If the resume LLM round-trip throws, the held row is left intact
   * carrying its `answered` payload, so the turn is recoverable: a retry of
   * resolveConfirmation reloads it and resumes without re-dispatching the tool.
   *
   * Note: if the resume itself parks a NEW held call (cascade), that new row is
   * created by executeTool with a fresh id; this original answered row is the
   * one we delete, leaving exactly the new held call.
   */
  private async resumeAndFinalize(params: {
    heldCallId: string;
    turnState: HeldTurnState;
    userId: string;
    agentId: string;
    origin: AuditOrigin;
    runId: string | null;
    resolvedResult: ResumeState["resolvedResult"];
    resolvedOutcome: ResumeState["resolvedOutcome"];
    resolvedError: ResumeState["resolvedError"];
  }): Promise<ConfirmationResolution> {
    // A direct POST /api/tools/execute hold has no conversation to
    // resume: the tool already dispatched (or was denied) in the caller, so
    // re-entering the LLM loop would push a tool_result with no preceding
    // tool_use and the API would reject it. Synthesize the terminal result
    // instead. This one branch covers the normal resolve and both crash
    // recovery paths (answered / dispatched), which all funnel through here.
    const resolution = params.turnState.directExecute
      ? this.directExecuteResolution(
          params.turnState,
          params.resolvedOutcome,
          params.resolvedError,
        )
      : await this.resumeHeldTurn({
          turnState: params.turnState,
          userId: params.userId,
          agentId: params.agentId,
          origin: params.origin,
          runId: params.runId,
          resolvedResult: params.resolvedResult,
          resolvedOutcome: params.resolvedOutcome,
          resolvedError: params.resolvedError,
        });
    // Resume succeeded — the original held call is fully resolved. Delete it.
    // (A cascade hold created a new row with a different id; this delete is
    // scoped to the original id, so the new held call survives.)
    this.deleteHeldCall(params.heldCallId);
    return resolution;
  }

  /**
   * Terminal resolution for a direct-execute hold. The held tool
   * has already dispatched (grant) or been denied by resolveConfirmation, and
   * its outcome is in the audit log; there is no conversation to re-enter.
   * Shape it as a `resumed` result with empty response text and the single
   * resolved tool call so the wire contract is unchanged — the caller reads a
   * completed turn that produced no assistant prose.
   *
   * Current limitation: the resolve wire is chat-shaped (ResolveResponse →
   * ChatResponse), which carries per-call outcome LABELS but no field for a
   * tool's return payload. So a direct POST /api/tools/execute caller who
   * approves a held read (e.g. mock_email_list) learns the call succeeded but
   * does NOT get the rows back here — the data was dispatched and audited, not
   * surfaced. This is deliberate for now; returning the payload needs a
   * ResolveResponse contract change and is out of this fix's scope.
   */
  private directExecuteResolution(
    turnState: HeldTurnState,
    outcome: ToolCallOutcome,
    error?: string,
  ): ConfirmationResolution {
    return {
      status: "resumed",
      result: {
        response: "",
        toolCalls: [
          {
            name: recordToolName(turnState.heldCall.name),
            id: turnState.heldCall.id,
            outcome,
            error,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        iterations: 0,
      },
    };
  }

  /**
   * Re-invoke the conversation loop after a held call resolves, carrying the
   * resolved answer and re-evaluating any parked calls (which may hold again).
   */
  private async resumeHeldTurn(params: {
    turnState: HeldTurnState;
    userId: string;
    agentId: string;
    origin: AuditOrigin;
    runId: string | null;
    resolvedResult: ResumeState["resolvedResult"];
    resolvedOutcome: ResumeState["resolvedOutcome"];
    resolvedError: ResumeState["resolvedError"];
  }): Promise<ConfirmationResolution> {
    // Invariant: a direct-execute hold has no conversation to
    // resume — its seeded turn_state carries `messages: []`, so re-entering the
    // loop would push a tool_result with no antecedent tool_use and the API
    // would reject it. resumeAndFinalize routes such holds to
    // directExecuteResolution and must never reach here. Fail loud rather than
    // let a future refactor silently send the malformed resume.
    if (params.turnState.directExecute) {
      throw new Error(
        "resumeHeldTurn reached for a directExecute hold — must resolve via directExecuteResolution",
      );
    }
    const connectedServices = this.listConnectedServices().map((s) => s.service);
    // Re-derive the run's trust surface so a resumed turn is offered the same
    // tool surface it held under — neither a commission
    // nor a plain local (`human`) hold may gain the control-plane tools on
    // resume. `heldRunOrigin` is fail-closed for a legacy origin-less row.
    const resumeOrigin: RunOrigin = this.heldRunOrigin(
      params.turnState,
      params.runId,
    );
    const tools = buildToolDefinitions(connectedServices, {
      allowControlPlane: controlPlaneAllowed(resumeOrigin),
    });
    // Per-task context: resume rebuilds the conversation
    // from the hold's own turn_state (answerAndDrainParkedCalls does
    // `messages.length = 0; push(...base.messages)`). A COMMISSION resume runs on
    // a throwaway buffer — its continuity lives in turn_state, and it must never
    // touch the human buffer. A HUMAN resume (run_id null) writes back onto
    // this.conversationMessages so the next chat turn continues from the
    // completed, resolved turn rather than the pre-hold state (which would leave
    // a dangling tool_use for repairOrphanedToolUse to answer with a synthetic
    // error — the exact continuity break this preserves against).
    const resumeMessages: LLMMessage[] =
      params.runId === null ? this.conversationMessages : [];
    const llmConfig = this.getLLMConfig();
    const result = await runConversationLoop({
      userMessage: "",
      client: this.getLLMClient(),
      model: llmConfig.model,
      maxTokens: llmConfig.maxTokens,
      tools,
      system: params.runId
        ? `${HABENULA_SYSTEM_PROMPT}\n\n${COMMISSION_ORIGIN_NOTICE}`
        : HABENULA_SYSTEM_PROMPT,
      executeTool: (toolName, toolParams) =>
        this.executeToolForLoop({
          toolName,
          toolParams,
          userId: params.userId,
          agentId: params.agentId,
          origin: params.origin,
          runOrigin: resumeOrigin,
          runId: params.runId,
        }),
      messages: resumeMessages,
      // Carry the re-derived trust surface forward onto any re-hold, so a chain
      // of confirmations keeps resolving under the same origin.
      persistHeldTurn: (heldCallId, state) => {
        this.storeHeldTurnState(
          heldCallId,
          wrapTurnState({ ...state, origin: resumeOrigin }),
        );
      },
      resumeState: {
        state: params.turnState,
        resolvedResult: params.resolvedResult,
        resolvedOutcome: params.resolvedOutcome,
        resolvedError: params.resolvedError,
      },
    });
    return { status: "resumed", result };
  }

  /** Clear conversation history. */
  resetConversation(): void {
    this.conversationMessages = [];
  }

  /**
   * Answer any trailing unanswered tool_use in the conversation buffer with a
   * synthetic error tool_result. A held-call sweep resolves the parked call's
   * audit side and deletes its row, but cannot repair this in-memory buffer;
   * left alone, the dangling tool_use makes the API reject every subsequent
   * turn — permanently, since the error rollback removes only the new user
   * message. Called lazily from chat() after the held-guard has proven no live
   * held call remains, so a trailing tool_use is orphaned by definition. One
   * repair covers every sweep path (quit / kill / timeout / superseded). The
   * content is a fixed minimal string — no ids, scopes, or internals.
   *
   * A trailing turn CAN be partially executed: in a multi-tool turn, a granted
   * sibling runs before a later un-granted call holds, and its result is
   * parked only in turn_state.producedResults (never in this buffer) — which
   * the sweep deleted with the row. So the synthetic result asserts only what
   * is known: the result was not recorded, and the call may or may not have
   * executed. The audit log holds each call's true outcome.
   *
   * `healedDispatchIds` is the exception to that hedge. `healCrashedDispatchHolds`
   * just closed out a hold whose `dispatched` marker PROVES its tool ran, so
   * those ids are answered as completed instead — telling the model
   * a side-effecting call may not have run is how it gets talked into repeating
   * it. Every other orphan in the same assistant message keeps the hedge; all of
   * them must be answered together, because the API rejects a partial answer.
   *
   * Message shape: this pushes a tool_result-only user message, and the next
   * turn pushes its own user text message. The Messages API combines
   * consecutive same-role messages into one turn (tool_results first — the
   * required position), so the repaired conversation is API-valid.
   */
  private repairOrphanedToolUse(healedDispatchIds: Set<string> = new Set()): void {
    const last = this.conversationMessages[this.conversationMessages.length - 1];
    if (!last || last.role !== "assistant" || typeof last.content === "string") {
      return;
    }
    const orphans = last.content.filter(
      (b): b is LLMToolUseBlock => b.type === "tool_use",
    );
    if (orphans.length === 0) return;
    this.conversationMessages.push({
      role: "user",
      content: orphans.map((t): LLMToolResultBlock => {
        const healed = healedDispatchIds.has(t.id);
        return {
          type: "tool_result",
          tool_use_id: t.id,
          content: healed
            ? DISPATCH_RECOVERY_RESULT
            : "The session ended before this call was resolved; its result was not recorded and it may or may not have executed.",
          is_error: !healed,
        };
      }),
    });
    // Abandon any surviving `answered` held row for a tool_use we just answered
    // — such a row is the residue of a resolve whose dispatch
    // succeeded but whose resume LLM round-trip threw: it stays behind carrying
    // `answered`, and is invisible to the chat held-guard (heldCallId() skips
    // answered rows) — which is exactly why this repair ran at all. The buffer
    // now answers that tool_use out-of-band, so the held row must not later
    // re-drive the turn: a retry-resolve would rewind the conversation to the
    // held turn and append a SECOND answer for an id already answered here (the
    // API-400 wedge). Deleting it makes a retry-resolve a clean not_found. The
    // dispatch's audit outcome was written before `answered` was persisted, so
    // no audit pair is left dangling.
    this.discardResolvedHeldCalls(new Set(orphans.map((o) => o.id)));
  }

  /**
   * Delete any `answered` held row (its resolve already dispatched/denied and
   * produced a result) whose held tool_use id is among `orphanToolUseIds` — the
   * ids `repairOrphanedToolUse` just synthesized answers for. Only
   * `answered` rows qualify, and no other kind can reach this path: a still-parked
   * row is caught by the chat held-guard before repair runs, and a
   * `dispatched`-but-not-yet-`answered` row was already closed out and deleted by
   * `healCrashedDispatchHolds`, upstream of that guard. The tool_use
   * id is matched exactly, so an unrelated held row is never touched.
   */
  private discardResolvedHeldCalls(orphanToolUseIds: Set<string>): void {
    for (const row of heldToolCallsData.selectHeldCalls(this.sqlTag)) {
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) continue;
      const turnState = parsed.state;
      if (turnState.answered === undefined) continue;
      if (turnState.heldCall && orphanToolUseIds.has(turnState.heldCall.id)) {
        this.deleteHeldCall(row.id);
      }
    }
  }

  /**
   * Resolve a valid credential for a service. Uses single-flight refresh
   * to prevent concurrent token refresh races.
   *
   * Token exists only in the return value — never stored in DO state
   * (this.* fields) or written to SQLite.
   */
  async resolveCredential(
    userId: string,
    service: string,
    refreshFn: (credential: StoredCredential) => Promise<StoredCredential>,
  ): Promise<StoredCredential> {
    const encKey = await importEncryptionKey(this.env.CREDENTIAL_ENCRYPTION_KEY);
    return this.refresher.getValidCredential({
      store: this.credentialStore(),
      encKey,
      userId,
      service,
      refreshFn,
    });
  }

  /**
   * Write an audit entry with atomic hash chaining. This wrapper IS the
   * "standalone" form — it owns the transaction the helper itself is never
   * allowed to open. Callers already inside their own
   * transactionSync() call insertAuditEntryInTxn directly instead.
   */
  writeAuditEntry(params: WriteAuditEntryParams): WriteAuditEntryResult {
    return this.ctx.storage.transactionSync(() =>
      auditLogData.insertAuditEntryInTxn(this.sqlTag, params),
    );
  }

  /**
   * Binds `this.sqlTag` to the audit helper's closer write, which is where the
   * asymmetric write rule itself lives — see `closeDecisionEntryInTxn` there
   * for the observed/inferred split. This wrapper carries no rule of its own,
   * so a call site that reaches the helper directly behaves identically.
   *
   * Txn-context-only: the caller owns the `transactionSync`. Observed always
   * writes, so that overload returns the entry; only the inferred branch can
   * skip, so only it admits null.
   */
  private closeDecisionEntryInTxn(
    params: ReferencingAuditEntryParams,
    basis: "observed",
  ): WriteAuditEntryResult;
  private closeDecisionEntryInTxn(
    params: ReferencingAuditEntryParams,
    basis: CloserBasis,
  ): WriteAuditEntryResult | null;
  private closeDecisionEntryInTxn(
    params: ReferencingAuditEntryParams,
    basis: CloserBasis,
  ): WriteAuditEntryResult | null {
    return auditLogData.closeDecisionEntryInTxn(this.sqlTag, params, basis);
  }

  /**
   * The dispatch-site outcome write, shared by `executeTool` and
   * `resolveConfirmation`. For an ordinary verb this is
   * `writeAuditEntry` unchanged. For a money verb it stamps `cost_usd` from
   * the bound quote (record-only) and, on success, inserts the ledger row in
   * the SAME transaction as the outcome entry — `ON CONFLICT (idempotency_key,
   * quote_id) DO NOTHING`, so a replayed commit writes one row and a reused
   * key under a new quote is counted (an uncounted spend is a cap bypass).
   *
   * The ledger write can NEVER endanger the outcome entry. A throw from the
   * insert — a storage fault, or the ledger guards rejecting an amount or a
   * timestamp — would otherwise roll the transaction back and erase the
   * terminal record of a dispatch that already ran, the one direction Hard
   * Invariant #3 forbids. That is not hypothetical: the design ships a
   * `totals_unavailable` hold precisely because the ledger can be unreadable,
   * and the human answer to that hold is approve. So the insert is caught
   * inside the transaction: the outcome entry commits regardless, the spend is
   * left uncounted, and the gap is exactly what the audit↔ledger
   * comparison detects — the entry carries `cost_usd`, so the amount is
   * recoverable from a tamper-evident row.
   *
   * `persistAnswered` is the resolve path's held-row write, handed in so it
   * shares this transaction. A caller that closes the decision
   * entry must record `answered` on the row in the same breath. Split across two
   * transactions, a crash between them leaves a row reading `dispatched` with no
   * `answered` — indistinguishable from an outcome that was never written — and
   * the recovery paths (`healCrashedDispatchHolds`, `resolveConfirmation`'s
   * dispatched branch) then close the one decision a SECOND time.
   *
   * Unlike the ledger insert this one is deliberately NOT caught. If the row
   * write throws, rolling the outcome entry back with it is the safe direction:
   * the row still reads as unrecovered, so a recovery path closes the decision
   * exactly once. Catching it would commit the outcome and leave the row still
   * asking to be closed — the very duplicate this parameter exists to prevent.
   */
  private writeOutcomeWithSpend(params: {
    auditParams: ReferencingAuditEntryParams;
    tool: ReturnType<typeof lookupTool>;
    toolParams: Record<string, unknown>;
    persistAnswered?: { heldCallId: string; turnState: string };
  }): WriteAuditEntryResult {
    // Both facts already live on the audit params; taking them twice invites a
    // ledger row attributed to a session the audit entry does not name.
    const sessionId = params.auditParams.sessionId;
    const success = params.auditParams.outcome === "success";
    const spend = params.tool?.spend;
    const amountCents = centsFromSpend(spend, params.toolParams);
    const auditParams: ReferencingAuditEntryParams =
      amountCents !== null
        ? { ...params.auditParams, costUsd: centsToUsd(amountCents) }
        : params.auditParams;
    let ledgerError: unknown = null;
    const entry = this.ctx.storage.transactionSync(() => {
      const written = this.closeDecisionEntryInTxn(auditParams, "observed");
      if (spend && amountCents !== null && success) {
        // The tool declares its own commit identity, so the engine never
        // hardcodes one service's parameter spelling — a second paid service
        // whose params differ would otherwise write ("","") and have its
        // spends silently deduped away by the unique pair.
        const keys = spend.commitKeys(params.toolParams);
        try {
          spendLedgerData.insertSpendInTxn(this.sqlTag, {
            id: crypto.randomUUID(),
            sessionId,
            createdAt: new Date().toISOString(),
            service: params.tool!.service,
            verb: params.tool!.verb,
            amountCents,
            quoteId: keys.quoteId,
            idempotencyKey: keys.idempotencyKey,
            auditEntryId: written.id,
          });
        } catch (err) {
          // Caught INSIDE the transaction so the outcome entry still commits.
          ledgerError = err;
        }
      }
      if (params.persistAnswered) {
        heldToolCallsData.updateHeldTurnState(
          this.sqlTag,
          params.persistAnswered.heldCallId,
          params.persistAnswered.turnState,
        );
      }
      return written;
    });
    if (ledgerError !== null) {
      // Record the gap where it can be found. A silent uncounted spend widens
      // the cap by its amount until reconciled, so the failure gets its own
      // hash-chained row naming the outcome entry that carries the amount —
      // `habenula log` shows it, and the audit↔ledger comparison has
      // something explicit to key on rather than only an absence. Runs after
      // the outcome transaction above has committed, so it opens its own.
      this.ctx.storage.transactionSync(() =>
        this.closeDecisionEntryInTxn(
          {
            ...auditParams,
            outcome: "error",
            errorMessage: `spend_ledger write failed — spend uncounted (${String(ledgerError)})`,
            decisionEntryId: entry.id,
          },
          "observed",
        ),
      );
    }
    return entry;
  }

  /**
   * Run the governance pipeline for a tool call:
   * 1. Look up tool in registry → (service, verb, noun)
   * 2. Evaluate policy (pure function, no side effects)
   * 3. Write audit entry (atomic, hash-chained)
   * 4. Return decision so caller can proceed or block
   */
  executeGovernancePipeline(
    params: GovernancePipelineParams
  ): GovernancePipelineResult {
    const toolRegistryEntry = lookupTool(params.toolName);
    const service = toolRegistryEntry?.service ?? "unknown";
    const verb = toolRegistryEntry?.verb ?? "execute";
    const noun = toolRegistryEntry
      ? toolRegistryEntry.nounExtractor(params.params)
      : "unknown";

    const pd = evaluatePolicy(params.entries, {
      agent: params.agentId,
      service,
      verb,
      noun,
      toolName: params.toolName,
      params: params.params,
    });

    // Pipeline-level pending: the pure evaluator only answers
    // allow|deny. When no affirmative grant matched — either no entry matched
    // at all (source "implicit") or only the default-deny floor did — there is
    // nothing granting this action, so the pipeline asks the user rather than
    // hard-denying. An explicit non-floor deny grant stays deny (a real "no"),
    // as does a `source: "malformed"` fail-closed on a corrupt policy set
    // — neither is askable, so a corrupt policy never surfaces a confirmation.
    // `askable` lets callers that have no confirmation path (e.g. the
    // not-connected pre-check) force a plain deny.
    const noAffirmativeGrant =
      pd.decision === "deny" &&
      (pd.source === "implicit" || pd.entryId === WILDCARD_DENY_ID);
    const askable = params.askable ?? false;
    let decision: "allow" | "deny" | "pending" =
      askable && noAffirmativeGrant ? "pending" : pd.decision;

    // The spend stage: after permission, before the audit
    // write — the one seam where a breach can flip `allow` to `pending` and
    // still be recorded by the SAME decision entry (audit-before-execute with
    // a single row). Runs only for the money-verb class (the `spend` field's
    // presence) and only on an allow: an action the user never granted is
    // refused on permission grounds and never priced. Totals and limits are
    // read here and passed to the pure evaluator as values (Hard Invariant 2).
    let spendContext: SpendHoldContext | undefined;
    let costUsd: number | undefined;
    if (decision === "allow" && toolRegistryEntry?.spend) {
      const stage = this.runSpendStage(
        toolRegistryEntry.spend,
        params.params,
        params.sessionId,
      );
      costUsd = stage.costUsd;
      if (stage.holdContext) {
        spendContext = stage.holdContext;
        decision = "pending";
      }
    }

    // A corrupt-policy deny gets its own audit message so it is
    // forensically distinguishable from an ordinary floor/policy deny — the
    // `malformed` source is not persisted as a column, so the reason string is
    // the only trace it leaves. It takes precedence over any caller-supplied
    // reason (the only path that produces `malformed` — the main policy path —
    // passes none anyway).
    const auditDenyReason =
      pd.source === "malformed"
        ? "Denied: malformed policy set (non-finite priority)"
        : (params.denyReason ?? "Denied by policy");

    // A money-verb entry carries the spend snapshot in its metadata — amounts
    // and limits only, never cart contents (metadata-only posture holds).
    const parametersMetadata = spendContext
      ? { ...extractMetadata(params.params), spend: spendContext }
      : extractMetadata(params.params);

    const auditEntry = this.writeAuditEntry({
      userId: params.userId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      toolName: params.toolName,
      service,
      verb,
      noun,
      decision,
      origin: params.origin,
      parametersMetadata,
      // pending and allow are not failures; only an explicit deny is.
      outcome: decision === "deny" ? "error" : "success",
      errorMessage: decision === "deny" ? auditDenyReason : undefined,
      latencyMs: 0,
      // Money verbs record the bound quote (record-only, dollars — the
      // ledger, in integer cents, is the only arithmetic surface). Inside the
      // hash frame, so it is supplied at insert, never back-filled.
      costUsd,
      epochId: params.epochId,
      timestamp: params.timestamp,
    });

    return {
      decision,
      auditEntry,
      service,
      verb,
      noun,
      matchedEntryId: pd.entryId,
      matchedSource: pd.source,
      ...(spendContext ? { spendContext } : {}),
    };
  }

  /**
   * Price a money-verb call and check it against both windows. The
   * pipeline is synchronous, so the amount
   * extractor is too — a sync decode, no I/O, no crypto (signature
   * verification is the service's job at commit). Limits are read at each
   * check, never cached: a lowered cap binds the next call. A
   * ledger read failure maps to the explicit `totals_unavailable` outcome —
   * hold and ask, never a silent allow and never a hard deny.
   */
  private runSpendStage(
    spend: NonNullable<NonNullable<ReturnType<typeof lookupTool>>["spend"]>,
    toolParams: Record<string, unknown>,
    sessionId: string,
  ): { costUsd?: number; holdContext?: SpendHoldContext } {
    const amountCents = spend.quotedAmountCents(toolParams);
    // What the user is buying, for the confirmation surface. Service-derived
    // from its own bound quote, so it is trusted chrome — never model text.
    const summary = spend.describe?.(toolParams) ?? undefined;
    const withSummary = <T extends object>(ctx: T): T & { summary?: string } =>
      summary !== undefined ? { ...ctx, summary } : ctx;
    if (amountCents === null) {
      return {
        holdContext: withSummary({
          amountCents: null,
          reason: "unpriced" as const,
          breaches: [],
        }),
      };
    }
    const costUsd = amountCents / 100;
    let totals: { sessionSpentCents: number; monthSpentCents: number } | null;
    let limits: ReturnType<typeof userSettingsData.readSpendLimitsCents>;
    try {
      limits = userSettingsData.readSpendLimitsCents(this.sqlTag);
      totals = {
        sessionSpentCents: spendLedgerData.sumSessionSpendCents(
          this.sqlTag,
          sessionId,
        ),
        monthSpentCents: spendLedgerData.sumMonthSpendCents(
          this.sqlTag,
          this.monthStartIso(),
        ),
      };
    } catch {
      return {
        costUsd,
        holdContext: withSummary({
          amountCents,
          reason: "totals_unavailable" as const,
          breaches: [],
        }),
      };
    }
    const check = evaluateSpend({
      amountCents,
      limits: {
        sessionLimitCents: limits.sessionLimitCents,
        monthLimitCents: limits.monthLimitCents,
      },
      totals,
    });
    if (check.result === "within") {
      return { costUsd };
    }
    if (check.result === "exceeds") {
      return {
        costUsd,
        holdContext: withSummary({
          amountCents,
          reason: "over_limit" as const,
          breaches: check.breaches,
        }),
      };
    }
    // `unavailable` — malformed inputs the pure evaluator refused to rank.
    return {
      costUsd,
      holdContext: withSummary({
        amountCents,
        reason: "totals_unavailable" as const,
        breaches: [],
      }),
    };
  }

  /**
   * Mark a service as connected for this user, writing the link and its
   * credential in one row. `credential` is the opaque ciphertext (the
   * JSON-stringified encrypted payload) passed by the OAuth callbacks, and is
   * omitted only for catalog-declared credential-less (`none`) services.
   *
   * Upsert: on reconnect a supplied credential replaces the stored one (a
   * refresh) and `connected_at` keeps its first-connect value, so the order
   * `listConnectedServices()` returns is undisturbed. The overwrite is plain —
   * every reachable caller supplies a credential for credentialed services, and
   * `none` services never hold one, so there is no bare-reconnect path to guard
   * against. The column is only ever cleared by `disconnectService`.
   */
  connectService(service: string, credential?: string): void {
    connectedServicesData.connectService(this.sqlTag, service, credential);
  }

  /**
   * Disconnect a service. Deleting the row removes its `credential` column in
   * the same operation, so disconnect can never leave a credential behind.
   * Returns whether a row actually matched, so the route can distinguish a
   * real disconnect from a no-op on an unknown or not-connected name.
   */
  disconnectService(service: string): boolean {
    return connectedServicesData.disconnectService(this.sqlTag, service);
  }

  /**
   * Row-backed credential accessor over this DO's `connected_services`. The
   * single-flight refresher reads and writes opaque ciphertext through it;
   * encrypt/decrypt stay in credential-store. The accessor is scoped to this
   * user's DO, so it carries no userId. `write` is an in-place UPDATE keyed by
   * service: connect creates the row, so a refresh normally writes back to an
   * existing row. If a concurrent `disconnectService` deletes the row during the
   * refresh's network await, the UPDATE matches no rows. `write` reports that
   * back via `RETURNING service` so the refresher can reject the stale write
   * rather than hand a live token to a service the user just disconnected.
   */
  private credentialStore(): CredentialRowStore {
    return {
      read: (service) =>
        connectedServicesData.readCredential(this.sqlTag, service),
      write: (service, ciphertext, expectedCiphertext) =>
        connectedServicesData.writeCredential(
          this.sqlTag,
          service,
          ciphertext,
          expectedCiphertext,
        ),
    };
  }

  /**
   * The stored credential's actually-granted scopes, for the pre-policy scope
   * precondition. Decrypt-only: loadCredential reads
   * the row and decrypts — no token refresh, no network — and the scopes stay
   * in DO memory, never toward the LLM (Hard Invariant 1).
   *
   * Returns null when no credential is stored or the blob is unreadable: the
   * gate answers only "do the GRANTED scopes cover the capability?", and a
   * missing credential is not a scope gap — the caller skips the gate and the
   * existing dispatch-time credential handling owns that failure.
   */
  private async readGrantedScopes(service: string): Promise<string[] | null> {
    try {
      const encKey = await importEncryptionKey(
        this.env.CREDENTIAL_ENCRYPTION_KEY,
      );
      const credential = await loadCredential(
        this.credentialStore(),
        encKey,
        service,
      );
      return credential?.scopes ?? null;
    } catch {
      return null;
    }
  }

  /** List all connected services. */
  listConnectedServices(): { service: string; connected_at: string }[] {
    return connectedServicesData.listConnectedServices(this.sqlTag);
  }

  /** Check if a service is connected. */
  isServiceConnected(service: string): boolean {
    return connectedServicesData.isServiceConnected(this.sqlTag, service);
  }

  /**
   * Execute a tool through the full governance pipeline:
   * 1. Check service is connected (deny if not)
   * 2. Run governance pipeline (registry lookup → policy check → audit write)
   * 3. If allowed, dispatch to tool implementation
   * 4. Return governance result + execution result
   */
  /**
   * The published data-slot keys a commissioned tool marks `required` that the
   * run has not supplied a value for. Empty when the tool
   * declares no required slots or all are bound. The check reads the run's `data`
   * map (the bound values), not the substituted params, so it is independent of
   * placeholder syntax.
   */
  private missingRequiredSlots(toolName: string, runId: string): string[] {
    const tool = lookupTool(toolName);
    const required = (tool?.dataSlots ?? [])
      .filter((slot) => slot.required)
      .map((slot) => slot.key);
    if (required.length === 0) return [];
    const run = commissionRunsData.readCommissionRun(this.sqlTag, runId);
    let provided: string[] = [];
    if (run?.data) {
      try {
        provided = Object.keys(JSON.parse(run.data) as Record<string, unknown>);
      } catch {
        provided = [];
      }
    }
    return required.filter((key) => !provided.includes(key));
  }

  /**
   * Park a commissioned action on missing client input.
   * Writes a `pending` decision audit entry (the frozen audit vocabulary carries
   * no `needs_input` decision, and the held row's `pending_audit_entry_id` is NOT
   * NULL) — closed by the terminal outcome when `habenula_provide` resumes the
   * call, the same audit-before-execute pairing a confirmation hold uses.
   * Creates an INPUT-kind held row recording the awaited published slot key(s) —
   * a closed vocabulary, never model prose — and moves the run to `needs_input`.
   * Returns a pending-shaped result so the conversation loop parks the turn (its
   * `persistHeldTurn` then overwrites the seed below with the real in-flight
   * conversation, preserving the `hold_kind`/`awaited_slot_keys` columns), and
   * `habenula_provide` later supplies the value and resumes.
   */
  private parkInputHold(params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    userId: string;
    agentId: string;
    sessionId: string;
    runId: string;
    origin?: AuditOrigin;
    missing: string[];
  }): ExecuteToolResult {
    const registry = lookupTool(params.toolName);
    const service = registry?.service ?? "unknown";
    const verb = registry?.verb ?? "execute";
    const noun = registry ? registry.nounExtractor(params.toolParams) : "unknown";
    const auditEntry = this.writeAuditEntry({
      userId: params.userId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      toolName: params.toolName,
      service,
      verb,
      noun,
      decision: "pending",
      origin: params.origin,
      parametersMetadata: extractMetadata(params.toolParams),
      // pending is not a failure; mirrors the governance pipeline's pending entry.
      outcome: "success",
      latencyMs: 0,
    });
    const heldCallId = crypto.randomUUID();
    const awaitedSlotKeys = JSON.stringify(params.missing);
    const seededTurnState = {
      messages: [],
      heldCall: {
        type: "tool_use",
        id: heldCallId,
        name: params.toolName,
        input: params.toolParams,
      },
      parkedCalls: [],
      producedResults: [],
      iterationsUsed: 0,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      directExecute: true,
    } satisfies HeldTurnState;
    const now = new Date().toISOString();
    heldToolCallsData.insertHeldToolCall(
      this.sqlTag,
      heldCallId,
      params.sessionId,
      auditEntry.id,
      now,
      params.runId,
      wrapTurnState(seededTurnState),
      "input",
      awaitedSlotKeys,
    );
    commissionRunsData.markNeedsInput(
      this.sqlTag,
      params.runId,
      awaitedSlotKeys,
      now,
    );
    return {
      governance: { decision: "pending", auditEntry, service, verb, noun },
      held: { heldCallId, pendingAuditEntryId: auditEntry.id },
    };
  }

  /**
   * Refuse a control-plane tool named by a run that may not reach it, and raise
   * the boundary alarm.
   *
   * Shaped exactly like the not-connected pre-check: `entries: []` with no
   * `askable`, so the pipeline force-denies rather than parking a confirmation,
   * and the attempt lands on the hash chain as a `deny` carrying the refusal
   * reason — the attempt is recorded whether or not anyone is reading the logs.
   * No `denyReason` is set: the wire's vocabulary describes remediations a caller
   * can act on (connect a service, re-authorize, change policy), and there is no
   * remediation for this one. It is not a policy deny and must not read as one,
   * which is also why the result carries `boundaryRefused`. The conversation loop
   * reads that flag and feeds the model `CONTROL_PLANE_REFUSAL`; without it the
   * model would be told "Denied by governance policy" and would go on to ask the
   * user for a grant the engine must never accept.
   *
   * The alarm is the other half of the accountability: a breach attempt here is
   * structurally impossible from a correct client, so one line at error level is
   * the signal that something is driving the boundary. It carries registry-derived
   * identifiers and the audit row's id only — no goal text, no parameters, no
   * model prose.
   */
  private refuseControlPlane(
    params: ExecuteToolParams,
    sessionId: string,
  ): ExecuteToolResult {
    const governance = this.executeGovernancePipeline({
      toolName: params.toolName,
      params: params.toolParams,
      userId: params.userId,
      agentId: params.agentId,
      sessionId,
      entries: [],
      origin: params.origin,
      denyReason: CONTROL_PLANE_REFUSAL,
      epochId: params.epochId,
      timestamp: params.timestamp,
    });
    // A refused action is terminal for the task, so it belongs in the breakdown
    // the commissioning client reads back — the attempt is disclosed to whoever
    // made it, not silently dropped.
    this.appendActionDetail(params.runId, {
      service: governance.service,
      verb: governance.verb,
      noun: governance.noun,
      outcome: "denied",
    });
    // eslint-disable-next-line no-console -- boundary alarm: an attempt to reach the control plane from an untrusted surface is structurally impossible from a correct client, and must be visible outside the audit log.
    console.error("control-plane boundary refusal", {
      service: governance.service,
      verb: governance.verb,
      runOrigin: params.runOrigin ?? "human",
      auditEntryId: governance.auditEntry.id,
    });
    return { governance, boundaryRefused: true };
  }

  /**
   * The trust surface a held call was parked under. The persisted `origin` is
   * authoritative; a legacy row written before that field existed has none, so
   * the fallback is fail-closed: a run-linked hold is a `commission`, and a
   * non-run hold is `human` (locality-gated, no control plane) — never
   * `internal`, which is reserved for the token-gated internal MCP surface, and
   * that surface always persists its origin.
   */
  private heldRunOrigin(
    turnState: HeldTurnState,
    runId: string | null,
  ): RunOrigin {
    return turnState.origin ?? (runId === null ? "human" : "commission");
  }

  /**
   * The GATED entry point for a caller that owns no turn — the direct
   * `POST /api/tools/execute` route. Every other mutating entry point (chat,
   * commission, provide, cancel, amend, resolve) already runs under the turn
   * gate; this one did not, and for a money verb that is a cap bypass: the
   * spend stage reads the ledger sums synchronously but the ledger row is
   * only written after `await dispatchTool`, so two concurrent direct calls
   * both price against pre-dispatch totals and both commit — two $15 orders
   * clearing a $20 session cap. Serializing here closes that window without
   * moving the spend record before the commit.
   *
   * The conversation loop calls `executeTool` directly and MUST keep doing so:
   * it already holds the gate, and re-entering would refuse its own tool call.
   */
  async executeToolDirect(
    params: ExecuteToolParams,
  ): Promise<ExecuteToolResult | { busy: true }> {
    return this.withTurnGate<ExecuteToolResult | { busy: true }>(
      () => ({ busy: true }),
      () => this.executeTool(params),
    );
  }

  async executeTool(params: ExecuteToolParams): Promise<ExecuteToolResult> {
    // Lazy reaper: DO activity hook — close out any expired session's
    // held call (terminal outcome + session.end, effective instant) before
    // proceeding, so no stale session state survives into this call.
    this.reapExpiredSessions();

    // Derive the active session. executeTool is reachable
    // directly from /api/tools/execute with no chat loop, so it resolves the
    // session itself rather than taking a caller-supplied id — the boundary no
    // longer mints one. Via the chat loop this idempotently attaches to the
    // session chat already established. reap → derive order matches chat().
    const sessionId = this.resolveActiveSession({
      userId: params.userId,
      agentId: params.agentId,
      // A session recreated mid-turn (the documented straddle) must carry the
      // turn's own origin into its session.start — resurrection under a
      // commission is commission-established.
      origin: params.origin,
    });

    // The DISPATCH half of the two-surface trust boundary, applied before every
    // other check so a refused call mutates nothing. `buildToolDefinitions`
    // withholds the `habenula` tools from a run that may not reach them, but a
    // commissioned goal is attacker-authored text and a model that is told to
    // call a tool can emit a name it was never offered. Gating only the
    // projection leaves the boundary enforced by what the engine OFFERS rather
    // than by what it ACCEPTS: the named-anyway call is admitted here, governed,
    // and parked as an ordinary confirmation — and answering that confirmation
    // executes `kill` / `disconnect` for real.
    //
    // Refused, not held. A held call is a question put to the user, and this one
    // must never be asked: no grant answer to it could be right, and asking it
    // makes the user the last line of a boundary the engine is supposed to keep.
    if (
      isControlPlaneTool(params.toolName) &&
      !controlPlaneAllowed(params.runOrigin ?? "human")
    ) {
      return this.refuseControlPlane(params, sessionId);
    }

    // Required-slot gate. A commissioned action whose
    // registry entry marks a data slot `required` cannot dispatch until the
    // client supplies a value for it. Gated on `runId` (mcp_commission only):
    // a human turn carries no runId and supplies missing values inline in chat,
    // so it never parks `needs_input`. On a miss, park an INPUT hold naming the
    // missing published slot key(s) — a closed vocabulary, never model prose —
    // and move the run to `needs_input`; `habenula_provide` supplies the value
    // and resumes. Precedes the not-connected / scope / policy checks: without
    // the required value the action's noun is not yet knowable, so governance
    // cannot meaningfully evaluate it.
    if (params.runId) {
      const missing = this.missingRequiredSlots(params.toolName, params.runId);
      if (missing.length > 0) {
        return this.parkInputHold({
          toolName: params.toolName,
          toolParams: params.toolParams,
          userId: params.userId,
          agentId: params.agentId,
          sessionId,
          runId: params.runId,
          origin: params.origin,
          missing,
        });
      }
    }

    // Look up the service for this tool before governance
    const entry = lookupTool(params.toolName);
    const service = entry?.service ?? "unknown";

    // Deny if service not connected. denyReason: "not_connected" tells the
    // caller this is a connect-a-service problem, not a policy problem.
    //
    // `habenula` is exempt: it is the control-plane
    // service, not an OAuth-connected one, so it never has a connected_services
    // row. Without this exemption every control-plane call would force-deny as
    // `not_connected` here — before the askable/held governance path — and the
    // spec's confirmation-as-onboarding-on-first-use requirement could never be
    // met. It carries no requiredScopes, so the scope precondition below is a
    // no-op for it, and governance (default-deny + held-on-first-use) remains
    // the backstop.
    if (service !== CONTROL_PLANE_SERVICE && !this.isServiceConnected(service)) {
      const governance = this.executeGovernancePipeline({
        toolName: params.toolName,
        params: params.toolParams,
        userId: params.userId,
        agentId: params.agentId,
        sessionId,
        entries: [],
        origin: params.origin,
        denyReason: `Service not connected: ${service}`,
        epochId: params.epochId,
        timestamp: params.timestamp,
      });
      return { governance, denyReason: "not_connected" };
    }

    // Scope precondition: the service is connected,
    // but does the stored credential's *actually granted* scopes cover this
    // tool's capability? Same precedence point as the connection check —
    // before policy, short-circuiting on a miss — but a different class of
    // check: granted scopes live only inside the encrypted credential blob,
    // so this decrypts (readGrantedScopes; no refresh, no network). Coverage
    // is any-of, not exact-string: a broader scope satisfies a narrower
    // capability. Tools with no requiredScopes skip the gate, as does a
    // service with no readable credential (a missing credential is not a
    // scope gap — dispatch-time credential handling owns it). Mirrors the
    // not-connected branch: entries [] and no askable force a plain deny,
    // audited before return with the same (service, verb, noun) a permitted
    // call would carry.
    if (entry?.requiredScopes && entry.requiredScopes.length > 0) {
      const granted = await this.readGrantedScopes(service);
      if (
        granted !== null &&
        !entry.requiredScopes.some((scope) => granted.includes(scope))
      ) {
        const governance = this.executeGovernancePipeline({
          toolName: params.toolName,
          params: params.toolParams,
          userId: params.userId,
          agentId: params.agentId,
          sessionId,
          entries: [],
          origin: params.origin,
          denyReason: `${service} is connected but not authorized to ${entry.verb}; re-connect to grant it`,
          epochId: params.epochId,
          timestamp: params.timestamp,
        });
        return { governance, denyReason: "needs_authorization" };
      }
    }

    // Policy entries always come from the DO's own store — never from the
    // caller. executeTool is reachable from the HTTP boundary, so accepting
    // caller-supplied entries here would let a request bypass stored policy.
    const entries = this.queryPolicyEntries(sessionId);

    const governance = this.executeGovernancePipeline({
      toolName: params.toolName,
      params: params.toolParams,
      userId: params.userId,
      agentId: params.agentId,
      sessionId,
      entries,
      origin: params.origin,
      askable: true,
      epochId: params.epochId,
      timestamp: params.timestamp,
    });

    // Pending → hold: no grant matched, so park the call and ask
    // the user. The `pending` decision audit entry was already written by the
    // pipeline (audit-before-execute). We mint a held-call id and create the
    // held_tool_calls row. No dispatch, no outcome entry. The current design
    // lifts the one-held-row-per-DO cap: several tasks may be parked at once,
    // each owning its own held row. The turn-in-flight gate still serializes
    // writes, so only one hold is ever created per live turn; a second task's
    // hold is created on its own turn.
    if (governance.decision === "pending") {
      const heldCallId = crypto.randomUUID();
      // executeTool is reachable directly from POST /api/tools/execute, where
      // there is no conversation loop to fill turn_state via persistHeldTurn.
      // Seed a minimal, self-describing turn_state at insert so a
      // freshly parked hold is both visible in GET /api/status
      // (readPendingHeldRecords) and resolvable (resolveConfirmation) — those
      // reads must not disagree about a hold that is still parked awaiting a
      // decision. `directExecute` marks a hold with no conversation to resume:
      // resolving it dispatches the tool and returns, never re-entering the LLM
      // loop. On the chat path the loop's persistHeldTurn immediately overwrites
      // this seed with the full in-flight turn (which carries no `directExecute`
      // flag), so seeding at insert costs one write, not an extra one.
      const seededTurnState = {
        messages: [],
        heldCall: {
          type: "tool_use",
          id: heldCallId,
          name: params.toolName,
          input: params.toolParams,
        },
        parkedCalls: [],
        producedResults: [],
        iterationsUsed: 0,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        directExecute: true,
      } satisfies HeldTurnState;
      // A spend hold persists its context onto the row:
      // amounts, the reason, and the breached windows — nothing else.
      const spendContext = governance.spendContext
        ? JSON.stringify(governance.spendContext satisfies SpendHoldContext)
        : null;
      heldToolCallsData.insertHeldToolCall(
        this.sqlTag,
        heldCallId,
        sessionId,
        governance.auditEntry.id,
        new Date().toISOString(),
        params.runId ?? null,
        wrapTurnState(seededTurnState),
        "confirmation",
        null,
        spendContext,
      );
      // A TASK grant that authorized this call permission-wise is spent HERE,
      // at the park — not deferred to the dispatch the approval later
      // triggers. Left live across the parked window, one single-use answer
      // could authorize two dispatches: another call matching the same
      // (service, verb, noun) could redeem the grant while the user was
      // deciding, and the approval would dispatch again. `approve_once`
      // dispatches on the hold's own authority and consults no policy entry,
      // so consuming now costs nothing and closes the window.
      if (governance.matchedSource === "task" && governance.matchedEntryId) {
        this.consumeTaskGrant(governance.matchedEntryId);
      }
      return {
        governance,
        held: { heldCallId, pendingAuditEntryId: governance.auditEntry.id },
      };
    }

    // Fail closed: dispatch only on an explicit allow. An explicit non-floor
    // deny (or any unexpected value) returns without executing.
    if (governance.decision !== "allow") {
      // Record the denied action in the task's per-action detail. A
      // deny is terminal for that action, so it belongs in the breakdown.
      if (governance.decision === "deny") {
        this.appendActionDetail(params.runId, {
          service: governance.service,
          verb: governance.verb,
          noun: governance.noun,
          outcome: "denied",
        });
      }
      return { governance, denyReason: "policy" };
    }

    // Consume-before-execute: if a task (single-use) grant authorized
    // this call, mark it consumed and commit BEFORE dispatch. The evaluator
    // excludes consumed rows, so the grant is inert immediately — a crash or
    // a genuine tool failure mid-execute can never re-authorize on retry.
    if (governance.matchedSource === "task" && governance.matchedEntryId) {
      this.consumeTaskGrant(governance.matchedEntryId);
    }

    // decision is "allow" — dispatch the tool
    const execution = await this.dispatchTool(
      params.toolName,
      params.toolParams,
      params.userId,
    );

    // Write outcome entry — hash-chained, references the decision entry. For
    // a money verb the outcome + ledger write share one transaction:
    // a committed spend is recorded with its amount, and
    // a failed commit keeps the amount with outcome=error — the attempted
    // spend is part of the record.
    this.writeOutcomeWithSpend({
      auditParams: {
        userId: params.userId,
        agentId: params.agentId,
        sessionId,
        toolName: params.toolName,
        service: governance.service,
        verb: governance.verb,
        noun: governance.noun,
        decision: governance.decision,
        origin: params.origin,
        parametersMetadata: extractMetadata(params.toolParams),
        outcome: execution.success ? "success" : "error",
        errorMessage: execution.error,
        decisionEntryId: governance.auditEntry.id,
        latencyMs: 0,
        epochId: params.epochId,
        timestamp: params.timestamp,
      },
      tool: entry,
      toolParams: params.toolParams,
    });

    // Record the executed action in the task's per-action detail.
    this.appendActionDetail(params.runId, {
      service: governance.service,
      verb: governance.verb,
      noun: governance.noun,
      outcome: execution.success ? "executed" : "errored",
    });

    return { governance, execution };
  }

  /**
   * Dispatch a tool call to the implementation for the concrete service the
   * model named. Routing reads no token: it keys on the tool's declarative
   * service. The caller resolves that one service's credential and injects it;
   * the executor authenticates with it and never resolves anything itself.
   */
  private async dispatchTool(
    toolName: string,
    toolParams: Record<string, unknown>,
    userId: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const entry = lookupTool(toolName);
    if (!entry) {
      return { success: false, error: `No implementation for tool: ${toolName}` };
    }

    // Control-plane tools operate the local DO,
    // not an external MCP service, so they route to the existing DO methods
    // before credential resolution. `habenula` is a `none` service:
    // resolveServiceCredential would throw for it (no refresh mapping), and its
    // catalog `execute` is an unreachable guard. Reached only on an explicit
    // governance allow, so the operation was confirmed-as-onboarded and audited
    // (decision entry) first, and executeTool writes the outcome entry after.
    if (entry.service === CONTROL_PLANE_SERVICE) {
      return this.dispatchControlPlane(entry.verb, toolParams);
    }

    // Resolve and inject the tool's own service credential. The
    // credential-resolution failure boundary (not-connected / refresh failure)
    // is handled here, in one uniform try/catch — not per service. API errors
    // are caught inside the executor, which returns a result rather than
    // throwing.
    //
    // Every tool today belongs to an OAuth service. Dispatching a tool that
    // belongs to a catalog-declared credential-less (`none`) service is unwired:
    // resolveServiceCredential would throw `No credential refresh mapping`.
    // No `none` service exposes tools yet; the credential-
    // free dispatch branch lands with the first one that does.
    let credential: StoredCredential;
    try {
      credential = await this.resolveServiceCredential(userId, entry.service);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Credential resolution failed";
      return { success: false, error: message };
    }

    // Every executor today wraps its own body and returns { success:false,
    // error } rather than throwing. This try/catch is the defensive backstop:
    // a future executor that rejects must still reach the outcome audit
    // write (Hard Invariant #3 — a failed tool call is recorded), not escape as
    // an unaudited exception that surfaces to the user as a raw 500.
    try {
      return await entry.execute(toolParams, { userId, credential });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Tool execution failed";
      return { success: false, error: message };
    }
  }

  /**
   * Dispatch a `habenula` control-plane tool to its existing DO method
   * (the methods are reused verbatim; the catalog entries
   * carry only governance metadata). Reached only from `dispatchTool` on an
   * explicit governance allow — and only on a run the boundary gate admitted, so
   * an `internal` run — so the operation has already been
   * confirmed-as-onboarded and audited (decision entry) before this runs; the
   * outcome entry is written by `executeTool` after this returns. A governed
   * `habenula_kill` therefore writes its own governed tool-call audit pair AND
   * the `session.end` entries `killSwitch` writes — the effect entries are
   * unchanged. Synchronous: every DO method here is a local SQLite operation.
   */
  private dispatchControlPlane(
    verb: string,
    params: Record<string, unknown>,
  ): { success: boolean; data?: unknown; error?: string } {
    switch (verb) {
      case "status":
        return { success: true, data: this.readStatusForModel() };
      case "kill":
        this.killSwitch();
        return { success: true, data: { killed: true } };
      case "disconnect": {
        // The governed noun (nounExtractor → params.service) and this call read
        // the SAME string, so noun and effect cannot diverge.
        const service = String(params.service);
        return {
          success: true,
          data: { service, disconnected: this.disconnectService(service) },
        };
      }
      case "quit":
        return { success: true, data: this.endSession("quit") };
      case "read":
        return { success: true, data: { entries: this.getStandingEntries() } };
      default:
        // Defensive: an unrouted habenula verb is a catalog/routing drift bug.
        return {
          success: false,
          error: `Unknown habenula control-plane verb: ${verb}`,
        };
    }
  }

  /**
   * Resolve a service's credential using its registered refresh mapping
   * (the module-level REFRESH_FNS map, env bound here at the dispatch site).
   * Throws on an unmapped service so a tool whose service has no refresh
   * mapping fails closed and loud rather than dereferencing undefined. The
   * catalog invariant guarantees a mapping for every oauth-connect service —
   * and its absence for `none`-connect ones — so this throw is unreachable
   * for oauth tools, but a tool added to a `none` service reaches it at
   * runtime until the credential-free dispatch branch lands.
   */
  private resolveServiceCredential(
    userId: string,
    service: string,
  ): Promise<StoredCredential> {
    const refreshFn = REFRESH_FNS[service];
    if (!refreshFn) {
      throw new Error(`No credential refresh mapping for service: ${service}`);
    }

    return this.resolveCredential(userId, service, (old) =>
      refreshFn(old, this.env),
    );
  }

  /**
   * Store OAuth state for a pending authorization flow, superseding any
   * pending row for the same service: a retry after an
   * abandoned attempt starts clean rather than accumulating a second orphan.
   * Delete + insert in one transactionSync (the atomic-write footgun).
   *
   * The delete is pending-only (`status IS NULL`): a `denied` row for the same
   * service is left intact so a client still polling that flow can observe the
   * denial. It is cleaned up by that client's cancel, not by this supersede.
   */
  storeOAuthState(stateKey: string, data: OAuthStateData): void {
    this.ctx.storage.transactionSync(() => {
      oauthStateData.deleteOAuthStateByService(this.sqlTag, data.service);
      oauthStateData.insertOAuthState(this.sqlTag, stateKey, data);
    });
  }

  /** Read OAuth state without consuming it. Returns null if expired or not found. */
  loadOAuthState(stateKey: string): OAuthStateData | null {
    const row = oauthStateData.readOAuthState(this.sqlTag, stateKey);
    if (row === null) return null;
    if (isOAuthStateExpired(row.expires_at)) return null;
    return row;
  }

  /**
   * Read OAuth state without the expiry filter. The callback's deny stamp
   * reads through this rather than `loadOAuthState`: a flow that lapsed after
   * authorize must still be stamped `denied` rather than silently degrading
   * to `expired`, and `loadOAuthState` filters an
   * expired row to null.
   */
  loadOAuthStateRaw(stateKey: string): OAuthStateData | null {
    return oauthStateData.readOAuthState(this.sqlTag, stateKey);
  }

  /**
   * Stamp a pending flow denied so the CLI's status poll can observe the
   * denial. A stamp, not a delete — an immediate
   * delete would read as row-absent (still pending) to the status derivation;
   * the observing CLI deletes via `cancelOAuthFlow` once it has reported the
   * outcome. No-op on an absent key.
   *
   * `denied` is an observation, not a lock: `consumeOAuthState` does not
   * inspect `status`, so a stamped row stays consumable by a later approve on
   * the same `state` (the user denied, went back, then approved — re-consent
   * succeeds). Whether that approve lands is a race with the observing CLI's
   * cancel: cancel-first deletes the row and the approve then 400s; approve-
   * first connects. Intended — deny is reversible until the row is dropped.
   *
   * Precondition: the caller must have already resolved the flow's service and
   * verified it belongs to this callback's provider strategy. The stamp keys on
   * `state_key` alone (no service predicate), so it trusts that guard — the sole
   * caller, the callback's `?error=` branch, performs it before calling here.
   */
  markOAuthFlowDenied(randomPart: string): void {
    oauthStateData.markOAuthStateDenied(this.sqlTag, randomPart);
  }

  /**
   * Cancel a pending connect flow: delete its `oauth_state` row. Idempotent —
   * returns whether a row existed, an observability signal no client branches
   * on. Read + delete in one transactionSync, mirroring `consumeOAuthState`,
   * so a cancel racing the callback's consume composes safely: whichever runs
   * first, the loser finds no row and no-ops. Touches only `oauth_state` —
   * never `connected_services` — so a cancel can never destroy a completed
   * connection.
   */
  cancelOAuthFlow(randomPart: string): boolean {
    let existed = false;
    this.ctx.storage.transactionSync(() => {
      const row = oauthStateData.readOAuthState(this.sqlTag, randomPart);
      if (row === null) return;
      oauthStateData.deleteOAuthState(this.sqlTag, randomPart);
      existed = true;
    });
    return existed;
  }

  /**
   * The per-flow status read behind `GET /api/connect/status`.
   * Synchronous — no interior await — so the two reads are one
   * consistent snapshot under DO input gates.
   *
   * Reads the row via the raw helper, never `loadOAuthState`: the public
   * loader filters an expired row to null, which would collapse the `expired`
   * branch into the row-absent path and misreport a lapsed first-connect as
   * `pending` until the CLI's own timeout.
   *
   * Derivation order: a present row (for the requested service) reports its
   * own state — `denied` (the callback's stamp wins even over a lapsed
   * expiry), then `expired`, else `pending`. An absent row is what a flow
   * looks like mid-completion (the callback consumes before the token
   * exchange), so absence is non-terminal: `connected` only once the service
   * appears in `connected_services`, else still `pending`. A loaded row whose
   * `service` differs from the requested one is treated as row-absent, so a
   * mismatched (service, flow) pair — a client-side bug — never leaks the
   * *other* service's pending/denied/expired state. It does still fall through
   * to the requested service's connection check, so a mismatch can return a
   * misleading `connected`/`pending` for the service that was asked about (the
   * flow named is not actually that service's). That is strictly a caller bug —
   * a correct client always pairs the `flow` handle with the service it began —
   * and stays narrow under single-session.
   *
   * Known floor — reconnect false-`connected`: success is a row deletion, so
   * there is no per-flow record that *this* flow completed. When the service
   * was already connected before the flow began (a reconnect), any path that
   * drops this flow's row without completing it — supersede by a newer flow,
   * or cancel — leaves absence + service-connected, which reads `connected`.
   * A client still polling that superseded/cancelled reconnect flow therefore
   * sees a false success. Distinguishing it would require tracking which flow
   * last connected the service; deferred to a follow-up
   * that also adds the exchange-failure stamp. Narrow under single-session
   * (one flow at a time). See `oauth-credentials.md`.
   */
  readConnectFlowStatus(
    service: string,
    randomPart: string,
  ): "pending" | "connected" | "denied" | "expired" {
    const row = oauthStateData.readOAuthState(this.sqlTag, randomPart);
    if (row !== null && row.service === service) {
      if (row.status === "denied") return "denied";
      if (isOAuthStateExpired(row.expires_at)) return "expired";
      return "pending";
    }
    return connectedServicesData.isServiceConnected(this.sqlTag, service)
      ? "connected"
      : "pending";
  }

  /**
   * Atomically consume OAuth state: read + delete in a single transaction.
   * Returns null if expired, not found, or already consumed.
   */
  consumeOAuthState(stateKey: string): OAuthStateData | null {
    let result: OAuthStateData | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = oauthStateData.readOAuthState(this.sqlTag, stateKey);
      if (row === null) return;
      if (isOAuthStateExpired(row.expires_at)) {
        oauthStateData.deleteOAuthState(this.sqlTag, stateKey);
        return;
      }
      oauthStateData.deleteOAuthState(this.sqlTag, stateKey);
      result = row;
    });
    return result;
  }

  private migrate(): void {
    // Schema creation runs from the DDL registry (data/ddl.ts) — the single
    // source of truth that codegen also parses. A tagged template cannot
    // execute a dynamic SQL string (`this.sql`${ddl}`` would bind ddl as a
    // parameter), so schema DDL runs via storage.sql.exec.
    for (const { ddl, indexes } of Object.values(TABLES)) {
      this.ctx.storage.sql.exec(ddl);
      for (const index of indexes) {
        this.ctx.storage.sql.exec(index);
      }
    }
    // Column-type migration: oauth_state's created_at/expires_at moved from
    // UNIX-seconds INTEGER to ISO-8601 TEXT. SQLite cannot change a declared
    // column type in place, and `CREATE TABLE IF NOT EXISTS` leaves an existing
    // DO's table on the old types, so recreate it from the registry DDL. There
    // is nothing to convert: every row is an in-flight authorization with a
    // ~10-minute TTL, so dropping them reads to a client exactly like the
    // abandoned flow it retries. Runs before the additive-column block below,
    // which re-reads the table it may have just replaced. Guarded on the
    // declared type, so a re-run is a no-op.
    //
    // This is the pattern for a type change, distinct from the additive-column
    // one: only correct on a table whose rows are disposable. A table carrying
    // durable rows needs a copy-through rebuild instead.
    const timestampType = [
      ...this.ctx.storage.sql.exec(`PRAGMA table_info(oauth_state)`),
    ].find((c) => c.name === "created_at")?.type;
    if (timestampType !== undefined && timestampType !== "TEXT") {
      this.ctx.storage.sql.exec(`DROP TABLE oauth_state`);
      this.ctx.storage.sql.exec(TABLES.oauth_state.ddl);
    }
    // Additive-column migration: the DDL registry runs
    // `CREATE TABLE IF NOT EXISTS`, so an existing DO's oauth_state keeps its
    // earlier column set — a new column must be ALTERed in, guarded by a
    // PRAGMA existence check so the re-run is a no-op. This is the pattern for
    // any additive column on an existing table; it lives here in the
    // data/cleanup section because the registry cannot express it.
    const oauthStateColumns = [
      ...this.ctx.storage.sql.exec(`PRAGMA table_info(oauth_state)`),
    ];
    if (!oauthStateColumns.some((c) => c.name === "status")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE oauth_state ADD COLUMN status TEXT CHECK(status IN ('denied'))`,
      );
    }
    // Additive columns for the task queue. Same pattern:
    // an existing DO's tables predate these columns, so ALTER them in, guarded by
    // a PRAGMA existence check. All are nullable except held_tool_calls.hold_kind,
    // which carries a non-null DEFAULT so the ALTER backfills existing rows. The
    // widened origin/status CHECK sets on commission_runs apply only to freshly
    // created tables — SQLite cannot alter a CHECK in place — which is correct
    // for the cutover (DOs are recreated) and safe on any surviving
    // DO because the current code writes no `human` origin and no `needs_input`/`cancelled`
    // status.
    const addColumn = (table: string, column: string, ddl: string): void => {
      const cols = [...this.ctx.storage.sql.exec(`PRAGMA table_info(${table})`)];
      if (!cols.some((c) => c.name === column)) {
        this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    };
    addColumn("commission_runs", "label", "label TEXT");
    addColumn("commission_runs", "status_detail", "status_detail TEXT");
    addColumn("commission_runs", "awaited_slot_keys", "awaited_slot_keys TEXT");
    addColumn(
      "held_tool_calls",
      "hold_kind",
      "hold_kind TEXT NOT NULL DEFAULT 'confirmation' CHECK(hold_kind IN ('confirmation','input'))",
    );
    addColumn("held_tool_calls", "awaited_slot_keys", "awaited_slot_keys TEXT");
    // Additive column for the spend hold. Same pattern:
    // existing dev DOs predate it. Nullable — only money-verb holds carry it.
    addColumn("held_tool_calls", "spend_context", "spend_context TEXT");
    // Data/cleanup below is NOT schema — it must never enter the DDL registry.
    // Kept here in the original migrate() order.
    this.sql`DROP TABLE IF EXISTS policy_overrides`;
    this.sql`
      INSERT OR IGNORE INTO policy_entries (id, source, service, verb, noun, decision, priority, created_at)
      VALUES (${WILDCARD_DENY_ID}, 'standing', '*', '*', '*', 'deny', 0, ${new Date().toISOString()})
    `;
    this.sql`DELETE FROM user_settings WHERE key = 'default_policy'`;
    this.assertDenyFloor();
  }

  /**
   * Prove the deny floor on every boot.
   *
   * The seed above uses `INSERT OR IGNORE`, which silently succeeds if a row
   * with id='default-deny' already exists — even if that row has been corrupted
   * to the wrong properties. This reads the
   * floor row back and validates every property the engine relies on to fall
   * closed: a deny decision over the wildcard scope at floor priority. On any
   * mismatch it throws, so the DO fails loudly at startup rather than evaluating
   * policy against a broken floor.
   *
   * Public so tests can invoke it directly after tampering with the floor row
   * on a real DO.
   */
  assertDenyFloor(): void {
    const floor = policyEntriesData.readPolicyEntryScope(
      this.sqlTag,
      WILDCARD_DENY_ID,
    );

    if (floor === null) {
      throw new Error(
        `Deny floor corrupted: entry '${WILDCARD_DENY_ID}' is missing`,
      );
    }
    const expected = {
      decision: "deny",
      service: "*",
      verb: "*",
      noun: "*",
      priority: 0,
    };

    const mismatches: string[] = [];
    if (floor.decision !== expected.decision) {
      mismatches.push(`decision=${floor.decision} (expected deny)`);
    }
    if (floor.service !== expected.service) {
      mismatches.push(`service=${floor.service} (expected *)`);
    }
    if (floor.verb !== expected.verb) {
      mismatches.push(`verb=${floor.verb} (expected *)`);
    }
    if (floor.noun !== expected.noun) {
      mismatches.push(`noun=${floor.noun} (expected *)`);
    }
    if (floor.priority !== expected.priority) {
      mismatches.push(`priority=${floor.priority} (expected 0)`);
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Deny floor corrupted: entry '${WILDCARD_DENY_ID}' has ${mismatches.join(", ")}`,
      );
    }
  }

  /**
   * Query policy entries matching the given session + action, including
   * wildcard matches. Filters out expired entries. Ordered by priority DESC
   * so the first match wins in evaluatePolicy.
   *
   * Expiry comparison uses `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, not
   * `datetime('now')`. `expires_at` is stored as a JS ISO 8601 string
   * (`Date.toISOString()` → `2026-06-16T17:00:00.000Z`), while
   * `datetime('now')` returns a space-separated form
   * (`2026-06-16 17:00:00`). SQLite compares TEXT lexicographically, and
   * `'T'` (0x54) > `' '` (0x20), so `expires_at > datetime('now')` is
   * always true — every grant would read as unexpired. Matching the ISO
   * shape on both sides makes the comparison correct.
   */
  queryPolicyEntries(sessionId?: string): PolicyEntry[] {
    const rows = policyEntriesData.selectActivePolicyEntries(
      this.sqlTag,
      sessionId ?? null,
    );
    return rows.map((r) => this.toPolicyEntry(r));
  }

  /** Return all standing policy entries for API display. */
  getStandingEntries(): PolicyEntry[] {
    const rows = policyEntriesData.selectStandingEntries(this.sqlTag);
    return rows.map((r) => this.toPolicyEntry(r));
  }

  /** Map a raw policy_entries row to the governance domain shape. */
  private toPolicyEntry(
    r: policyEntriesData.ActivePolicyEntryRow,
  ): PolicyEntry {
    return {
      id: r.id,
      source: r.source,
      sessionId: r.session_id ?? undefined,
      service: r.service,
      verb: r.verb,
      noun: r.noun,
      decision: r.decision,
      priority: r.priority,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? undefined,
    };
  }

  /**
   * Single guarded chokepoint for all grant creation from user input.
   * Rejects any wildcard (`*`) in service, verb, or noun
   * so a user choice can never mint a permanent-allow-equivalent. Centralizing
   * the guard here (rather than at each insert) means it cannot be bypassed or
   * forgotten as grant scopes are added — there is one place where a user's
   * choice becomes permission state.
   */
  private assertScopedGrant(service: string, verb: string, noun: string): void {
    if (service === "*" || verb === "*" || noun === "*") {
      throw new Error(
        `Refusing wildcard grant scope (${service}/${verb}/${noun}): grants must be fully scoped.`,
      );
    }
  }

  /**
   * Create a session-scoped grant. Lifetime is anchored to the session's
   * recorded start (`session_state.started_at + 90 min`), so every
   * session-scoped grant in one session shares the same expiry with no drift
   * — falls back to now()+90min if the session has no
   * recorded start (defensive — resolveActiveSession() normally precedes this).
   * Returns the entry ID.
   */
  createSessionGrant(
    service: string,
    verb: string,
    noun: string,
    sessionId: string,
    decision: "allow" | "deny" = "allow",
  ): string {
    this.assertScopedGrant(service, verb, noun);
    const id = crypto.randomUUID();
    const now = new Date();
    const startedAt = this.sessionStartedAt(sessionId) ?? now;
    const expiresAt = new Date(
      startedAt.getTime() + SESSION_LIFETIME_MS,
    ).toISOString();
    policyEntriesData.insertSessionGrant(this.sqlTag, {
      id,
      sessionId,
      service,
      verb,
      noun,
      decision,
      createdAt: now.toISOString(),
      expiresAt,
    });
    return id;
  }

  /**
   * Create a task-scoped grant: a single-use grant consumed the instant it
   * authorizes its one call. No expiry — bounded by
   * `consumed_at` instead. Returns the entry ID.
   */
  createTaskGrant(
    service: string,
    verb: string,
    noun: string,
    sessionId?: string,
    decision: "allow" | "deny" = "allow",
  ): string {
    this.assertScopedGrant(service, verb, noun);
    // Bind the grant to its minting session so it can never surface under a
    // later session; consumed atomically, so it never lingers. The
    // production path (resolveConfirmation) passes the held call's session
    // explicitly; a task grant with no resolvable session is a bug, not a
    // session-less grant — fail closed.
    const boundSession = sessionId ?? this.getActiveSession()?.sessionId;
    if (!boundSession) {
      throw new Error("createTaskGrant: no session to bind the grant to");
    }
    const id = crypto.randomUUID();
    policyEntriesData.insertTaskGrant(this.sqlTag, {
      id,
      sessionId: boundSession,
      service,
      verb,
      noun,
      decision,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  /**
   * Mark a task grant consumed. Committed BEFORE the tool executes (the same
   * fail-closed ordering as audit-before-execute): a crash mid-execution can
   * never leave an unconsumed row that re-authorizes on retry. The evaluator
   * excludes consumed rows at read time, so the grant is inert the moment this
   * commits, regardless of physical deletion.
   */
  consumeTaskGrant(entryId: string): void {
    policyEntriesData.consumeTaskGrant(
      this.sqlTag,
      entryId,
      new Date().toISOString(),
    );
  }

  // ----- Session establishment -----

  /**
   * Read a session's recorded start instant, or null if not established OR
   * unparseable. Returning null on a malformed `started_at` (rather than an
   * Invalid Date) is the central safety guard: every caller — the reaper,
   * loadHeldCall, heldCallId, createSessionGrant — treats null as
   * "not established / not expired" and skips, instead of propagating a NaN
   * that would later throw `RangeError` from `new Date(NaN).toISOString()` at
   * the top of chat()/executeTool() and brick the DO.
   */
  private sessionStartedAt(sessionId: string): Date | null {
    const startedAt = sessionStateData.readSessionStartedAt(
      this.sqlTag,
      sessionId,
    );
    if (startedAt === null) return null;
    const d = new Date(startedAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ----- Single active session -----

  /**
   * Insert a new DO-owned session row + its `session.start` audit event.
   * Caller MUST already hold a `transactionSync` — this composes the bare
   * helpers, it opens no transaction of its own. Returns the row's
   * generated id and start instant.
   */
  private createSessionInTxn(
    userId: string,
    agentId: string,
    origin: AuditOrigin = "human",
  ): { sessionId: string; startedAt: string } {
    const sessionId = `session-${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    sessionStateData.insertSessionState(this.sqlTag, sessionId, startedAt, agentId);
    auditLogData.insertAuditEntryInTxn(this.sqlTag, {
      userId,
      agentId,
      sessionId,
      toolName: "session.start",
      service: "session",
      verb: "start",
      noun: "-",
      decision: "allow",
      origin,
      parametersMetadata: {},
      outcome: "success",
      latencyMs: 0,
      costUsd: undefined,
      timestamp: startedAt,
    });
    return { sessionId, startedAt };
  }

  /**
   * Close one session row inside the caller's transaction: sweep its held
   * calls to terminal denied outcomes (else a parked call stays approvable
   * against a dead session), write `session.end`, and stamp `ended_at` — the
   * same three-step close the reaper and kill perform. Composes bare helpers;
   * the caller owns the `transactionSync`.
   */
  private endSessionRowInTxn(
    sessionId: string,
    reason: "quit" | "superseded",
    timestamp: string,
  ): void {
    for (const h of heldToolCallsData.selectHeldCallsForSession(
      this.sqlTag,
      sessionId,
    )) {
      // Skip a mid-resolve row (see turnStateHasResolution for the full
      // rationale + accepted residual): the resolve path owns its terminal
      // outcome. The row is still deleted below — nothing survives session end.
      if (!this.turnStateHasResolution(h.turn_state)) {
        this.writeHeldTimeoutOutcome(h.pending_audit_entry_id, timestamp);
      }
      heldToolCallsData.deleteHeldToolCall(this.sqlTag, h.id);
    }
    const identity = this.sessionIdentity(sessionId);
    if (identity) {
      this.writeSessionEnd({ identity, reason, timestamp });
    }
    commissionRunsData.markRunsExpiredForSession(this.sqlTag, sessionId, timestamp);
    sessionStateData.markSessionEnded(this.sqlTag, sessionId, timestamp);
  }

  /**
   * Row → boundary view: camelCase fields plus the computed 90-min expiry.
   * NaN-guarded like `sessionStartedAt`: a poisoned `started_at` (unparseable
   * value) yields `expiry: null` instead of `new Date(NaN).toISOString()`
   * throwing RangeError. Defense-in-depth: the reaper now ends poisoned rows
   * at observation time, so the reaping callers (startSession,
   * getActiveSession) should never see one — this guard covers any future
   * non-reaping caller.
   */
  private activeSessionView(row: {
    session_id: string;
    started_at: string;
  }): ActiveSessionView {
    const startMs = new Date(row.started_at).getTime();
    return {
      sessionId: row.session_id,
      startedAt: row.started_at,
      expiry: Number.isNaN(startMs)
        ? null
        : new Date(startMs + SESSION_LIFETIME_MS).toISOString(),
    };
  }

  /**
   * Resolve the active session, creating one if none — the single
   * derive-or-create path. Runs in ONE `transactionSync`
   * with no intervening `await`: the "is there an active session?" read and the
   * insert are a gap-free synchronous region, and that is what enforces the
   * single-active invariant (nothing at the DB level guarantees ≤1 un-ended
   * row). Do not split this across an await.
   *
   * Tie-break: if more than one un-ended row exists (an invariant break, or
   * accumulated pre-cutover state), the newest wins and every OTHER open row is
   * ended via `endSessionRowInTxn` with reason `superseded` — held calls swept,
   * `session.end` written — so a broken invariant leaves durable evidence
   * rather than a silent swallow. `agentId` is used only when creating; the
   * attach path selects by `ended_at IS NULL` alone (the single hardcoded
   * agent today — a future multi-agent reader should not assume agent-scoped attach).
   *
   * Reaps expired sessions itself before the derive, so it can never attach
   * to (and silently extend) a session past its 90-minute cap — a future
   * caller (the commission method) cannot get this wrong by construction.
   * Callers that already reaped for their own ordering (chat's
   * reap-before-held-guard) just make this pass an idempotent no-op. The reap
   * runs before the transaction below with no intervening await, so the
   * synchronous region stays gap-free.
   */
  resolveActiveSession(params: {
    userId: string;
    agentId: string;
    /** Tags a *created* session's session.start; attach ignores it. */
    origin?: AuditOrigin;
  }): string {
    this.reapExpiredSessions();
    return this.ctx.storage.transactionSync(() => {
      const active = sessionStateData.selectActiveSession(this.sqlTag);
      if (active) {
        const now = new Date().toISOString();
        for (const s of sessionStateData.selectOpenSessions(this.sqlTag)) {
          if (s.session_id === active.session_id) continue;
          this.endSessionRowInTxn(s.session_id, "superseded", now);
        }
        return active.session_id;
      }
      return this.createSessionInTxn(params.userId, params.agentId, params.origin)
        .sessionId;
    });
  }

  /**
   * The interactive-launch handshake. Reaps expired
   * sessions first, so a launch after the 90-minute lifetime is not refused
   * against a session that already timed out. Then, in one `transactionSync`:
   * if a session is active, refuse (create no second row) and return it; else
   * create one and return it started. The DO-level refusal is the guarantee —
   * no second `session_state` row — independent of what the client does with it.
   */
  startSession(params: { userId: string; agentId: string }): StartSessionResult {
    this.reapExpiredSessions();
    return this.ctx.storage.transactionSync(() => {
      const active = sessionStateData.selectActiveSession(this.sqlTag);
      if (active) {
        return { status: "refused", activeSession: this.activeSessionView(active) };
      }
      const { sessionId, startedAt } = this.createSessionInTxn(
        params.userId,
        params.agentId,
      );
      return {
        status: "started",
        activeSession: this.activeSessionView({
          session_id: sessionId,
          started_at: startedAt,
        }),
      };
    });
  }

  /**
   * End the active session explicitly (`quit`), freeing the slot without
   * waiting out the 90-minute timeout. Idempotent: `{ ended: false }` when none
   * is active. Sweeps held calls as part of the close (`endSessionRowInTxn`).
   * Reaps first, like every other session entry point: a quit arriving after
   * the 90-minute cap must record the session's end as `timeout` at the
   * effective expiry instant (the reaper's documented invariant) and report
   * `{ ended: false }` — not stamp `quit` at wall-clock hours later.
   */
  endSession(reason: "quit"): EndSessionResult {
    this.reapExpiredSessions();
    return this.ctx.storage.transactionSync(() => {
      const active = sessionStateData.selectActiveSession(this.sqlTag);
      if (!active) return { ended: false };
      // Ends the newest active row only — deliberately asymmetric with
      // resolveActiveSession's tie-break sweep. Multiple un-ended rows are an
      // invariant break the next derive detects and repairs (superseded);
      // quit's job is only the active session.
      this.endSessionRowInTxn(active.session_id, reason, new Date().toISOString());
      return { ended: true };
    });
  }

  /**
   * The active session for `habenula status`, or null. Reaps expired sessions
   * first so it never reports a timed-out session as active or computes a
   * negative remaining time.
   */
  getActiveSession(): ActiveSessionView | null {
    this.reapExpiredSessions();
    const active = sessionStateData.selectActiveSession(this.sqlTag);
    return active ? this.activeSessionView(active) : null;
  }

  /**
   * The aggregate governed-session view for `GET /api/status` and the reactive
   * confirmation prompt: the active
   * session, its active grants, every pending held call as render-ready
   * records (oldest first — the first is the next to answer), and the audit
   * chain's tail — all read in this single DO invocation
   * with no intervening await, so they are an atomic snapshot rather than
   * separately-observed states. Session, grants, and held are keyed to the
   * same active session; with no active session there is nothing to grant or
   * hold, so grants/held are empty. The audit tail is session-independent and
   * is reported either way.
   *
   * The session view reuses `activeSessionView` (via `getActiveSession`, which
   * also reaps) so expiry math is shared with `GET /api/session`, never
   * recomputed. Grants are filtered to `source IN ('session','task')` — the
   * standing deny-floor is not a grant. Held records are derived through the
   * same registry primitives `resolveConfirmation` uses; a not-yet-renderable
   * row (empty/corrupt `turn_state`) is omitted from the list.
   */
  /**
   * `readStatus` for the MODEL — the governed `habenula status` tool result,
   * which is serialized into the LLM's context.
   *
   * The spending block is stripped. Limits and running totals are read
   * engine-side and rendered only in the human-facing confirmation:
   * an agent that learns its remaining headroom can size
   * every order just under the cap and never trigger a confirmation again.
   * Holds are no longer one-per-DO, so without this projection a concurrently
   * parked spend hold would carry `limitCents`/`spentCents` into the context
   * of an unrelated turn. The reason survives — the agent may know its call is
   * awaiting a spending decision, just not what the ceiling is.
   */
  readStatusForModel(): StatusResponse {
    const status = this.readStatus();
    return {
      ...status,
      held: status.held.map((record) =>
        record.spend
          ? {
              ...record,
              spend: {
                amountCents: record.spend.amountCents,
                reason: record.spend.reason,
                breaches: [],
              },
            }
          : record,
      ),
    };
  }

  readStatus(): StatusResponse {
    // getActiveSession() reaps expired sessions, which can write session.end /
    // held-timeout rows to the audit log. Read the tail AFTER that (and after
    // the held read below) so the four values are a true atomic snapshot
    // — not a tail captured one entry before the reap.
    const session = this.getActiveSession();
    if (!session) {
      // The tail is read in both branches deliberately: the self-host
      // persistence proof reads it right after a
      // container recreation, before any new session exists.
      return { session: null, grants: [], held: [], auditTail: this.readAuditTail() };
    }
    const grants: GrantView[] = policyEntriesData
      .selectActiveGrants(this.sqlTag, session.sessionId)
      .map((row) => ({
        service: row.service,
        verb: row.verb,
        noun: row.noun,
        // selectActiveGrants filters to these two sources, so the narrowing
        // holds; `standing` never reaches here.
        source: row.source as "session" | "task",
        expiresAt: row.expires_at,
      }));
    const held = this.readPendingHeldRecords();
    return { session, grants, held, auditTail: this.readAuditTail() };
  }

  /**
   * The audit chain's tail — the newest entry's `hash`/`prevHash`, or null
   * for an empty log. One indexed read: the LIMIT 1
   * walk of the `(epoch_id, sequence_num)` unique index from its high end,
   * independent of log size — this rides on every `/api/status` poll.
   */
  private readAuditTail(): AuditTail {
    const tail = auditLogData.selectRecentAuditEntries(this.sqlTag, 1)[0];
    return tail ? { hash: tail.hash, prevHash: tail.prev_hash } : null;
  }

  /**
   * The visual-model snapshot for `GET /api/dev/model`: session,
   * the evaluator's active policy set (deny floor included), the pending held
   * call with its row joins, recent commission runs, connected services, the
   * recent audit window, and per-table row counts — read in this single DO
   * invocation with no intervening await, so every field observes the same
   * instant. Reaps first (via `getActiveSession`), like every session entry
   * point.
   *
   * Sanitization is by construction: the credential column never enters a
   * SELECT list on this path (`listConnectedServicesWithCredentialPresence`
   * projects presence only), `oauth_state` and `user_settings` surface as
   * counts alone, and audit parameters are the stored metadata summary.
   */
  readModelSnapshot(userId: string): GovernanceSnapshotResponse {
    const session = this.getActiveSession();
    const policyEntries = policyEntriesData
      .selectActivePolicyEntries(this.sqlTag, session?.sessionId ?? null)
      .map((row) => ({
        id: row.id,
        source: row.source,
        service: row.service,
        verb: row.verb,
        noun: row.noun,
        decision: row.decision,
        priority: row.priority,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        sessionId: row.session_id,
      }));
    // The render-ready pending records plus their row-level joins. Each row is
    // re-read through the same primitives readPendingHeldRecords used; both
    // reads sit in this one synchronous invocation, so they observe the same
    // state.
    const held: HeldCallDetailRecord[] = [];
    for (const pending of this.readPendingHeldRecords()) {
      const row = this.loadHeldCall(pending.heldCallId);
      if (row) {
        held.push({
          ...pending,
          sessionId: row.sessionId,
          heldAt: row.heldAt,
          runId: row.runId,
        });
      }
    }
    const commissions = commissionRunsData
      .selectRecentCommissionRuns(this.sqlTag, SNAPSHOT_WINDOW)
      .map((row) => ({
        id: row.id,
        origin: row.origin,
        goal: row.goal,
        data: row.data,
        status: row.status,
        sessionId: row.session_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    const connectedServices = connectedServicesData
      .listConnectedServicesWithCredentialPresence(this.sqlTag)
      .map((row) => ({
        service: row.service,
        connectedAt: row.connected_at,
        hasCredential: row.has_credential !== 0,
      }));
    const audit = auditLogData
      .selectRecentAuditEntries(this.sqlTag, SNAPSHOT_WINDOW)
      .map((row) => ({
        id: row.id,
        epochId: row.epoch_id,
        sequenceNum: row.sequence_num,
        timestamp: row.timestamp,
        agentId: row.agent_id,
        sessionId: row.session_id,
        toolName: row.tool_name,
        service: row.service,
        verb: row.verb,
        noun: row.noun,
        decision: row.decision,
        outcome: row.outcome,
        origin: row.origin,
        parametersMetadata: row.parameters_metadata,
        errorMessage: row.error_message,
        decisionEntryId: row.decision_entry_id,
        latencyMs: row.latency_ms,
        costUsd: row.cost_usd,
        hash: row.hash,
        prevHash: row.prev_hash,
      }));
    const count = (table: tableCountsData.CountableTable) =>
      tableCountsData.countRows(this.sqlTag, table);
    return {
      userId,
      generatedAt: new Date().toISOString(),
      session,
      policyEntries,
      held,
      commissions: { recent: commissions, total: count("commission_runs") },
      connectedServices,
      audit: { recent: audit, total: count("audit_log") },
      tableCounts: {
        auditLog: count("audit_log"),
        connectedServices: count("connected_services"),
        userSettings: count("user_settings"),
        oauthState: count("oauth_state"),
        policyEntries: count("policy_entries"),
        heldToolCalls: count("held_tool_calls"),
        commissionRuns: count("commission_runs"),
        sessionState: count("session_state"),
        spendLedger: count("spend_ledger"),
      },
    };
  }

  /**
   * The first instant of the current UTC calendar month, as the ISO string the
   * ledger's month-window sum compares against (the
   * month boundary is computed here, never inside the pure evaluator).
   */
  private monthStartIso(): string {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
  }

  /**
   * The spend-settings read behind `GET /api/settings`:
   * both limits with their defaults-applied flags, plus the current window
   * sums so one read renders `habenula cap` in full. Limits are read from
   * storage at each call, never cached — a lowered cap binds the next check.
   * The session sum is 0 with no active session (nothing to sum by).
   */
  readSpendSettings(): SettingsResponse {
    const limits = userSettingsData.readSpendLimitsCents(this.sqlTag);
    const session = this.getActiveSession();
    return {
      monthLimitCents: limits.monthLimitCents,
      sessionLimitCents: limits.sessionLimitCents,
      monthIsDefault: limits.monthIsDefault,
      sessionIsDefault: limits.sessionIsDefault,
      monthSpentCents: spendLedgerData.sumMonthSpendCents(
        this.sqlTag,
        this.monthStartIso(),
      ),
      sessionSpentCents: session
        ? spendLedgerData.sumSessionSpendCents(this.sqlTag, session.sessionId)
        : 0,
    };
  }

  /**
   * The spend-settings write behind `POST /api/settings`. A field omitted
   * leaves that limit as it stands; the contract guarantees non-negative
   * integer cents and at least one field. Returns the post-write read so the
   * caller renders the state it just created.
   */
  writeSpendLimits(update: {
    monthLimitCents?: number;
    sessionLimitCents?: number;
  }): SettingsResponse {
    if (update.monthLimitCents !== undefined) {
      userSettingsData.setSetting(
        this.sqlTag,
        userSettingsData.SPEND_LIMIT_MONTHLY_KEY,
        String(update.monthLimitCents),
      );
    }
    if (update.sessionLimitCents !== undefined) {
      userSettingsData.setSetting(
        this.sqlTag,
        userSettingsData.SPEND_LIMIT_SESSION_KEY,
        String(update.sessionLimitCents),
      );
    }
    return this.readSpendSettings();
  }

  /**
   * Every pending held call as a render-ready record, oldest first — the
   * status snapshot's `held` list. The engine parks at most one confirmation
   * per task, but several tasks (the human conversation plus each commission
   * run) can each own one, so the list can hold several; the first entry is
   * the next one to answer. `unresolvedHeldCallIds()` supplies the candidates
   * and already skips expired rows and rows carrying an `answered` payload;
   * `pendingHeldRecordFor` drops the rest (mid-resolve, unrenderable). Every
   * parked call genuinely awaiting a decision appears here — a hold this list
   * omits is a question the user is never shown, which is the defect this
   * read exists to prevent.
   */
  private readPendingHeldRecords(): HeldCallRecord[] {
    const records: HeldCallRecord[] = [];
    for (const heldCallId of this.unresolvedHeldCallIds()) {
      const record = this.pendingHeldRecordFor(heldCallId);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * One pending held call as a render-ready record, or null. The candidate ids
   * already skip expired rows and rows carrying an `answered` payload; this
   * method additionally skips a row that is mid-resolve
   * but not yet answered (`dispatched: true`) — the narrow window where
   * `resolveConfirmation` has committed the dispatch flag and is awaiting the
   * tool round-trip. Such a call is already executing, not awaiting a decision,
   * so it must never render as a fresh confirmation prompt (it would mislead a
   * concurrent reader; a re-resolve is caught by the crash-after-dispatch
   * recovery path, so it is not a safety bug — but the display would be wrong).
   * A crash inside that window used to leave the row behind, where this skip and
   * the chat guard's non-skip disagreed permanently; the chat path now heals such
   * a row before the guard reads it (`healCrashedDispatchHolds`), so
   * the skip only ever hides a genuinely in-flight resolve.
   *
   * It then derives `(service, verb, noun)` through the tool registry — the same
   * `lookupTool` + `nounExtractor` primitives `resolveConfirmation` derives from
   * (invoked directly here; no change to `resolveConfirmation`). The noun is
   * returned verbatim — `nounExtractor` is non-validating,
   * so an adversarial label flows through unchanged and the CLI sanitizes it at
   * render. A row whose `turn_state` is still empty (or corrupt) is not yet
   * renderable → null. A tool that has left the registry renders
   * `unknown · execute · unknown` (the same fallback `resolveConfirmation` uses),
   * which the CLI marks unresolvable.
   */
  private pendingHeldRecordFor(heldCallId: string): HeldCallRecord | null {
    const held = this.loadHeldCall(heldCallId);
    if (!held) return null;
    const parsed = parseTurnState(held.turnState);
    if (!parsed.ok) return null;
    const turnState = parsed.state;
    if (!turnState.heldCall) return null;
    // Mid-resolve (dispatched or answered) → not awaiting a decision → not a
    // renderable pending confirmation.
    if (turnState.dispatched === true || turnState.answered !== undefined) return null;
    const heldCall = turnState.heldCall;
    const registry = lookupTool(heldCall.name);
    // A commissioned hold (non-null run_id) parks the model's RAW input and
    // must render the substituted real value plus the commission's origin/goal
    // — read the run row ONCE and reuse
    // it for both the substitution and the goal.
    const run = held.runId
      ? commissionRunsData.readCommissionRun(this.sqlTag, held.runId)
      : null;
    const input = run?.data
      ? substituteDataPlaceholders(
          heldCall.input,
          JSON.parse(run.data) as Record<string, string>,
        )
      : heldCall.input;
    // `params` carries the call's raw input by design: this is the approval
    // surface, and the user must see exactly what they are authorizing before
    // granting. It is a deliberate exception to the metadata-only default (which
    // governs the audit log and telemetry, not the confirmation prompt). The
    // CLI sanitizes it at render, the same treatment the noun gets above.
    const record: HeldCallRecord = {
      heldCallId: held.id,
      service: registry?.service ?? "unknown",
      verb: registry?.verb ?? "execute",
      noun: registry ? registry.nounExtractor(input) : "unknown",
      params: input,
    };
    // Origin is keyed to the run_id LINK, not the row read: a non-null run_id
    // already proves the hold is commissioned, so the
    // `↑ incoming` badge must show even if the row is unreadable — origin is
    // "either absent (CLI-direct) or correct, never wrong".
    // The goal (external-agent-authored, sanitized at render)
    // is the only part that needs the row; a missing/dataless run just omits it.
    if (held.runId) {
      record.origin = "mcp_commission";
      if (run) record.goal = run.goal;
    }
    // A spend hold renders its amounts: the priced total,
    // the reason, and each breached window with limit and running total —
    // engine-computed integers, trusted chrome at render. A context that will
    // not validate still renders AS a spending hold (the row is one), with the
    // amounts withheld rather than shipped as undefined — the strict response
    // contract would otherwise pass `{}` through and the CLI would render
    // `$NaN` and iterate undefined breaches.
    const spendCtx = parseSpendContext(held.spendContext);
    if (spendCtx === null) {
      record.spend = { amountCents: null, reason: "unpriced", breaches: [] };
    } else if (spendCtx !== undefined) {
      record.spend = {
        amountCents: spendCtx.amountCents,
        reason: spendCtx.reason,
        breaches: spendCtx.breaches,
        ...(spendCtx.summary !== undefined ? { summary: spendCtx.summary } : {}),
      };
    }
    return record;
  }

  // ----- Held call lifecycle -----

  /**
   * The id of the oldest held call (by held_at) genuinely awaiting a decision,
   * DO-wide, or null — the next one to answer. Tests probe hold presence
   * through this; the status snapshot reads the full list.
   */
  heldCallId(): string | null {
    return this.firstUnresolvedHeldCallId();
  }

  /**
   * The id of the oldest held call (by held_at) that is genuinely awaiting a
   * decision, optionally scoped by `predicate` (e.g. `run_id === null` for the
   * human task). The guards' single-pick over `unresolvedHeldCallIds` — one
   * filter set, so a guard and the status list can never disagree about
   * which rows are awaiting.
   */
  private firstUnresolvedHeldCallId(
    predicate?: (row: { run_id: string | null }) => boolean,
  ): string | null {
    return this.unresolvedHeldCallIds(predicate)[0] ?? null;
  }

  /**
   * Every held call genuinely awaiting a decision, oldest first (by held_at,
   * id-tiebroken), optionally scoped by `predicate` (e.g. `run_id === null`
   * for the human task). Skips rows mid-resume (carrying an `answered`
   * payload) and rows whose session has expired. A row carrying only
   * `dispatched` is NOT skipped: mid-resolve it belongs to an in-flight RPC
   * that must not be double-driven, and once a crash strands it the chat path
   * closes it out upstream of this read (`healCrashedDispatchHolds`) rather
   * than letting it block every turn. Past started_at + 90 min a held call is
   * inert (loadHeldCall returns null for it), so it must not block a guard,
   * consistent with loadHeldCall's read-time expiry. The current design
   * lifts one-held-row-per-DO, so several holds coexist; selectHeldCalls
   * returns them in held_at order, making the ordering deterministic.
   */
  private unresolvedHeldCallIds(
    predicate?: (row: { run_id: string | null }) => boolean,
  ): string[] {
    const ids: string[] = [];
    for (const row of heldToolCallsData.selectHeldCalls(this.sqlTag)) {
      if (predicate && !predicate(row)) continue;
      if (this.turnStateIsAnswered(row.turn_state)) continue;
      const startedAt = this.sessionStartedAt(row.session_id);
      if (startedAt && Date.now() >= startedAt.getTime() + SESSION_LIFETIME_MS) {
        continue;
      }
      ids.push(row.id);
    }
    return ids;
  }

  /** True if a held row's turn_state has been resolved (mid-resume). */
  private turnStateIsAnswered(turnState: string): boolean {
    if (!turnState) return false;
    const parsed = parseTurnState(turnState);
    return parsed.ok && parsed.state.answered !== undefined;
  }

  /**
   * True if a held row's turn_state shows the resolve path has taken over —
   * `dispatched` (tool sent, result pending) or `answered` (result produced,
   * resume pending). Such a row is no longer "parked awaiting approval": the
   * resolve path owns its terminal audit outcome — the real allow/deny result,
   * already written or landing when the in-flight resolve completes past its
   * await. So every session-end teardown that sweeps held calls
   * (`endSessionRowInTxn` for quit/superseded, `reapExpiredSessions`, and
   * `killSwitch` TX2) MUST skip the timeout outcome for such a row: writing it
   * would append a second, contradictory terminal outcome (a false denial) on
   * the same `pending` entry, which `audit_log` cannot overwrite. The teardown
   * still deletes/sweeps the row unconditionally — only the fabricated audit
   * outcome is suppressed.
   *
   * Residual (accepted): a crash-after-dispatch followed by teardown (double
   * fault) leaves the `pending` entry unresolved rather than falsely denied — an
   * open entry beats a fictional one. A UNIQUE `idx_decision_entry` constraint
   * would turn the double-WRITE into a hard error; it does not close this
   * under-write.
   *
   * A seeded `directExecute` hold carries neither flag, and an
   * unparseable/empty turn_state (a legacy/corrupt row) also fails both checks —
   * both are genuinely parked → false.
   */
  private turnStateHasResolution(turnState: string): boolean {
    if (!turnState) return false;
    const parsed = parseTurnState(turnState);
    return (
      parsed.ok &&
      (parsed.state.dispatched === true || parsed.state.answered !== undefined)
    );
  }

  /**
   * The terminal audit entry that closes a hold whose tool dispatched but whose
   * outcome was lost to a crash. Derived from the hold alone so the two callers
   * cannot drift: a retried `resolveConfirmation` (which then resumes the turn)
   * and `healCrashedDispatchHolds` (which does not). `decision` is `allow`
   * because the call WAS authorized and did run; `outcome` is `error` because
   * its result is unrecoverable.
   *
   * A money verb keeps its bound amount here too — the attempted spend is part
   * of the record. The ledger row that a successful
   * dispatch would have written is gone with the crash; that gap is detectable
   * by the audit↔ledger join and is not fabricated here.
   *
   * Both callers pass `observed` to the choke point even though neither saw a
   * tool result: they read the durable `dispatched` marker, and no other
   * writer holds the fact that the tool went out. Suppressing this row would
   * leave that fact unrecorded, which is the opposite failure from the
   * fabrication the inferred branch exists to stop.
   */
  private dispatchRecoveryAuditParams(args: {
    toolName: string;
    input: LLMToolUseBlock["input"];
    userId: string;
    agentId: string;
    sessionId: string;
    pendingAuditEntryId: string;
    origin: AuditOrigin;
  }): ReferencingAuditEntryParams {
    const registry = lookupTool(args.toolName);
    const amountCents = registry?.spend?.quotedAmountCents(args.input) ?? null;
    return {
      userId: args.userId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      toolName: args.toolName,
      service: registry?.service ?? "unknown",
      verb: registry?.verb ?? "execute",
      noun: registry ? registry.nounExtractor(args.input) : "unknown",
      decision: "allow",
      origin: args.origin,
      parametersMetadata: extractMetadata(args.input),
      outcome: "error",
      errorMessage: DISPATCH_RECOVERY_ERROR,
      decisionEntryId: args.pendingAuditEntryId,
      latencyMs: 0,
      costUsd: amountCents !== null ? amountCents / 100 : undefined,
    };
  }

  /**
   * Close out any human-owned hold that a crash left mid-dispatch — `dispatched`
   * committed, `answered` never persisted. Runs on the chat path,
   * after the reaper and BEFORE the held-call guard.
   *
   * Such a row made two readers of the same hold disagree: `pendingHeldRecordFor`
   * skips it (nothing is awaiting a decision, so it is absent from `status.held`)
   * while
   * `firstUnresolvedHeldCallId` returns it (the chat guard refuses the turn). The
   * user was told to resolve a request that `GET /api/status` reported as absent,
   * with no held record to render a prompt from. Healing the row is what removes
   * the disagreement: the state that produced it does not survive a chat turn.
   *
   * It can only ever see a row a crash stranded, never one a live resolve owns:
   * the turn gate holds `turnInFlight` across that resolve's dispatch and resume
   * awaits, so a chat arriving mid-resolve is refused busy before reaching here.
   * The marker is in-memory and therefore false after the isolate death that
   * strands the row — which is exactly the state this heals.
   *
   * The tool already ran, so this NEVER re-dispatches. It writes the same
   * terminal audit entry a retried resolve would (one transaction with the row
   * delete, so a fault cannot leave the entry written and the row alive to write
   * it again), and returns the healed tool_use ids so `repairOrphanedToolUse`
   * answers them as completed rather than as "may or may not have executed" — a
   * string that could invite the model to repeat a side effect.
   *
   * Scoped to `run_id === null`, matching the guard: a commissioned hold never
   * blocks the human turn, and `cancelTask` already answers `resolving` for it.
   * An expired hold is left to the reaper (`loadHeldCall` returns null for it).
   * Unlike the resolve path this does not re-enter the LLM: the buffer repair
   * below covers the conversation, and a `directExecute` hold has no
   * conversation to re-enter at all.
   */
  private healCrashedDispatchHolds(userId: string, agentId: string): Set<string> {
    const healed = new Set<string>();
    for (const row of heldToolCallsData.selectHeldCalls(this.sqlTag)) {
      if (row.run_id !== null) continue;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok || !parsed.state.heldCall) continue;
      if (parsed.state.dispatched !== true) continue;
      if (parsed.state.answered !== undefined) continue;
      const held = this.loadHeldCall(row.id);
      if (!held) continue;
      const heldCall = parsed.state.heldCall;
      const auditParams = this.dispatchRecoveryAuditParams({
        toolName: heldCall.name,
        input: heldCall.input,
        userId,
        agentId,
        sessionId: held.sessionId,
        pendingAuditEntryId: held.pendingAuditEntryId,
        origin: "human",
      });
      this.ctx.storage.transactionSync(() => {
        this.closeDecisionEntryInTxn(auditParams, "observed");
        heldToolCallsData.deleteHeldToolCall(this.sqlTag, row.id);
      });
      healed.add(heldCall.id);
    }
    return healed;
  }

  /** Persist the in-flight turn-state blob against a held call. */
  storeHeldTurnState(heldCallId: string, turnState: string): void {
    heldToolCallsData.updateHeldTurnState(this.sqlTag, heldCallId, turnState);
  }

  /** Load a held call (with its turn state), or null if absent/expired. */
  loadHeldCall(heldCallId: string): {
    id: string;
    sessionId: string;
    pendingAuditEntryId: string;
    turnState: string;
    heldAt: string;
    /** The commission run this hold belongs to; null for a CLI-direct hold. */
    runId: string | null;
    /** The spend hold's context JSON; null on an ordinary hold. */
    spendContext: string | null;
  } | null {
    const row = heldToolCallsData.readHeldCall(this.sqlTag, heldCallId);
    if (row === null) return null;
    // Read-time expiry: a held call is inert once its session passes
    // started_at + 90 min — it cannot authorize or resume.
    const startedAt = this.sessionStartedAt(row.session_id);
    if (startedAt && Date.now() >= startedAt.getTime() + SESSION_LIFETIME_MS) {
      return null;
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      pendingAuditEntryId: row.pending_audit_entry_id,
      turnState: row.turn_state,
      heldAt: row.held_at,
      runId: row.run_id,
      spendContext: row.spend_context,
    };
  }

  /** Delete a held call and its turn state (resolve / expiry / kill). */
  deleteHeldCall(heldCallId: string): void {
    heldToolCallsData.deleteHeldToolCall(this.sqlTag, heldCallId);
  }

  // ----- Session end + lazy expiry reaper -----

  /**
   * Identity fields of an audit entry, recovered by id. The reaper and the
   * kill path need a held call's user/agent/session/scope to write its terminal
   * outcome and the session.end event — none of which `held_tool_calls` or
   * `session_state` store. The held call's own `pending` decision entry carries
   * them, so we read them back from the audit log rather than adding columns.
   */
  private auditEntryIdentity(entryId: string): {
    userId: string;
    agentId: string;
    sessionId: string;
    toolName: string;
    service: string;
    verb: string;
    noun: string;
    origin: AuditOrigin;
  } | null {
    const r = auditLogData.readAuditEntryIdentity(this.sqlTag, entryId);
    if (r === null) return null;
    return {
      userId: r.user_id,
      agentId: r.agent_id,
      sessionId: r.session_id,
      toolName: r.tool_name,
      service: r.service,
      verb: r.verb,
      noun: r.noun,
      origin: r.origin as AuditOrigin,
    };
  }

  /**
   * Identity for a session.end event when there is no held call to recover it
   * from (an idle session that timed out, or a kill of a grants-only session).
   * The session's `session.start` audit row carries user/agent/session — it is
   * always written when the session is established — so we read it back rather
   * than storing user_id on session_state.
   */
  private sessionIdentity(
    sessionId: string,
  ): { userId: string; agentId: string; sessionId: string } | null {
    const row = auditLogData.readSessionStartIdentity(this.sqlTag, sessionId);
    if (row === null) return null;
    return { userId: row.user_id, agentId: row.agent_id, sessionId };
  }

  /**
   * Write the session.end audit event. The row is identified by
   * `tool_name='session.end'`, not by a verdict value — the `decision`/`outcome`
   * columns stay verdict-only per spec, so a session lifecycle event reuses
   * `decision='deny'`, `outcome='timeout'` as fixed placeholders. **The reason
   * (`timeout`/`kill`/`quit`/`superseded`/`terminated`) lives in `error_message`,
   * NOT `outcome`** — so distinguish the end paths by querying
   * `tool_name='session.end'` + `error_message`, never by `outcome` alone.
   * The caller controls `timestamp`: the effective expiry instant on the
   * timeout path, now() on kill/quit/supersede.
   *
   * Reasons: `timeout` (reaper), `kill` (kill switch), `quit` (explicit
   * `endSession`), `superseded` (the tie-break reap ending a stale un-ended row
   * when the single-active invariant was violated).
   * `terminated` is reserved for active termination on a detected improper
   * close — that close-detection signal is not wired yet, so this
   * reason is a dormant param today (deferred, not dead).
   */
  private writeSessionEnd(params: {
    identity: { userId: string; agentId: string; sessionId: string };
    reason: "timeout" | "kill" | "quit" | "superseded" | "terminated";
    timestamp: string;
  }): void {
    // Recover the session's origin from its session.start row so session.end
    // matches it. Without this the entry defaults to 'human', so a commission
    // (mcp_commission) session's end is mis-tagged: an origin-filtered audit
    // reconstruction sees the start but not the end. Covers every end
    // path (timeout/kill/quit/superseded) since they all route through here.
    const origin =
      auditLogData.readSessionStartIdentity(this.sqlTag, params.identity.sessionId)
        ?.origin ?? "human";
    // Txn-context-only: callable only inside a caller-opened transactionSync
    // (the reaper, killSwitch TX2) — composes the bare helper, never the
    // transaction-opening writeAuditEntry() wrapper.
    auditLogData.insertAuditEntryInTxn(this.sqlTag, {
      userId: params.identity.userId,
      agentId: params.identity.agentId,
      sessionId: params.identity.sessionId,
      toolName: "session.end",
      service: "session",
      verb: "end",
      noun: "-",
      decision: "deny",
      origin,
      parametersMetadata: {},
      outcome: "timeout",
      errorMessage: params.reason,
      latencyMs: 0,
      costUsd: undefined,
      timestamp: params.timestamp,
    });
  }

  /**
   * Close the `pending` audit entry a parked INPUT hold wrote (`parkInputHold`)
   * when `habenula_provide` answers it. Without this the
   * park's pending entry dangles: the re-attempt runs the full pipeline and
   * writes its OWN governed `pending`→terminal pair, and the input hold row is
   * then deleted, so nothing ever closes the park entry — leaving a permanently
   * unresolved `pending` per provide cycle. Mirrors `writeHeldTimeoutOutcome`'s
   * pairing (a closer referencing the pending via `decisionEntryId`), but records
   * the ANSWERED disposition: the park is released for governed re-evaluation,
   * whose real verdict is the re-attempt's own pair. The unanswered case is
   * already closed as `deny`/`timeout` by the session sweep. `allow`/`success`
   * marks the release; the message disambiguates it from a governance allow.
   */
  private closeInputParkAudit(
    pendingAuditEntryId: string,
    timestamp: string,
  ): void {
    const identity = this.auditEntryIdentity(pendingAuditEntryId);
    if (!identity) return;
    this.ctx.storage.transactionSync(() =>
      this.closeDecisionEntryInTxn(
        {
          userId: identity.userId,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          toolName: identity.toolName,
          service: identity.service,
          verb: identity.verb,
          noun: identity.noun,
          decision: "allow",
          origin: identity.origin,
          parametersMetadata: {},
          outcome: "success",
          errorMessage:
            "Input provided via habenula_provide; parked action re-evaluated through governance",
          decisionEntryId: pendingAuditEntryId,
          latencyMs: 0,
          timestamp,
        },
        "observed",
      ),
    );
  }

  /**
   * Write a held call's terminal denied outcome entry, resolving its open
   * `pending` decision entry via `decision_entry_id`. Recovers the
   * call's identity from its pending entry. `timestamp` is the effective
   * expiry instant (timeout) or now() (kill). Returns the recovered identity
   * (for the paired session.end) or null if the pending entry is missing.
   */
  private writeHeldTimeoutOutcome(
    pendingAuditEntryId: string,
    timestamp: string,
  ): { userId: string; agentId: string; sessionId: string } | null {
    const identity = this.auditEntryIdentity(pendingAuditEntryId);
    if (!identity) return null;
    // Txn-context-only, same composition rule as writeSessionEnd above.
    // Inferred basis: a sweep deduces the timeout rather than observing a
    // result, so the choke point skips when a real closer already exists.
    // The null is discarded — a skip changes what is written and nothing else.
    this.closeDecisionEntryInTxn(
      {
        userId: identity.userId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        toolName: identity.toolName,
        service: identity.service,
        verb: identity.verb,
        noun: identity.noun,
        decision: "deny",
        origin: identity.origin,
        parametersMetadata: {},
        outcome: "timeout",
        errorMessage: "Held call expired with its session",
        decisionEntryId: pendingAuditEntryId,
        latencyMs: 0,
        costUsd: undefined,
        timestamp,
      },
      "inferred",
    );
    return {
      userId: identity.userId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    };
  }

  /**
   * Close a parked hold's `pending` audit entry when its task is CANCELLED.
   * Mirrors `writeHeldTimeoutOutcome`'s pairing — a
   * terminal entry referencing the pending via `decisionEntryId` — but records
   * cancellation rather than session expiry, so the hash chain stays intact
   * (Hard Invariant 3) and no `pending` entry dangles after the hold is swept.
   * The parked action never executed, so `decision: "deny"`, `outcome: "error"`
   * (the frozen audit vocabulary has no `cancelled` outcome); the surface that
   * cancelled it is recorded in the message so `human` and own-task `mcp` cancels
   * stay distinguishable in the log. Txn-context-only: the caller owns the
   * `transactionSync`, the same composition rule as `writeHeldTimeoutOutcome`.
   */
  /**
   * Record the cancel ITSELF as a first-class audit row.
   * `writeHeldCancelOutcome` closes a held call's open `pending` decision — it says
   * what happened to a parked ACTION. It does not say that a TASK was cancelled,
   * and it does not run at all when the task owns no hold, so without this a
   * hold-less cancel moves a task terminal leaving zero audit rows. Cancel is a
   * governance-relevant state change on the accountability surface, so "who
   * cancelled which task, from which surface, when" gets its own queryable row.
   * Mirrors `writeSessionEnd`'s lifecycle-entry shape (a synthetic
   * `service`/`verb` outside the tool registry, disposition in `error_message`).
   * Txn-context-only: the caller owns the `transactionSync`.
   */
  private writeTaskCancelAudit(params: {
    userId: string;
    agentId: string;
    sessionId: string;
    taskId: string;
    surface: "human" | "mcp";
    timestamp: string;
  }): void {
    auditLogData.insertAuditEntryInTxn(this.sqlTag, {
      userId: params.userId,
      agentId: params.agentId,
      sessionId: params.sessionId,
      toolName: "task.cancel",
      service: "task",
      verb: "cancel",
      noun: params.taskId,
      decision: "allow",
      origin: params.surface === "mcp" ? "mcp_commission" : "human",
      parametersMetadata: {},
      outcome: "success",
      errorMessage:
        params.surface === "mcp"
          ? "Task cancelled by the owning client (habenula_cancel)"
          : "Task cancelled by the user (habenula task cancel)",
      latencyMs: 0,
      costUsd: undefined,
      timestamp: params.timestamp,
    });
  }

  private writeHeldCancelOutcome(
    pendingAuditEntryId: string,
    timestamp: string,
    surface: "human" | "mcp",
  ): void {
    const identity = this.auditEntryIdentity(pendingAuditEntryId);
    if (!identity) return;
    // Inferred basis, as in writeHeldTimeoutOutcome: the cancel sweep deduces
    // the disposition, so an existing real closer suppresses this write.
    this.closeDecisionEntryInTxn(
      {
        userId: identity.userId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        toolName: identity.toolName,
        service: identity.service,
        verb: identity.verb,
        noun: identity.noun,
        decision: "deny",
        origin: identity.origin,
        parametersMetadata: {},
        outcome: "error",
        // Distinct from the task-level `task.cancel` entry's message: this row is
        // the parked ACTION's terminal disposition, that one is the task lifecycle
        // event. Keeping them textually distinguishable keeps the log unambiguous.
        errorMessage:
          surface === "mcp"
            ? "Parked action cancelled with its task (habenula_cancel)"
            : "Parked action cancelled with its task (habenula task cancel)",
        decisionEntryId: pendingAuditEntryId,
        latencyMs: 0,
        costUsd: undefined,
        timestamp,
      },
      "inferred",
    );
  }

  /**
   * Lazy reaper: on DO activity, observe sessions past their 90-min cap
   * and close them out. There is no alarm — expiry is enforced at read time
   * (loadHeldCall / heldCallId already treat an expired held call as inert);
   * this writes the durable terminal records the read-time path can't.
   *
   * Iterates `session_state` (not held calls) so **every** session that has
   * passed its cap gets a `session.end` — the spec's "established once and ended
   * once" symmetry, not just sessions that happened to die holding a
   * call. The `ended_at` marker is the once-only idempotency guard: a closed
   * session is skipped on every later pass, so `session.end` is never re-emitted.
   *
   * For each expired, not-yet-ended session, in ONE transaction: close any held
   * call (terminal denied outcome resolving its `pending`, then delete the row),
   * write `session.end`, and stamp `ended_at` — ALL stamped with the effective
   * expiry instant (`started_at + 90 min`, not the wake time). A *fully
   * abandoned* session is still closed the moment the DO is next active; the
   * only residual is the latency until that activity (no alarm).
   */
  reapExpiredSessions(): void {
    const now = Date.now();
    const sessions = sessionStateData.selectOpenSessions(this.sqlTag);
    for (const s of sessions) {
      const startedAt = this.sessionStartedAt(s.session_id);
      // Unparseable anchor: no expiry can be computed, so end the session at
      // observation time (reason stays `timeout` — it is the dead-man path).
      // Before single-session, skipping (the original guard: never throw on a
      // poisoned row) was harmless — every request minted a fresh session.
      // After single-session a skipped open row would BE the active session: immortal,
      // never timing out, its held calls approvable forever. The no-throw
      // guarantee is preserved; only the skip became an end.
      const effectiveExpiry = startedAt
        ? startedAt.getTime() + SESSION_LIFETIME_MS
        : now;
      if (now < effectiveExpiry) continue;
      const stamp = new Date(effectiveExpiry).toISOString();
      this.ctx.storage.transactionSync(() => {
        // Close any held call for this expired session: resolve its pending
        // entry to a terminal denied outcome, then delete the row.
        const heldRows = heldToolCallsData.selectHeldCallsForSession(
          this.sqlTag,
          s.session_id,
        );
        for (const h of heldRows) {
          // Skip a mid-resolve row (see turnStateHasResolution for the full
          // rationale + accepted residual): the resolve path owns its terminal
          // outcome. The row is still deleted below — nothing survives the reap.
          if (!this.turnStateHasResolution(h.turn_state)) {
            this.writeHeldTimeoutOutcome(h.pending_audit_entry_id, stamp);
          }
          heldToolCallsData.deleteHeldToolCall(this.sqlTag, h.id);
        }
        // Always write session.end + mark ended (the symmetry fix).
        const identity = this.sessionIdentity(s.session_id);
        if (identity) {
          this.writeSessionEnd({ identity, reason: "timeout", timestamp: stamp });
        }
        commissionRunsData.markRunsExpiredForSession(this.sqlTag, s.session_id, stamp);
        sessionStateData.markSessionEnded(this.sqlTag, s.session_id, stamp);
      });
    }
  }

  /**
   * Kill switch: revoke all grants (deny-all). Scoped to governance state —
   * it does NOT delete connected services or their credentials, so connections
   * survive a kill and the user can resume without re-running OAuth. Deny-all
   * makes a surviving credential unusable: no grant remains except the floor.
   *
   * Two transactions:
   *  - **TX1 (deny-all):** delete every grant except the `default-deny` floor
   *    and all held calls. This is the safety guarantee and commits
   *    independently.
   *  - **TX2 (best-effort audit):** resolve each held call's `pending` entry to
   *    a terminal denied outcome and write `session.end` (reason `kill`) +
   *    mark ended for every active session. If TX2 throws, TX1 has already
   *    committed — the kill still reports success (deny-all is in effect) and
   *    the audit failure is logged, rather than rolling deny-all back.
   */
  killSwitch(): void {
    const now = new Date().toISOString();
    // Snapshot what the audit pass (TX2) needs BEFORE TX1 clears held calls.
    // audit_log is never deleted, so the pending-entry ids stay resolvable.
    const held = heldToolCallsData.selectHeldCallAuditRefs(this.sqlTag);
    const activeSessions = sessionStateData.selectOpenSessions(this.sqlTag);

    // TX1 — deny-all. This is the kill's safety guarantee and commits on its
    // own: it must take effect even if the
    // audit bookkeeping in TX2 fails. A kill switch prioritizes taking effect
    // over a complete audit pair. Connections and credentials are intentionally
    // left intact — deny-all alone halts all tool execution.
    this.ctx.storage.transactionSync(() => {
      policyEntriesData.deletePolicyEntriesExcept(this.sqlTag, WILDCARD_DENY_ID);
      heldToolCallsData.deleteAllHeldToolCalls(this.sqlTag);
    });

    // TX2 — best-effort audit bookkeeping: resolve each held call's open
    // `pending` entry to a terminal denied outcome, and write `session.end`
    // (reason kill) + mark ended for every active session. Stamped now() —
    // kill ends the session immediately. If this throws, TX1's deny-all has
    // ALREADY committed; we log and still report success rather than failing
    // the kill (accepted: a rare audit failure leaves a session.end gap).
    try {
      this.ctx.storage.transactionSync(() => {
        for (const row of held) {
          // Skip a mid-resolve row (see turnStateHasResolution for the full
          // rationale + accepted residual): the resolve path owns its terminal
          // outcome. TX1 already deleted the row; this only governs the audit
          // outcome.
          if (!this.turnStateHasResolution(row.turn_state)) {
            this.writeHeldTimeoutOutcome(row.pending_audit_entry_id, now);
          }
        }
        for (const s of activeSessions) {
          const identity = this.sessionIdentity(s.session_id);
          if (identity) {
            this.writeSessionEnd({ identity, reason: "kill", timestamp: now });
          }
          commissionRunsData.markRunsExpiredForSession(this.sqlTag, s.session_id, now);
          sessionStateData.markSessionEnded(this.sqlTag, s.session_id, now);
        }
      });
    } catch {
      // Swallow (2a, succeed-and-log decision → swallow): TX1's deny-all has
      // already committed, which is the kill's safety goal. The lost record is
      // a session.end / terminal outcome — an audit-completeness gap, not a
      // safety fact — and the engine has no log channel (no console; the audit
      // log is the very thing that just failed). Reporting success here is
      // deliberate: a kill must take effect over a complete audit pair.
    }
  }
}

const MAX_METADATA_BYTES = 10_240; // 10KB JSON output limit
const MAX_KEYS_PER_OBJECT = 100;

const MAX_NOUN_LEN = 80;

/**
 * Sanitize the LLM-derived noun before it appears in the "Tell me more"
 * metadata block. The noun comes from a registry
 * nounExtractor over LLM-supplied params (e.g. a mailbox label), so it is
 * untrusted display data: strip control characters and newlines (which could
 * fake structure or smuggle prompt text into the approval surface) and cap the
 * length. The result is labeled, escaped data — never prose.
 */
export function sanitizeNoun(noun: string): string {
  const stripped = noun.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return stripped.length > MAX_NOUN_LEN
    ? `${stripped.slice(0, MAX_NOUN_LEN)}…`
    : stripped;
}

/**
 * The commission turn's user message:
 * an engine-authored provenance frame that RIDES THE BUFFER — the
 * system-prompt notice is per-invocation, but this label persists into later
 * human turns, so the goal is never read back as ordinary user prose
 * (the buffer-bleed residual, shrunk). The goal and each
 * data value render as labeled blocks after the frame. Each data VALUE is
 * client-authored content, so it is wrapped in the untrusted-output fence
 * — the engine-authored label line stays
 * plain. The goal is not fenced — it is the turn's user message, guarded by
 * the origin notice (inbound injection is handled in layers, not with
 * the output fence).
 */
export function composeCommissionMessage(
  goal: string,
  data?: Record<string, string>,
): string {
  const lines = [
    "[Relayed from an external client via Habenula's commission surface — not typed by your user]",
    "Goal (client-authored):",
    goal,
  ];
  for (const [key, value] of Object.entries(data ?? {})) {
    lines.push(
      `data.${key} (client-supplied verbatim value; pass unchanged with {{data.${key}}}):`,
      fenceUntrusted(value),
    );
  }
  return lines.join("\n");
}

const DATA_PLACEHOLDER = /^\{\{data\.([A-Za-z0-9_-]+)\}\}$/;

/**
 * Whole-value {{data.<key>}} substitution over a tool's parameters.
 * Exact whole-string placeholders only — no
 * interpolation. An unknown key is left verbatim (the MCP
 * boundary already rejects unknown keys in the map itself), so a typo'd
 * placeholder fails visibly downstream instead of silently.
 */
export function substituteDataPlaceholders(
  params: Record<string, unknown>,
  data: Record<string, string>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const m = DATA_PLACEHOLDER.exec(value);
      // Own properties only: `in` walks the prototype chain, so a model-
      // emitted {{data.constructor}} would substitute an inherited function
      // instead of staying verbatim.
      return m && Object.prototype.hasOwnProperty.call(data, m[1]!)
        ? data[m[1]!]
        : value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          walk(v),
        ]),
      );
    }
    return value;
  };
  return walk(params) as Record<string, unknown>;
}

/**
 * The bound amount for a money verb, normalized. Returns null when the tool
 * declares no spend field, or when the decoded amount is not a non-negative
 * safe integer — the ledger's own guard rejects those, and a rejected insert
 * must never be what discovers it.
 */
function centsFromSpend(
  spend: { quotedAmountCents: (p: Record<string, unknown>) => number | null } | undefined,
  toolParams: Record<string, unknown>,
): number | null {
  if (!spend) return null;
  const raw = spend.quotedAmountCents(toolParams);
  if (raw === null || !Number.isSafeInteger(raw) || raw < 0) return null;
  return raw;
}

/** Integer cents → the dollars `audit_log.cost_usd` records (record-only). */
function centsToUsd(cents: number): number {
  return cents / 100;
}

/** Extract parameter shapes (types, lengths) without values — metadata-only default. */
export function extractMetadata(
  params: Record<string, unknown>
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      meta[key] = { type: "string", length: value.length };
    } else if (typeof value === "number") {
      meta[key] = { type: "number" };
    } else if (typeof value === "boolean") {
      meta[key] = { type: "boolean" };
    } else if (Array.isArray(value)) {
      meta[key] = { type: "array", length: value.length };
    } else if (value === null) {
      meta[key] = { type: "null" };
    } else if (typeof value === "object") {
      const allKeys = Object.keys(value as Record<string, unknown>);
      if (allKeys.length > MAX_KEYS_PER_OBJECT) {
        meta[key] = {
          type: "object",
          keyCount: allKeys.length,
          keys: allKeys.slice(0, MAX_KEYS_PER_OBJECT),
          truncated: true,
        };
      } else {
        meta[key] = { type: "object", keys: allKeys };
      }
    }
  }

  const json = JSON.stringify(meta);
  if (json.length > MAX_METADATA_BYTES) {
    return { truncated: true, originalKeyCount: Object.keys(params).length };
  }

  return meta;
}

