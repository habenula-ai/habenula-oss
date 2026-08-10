// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * `GET /api/tasks` and `GET /api/tasks/get` — the task read/list surface.
 * A task is the grown commission
 * kernel: a durable unit of work with an origin (who asked), a status detailed
 * enough to say what happened, and — for a `needs_input` task — the published
 * slot key(s) it awaits. Every payload here is metadata only: never tool-output
 * content, credentials, or conversation history (the closed-surface property
 * is preserved).
 */

/** Who authored the task: the CLI user, or a named inbound MCP client. */
export const TaskOrigin = z.enum(["mcp_commission", "human"]);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

/**
 * The task lifecycle status, matching the engine's `commission_runs.status`
 * vocabulary (a closed enum, so a client can trust its shape). `needs_input`
 * and `cancelled` are additions over the earlier terminal set.
 */
export const TaskStatus = z.enum([
  "running",
  "awaiting_confirmation",
  "needs_input",
  "completed",
  "failed",
  "denied",
  "expired",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * One governed action within a task and its outcome — the per-action breakdown
 * collapsed to a single terminal word. `(service, verb, noun)` is the
 * governance tuple; `outcome` is metadata, never the action's return payload.
 * `noun` is unvalidated (registry `nounExtractor` is non-validating), so a
 * client renderer sanitizes it before display, exactly as `HeldCallRecord.noun`.
 */
export const TaskActionDetail = z.strictObject({
  service: z.string(),
  verb: z.string(),
  noun: z.string(),
  outcome: z.enum(["executed", "denied", "errored"]),
});
export type TaskActionDetail = z.infer<typeof TaskActionDetail>;

/**
 * A task as the list view reports it. `goal` and `label` are external-agent-
 * authored for an `mcp_commission` task, so both are bounded to mirror the
 * ingest cap (`COMMISSION_GOAL_MAX_CHARS = 4000`) — self-defending at the
 * contract, with the client additionally sanitizing/truncating at render.
 */
export const TaskSummary = z.strictObject({
  taskId: z.string(),
  origin: TaskOrigin,
  status: TaskStatus,
  // Always present: the engine derives a label from the goal when the stored
  // `label` column is unset, so this is never null on the wire.
  label: z.string().max(4000),
  goal: z.string().max(4000),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

/**
 * `GET /api/tasks` — a bounded page of the tasks the user's DO holds, newest
 * first. Cross-origin: the CLI user's own `human` turns and inbound
 * `mcp_commission` tasks alike. The list is capped (`?limit=`, server-clamped)
 * so a DO holding a long history never returns an unbounded payload;
 * `nextCursor` is the opaque continuation token for the next page (pass it back
 * as `?cursor=`), or null when this page is the last. Task rows are never pruned
 * — the cap bounds the *view*, not retention (the rows stay the forensic surface).
 */
export const TasksListResponse = z.strictObject({
  tasks: z.array(TaskSummary),
  nextCursor: z.string().nullable(),
});
export type TasksListResponse = z.infer<typeof TasksListResponse>;

/**
 * `GET /api/tasks/get?taskId=` — one task's full record: its summary plus the
 * per-action breakdown and, for a `needs_input` task, the published slot key(s)
 * it awaits. `awaitedSlotKeys` is a closed vocabulary (published `Tool.dataSlots`
 * keys matching `/^[A-Za-z0-9_-]+$/`), never model prose. `statusDetail` is null
 * until the task has run at least one governed action.
 */
export const TaskDetailResponse = z.strictObject({
  task: TaskSummary,
  statusDetail: z.array(TaskActionDetail).nullable(),
  awaitedSlotKeys: z.array(z.string()).nullable(),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponse>;

/**
 * `POST /api/tasks/cancel` result. The three informative
 * dispositions all ship as a 200 result body so the client parses one shape and
 * branches on `status`; the error dispositions never reach the wire here —
 * `not_found` is a 404, a transient `busy` (a live turn is in flight) is a 409
 * `TURN_IN_PROGRESS`, and the MCP-only `forbidden` cannot occur on this human
 * surface (it is authoritative over every origin). The three results:
 *   - `cancelled` — the task moved to the terminal `cancelled` state.
 *   - `running` — the task holds the single live turn and is never cancelled
 *     mid-flight; retry once it next parks or terminates.
 *   - `resolving` — a hold on the task is mid-resolve (already dispatched or
 *     answered). Its real outcome is owed by the resolve path, so cancelling
 *     would record a false "never ran" disposition; retry once it settles.
 *   - `not_cancellable` — the task is already terminal; there is nothing to
 *     cancel, and its `currentStatus` says which terminal state it reached.
 */
export const TaskCancelResponse = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("cancelled"),
    taskId: z.string(),
    previousStatus: TaskStatus,
  }),
  z.strictObject({
    status: z.literal("running"),
    taskId: z.string(),
  }),
  z.strictObject({
    status: z.literal("resolving"),
    taskId: z.string(),
  }),
  z.strictObject({
    status: z.literal("not_cancellable"),
    taskId: z.string(),
    currentStatus: TaskStatus,
  }),
]);
export type TaskCancelResponse = z.infer<typeof TaskCancelResponse>;
