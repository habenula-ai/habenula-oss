// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { illFormedStringError, limitParam, userIdField } from "./common.js";

/**
 * `POST /api/tasks/cancel` body.
 * The HUMAN surface — the CLI/HTTP user cancels a task of any origin, including
 * a runaway `mcp_commission` task. Cancel authority is split by *surface*, not
 * origin: this route is authoritative over every task; the MCP `habenula_cancel`
 * verb is own-task-scoped and refuses a cross-origin cancel. There is no
 * `/api/tasks/amend` route — amend re-supplies client-held data and is MCP-only.
 *
 * Plain `z.object` like every request schema: unknown top-level keys strip, they
 * never reject (the accept-set posture; strictness is a response-side decision).
 */
const TASK_ID_REQUIRED = "taskId is required";

export const TaskCancelRequest = z.object({
  userId: userIdField,
  taskId: z.string().min(1),
});

/**
 * Map a `TaskCancelRequest` parse failure to a stable message. `taskId` is the
 * only field that can be missing, so any other issue reports the missing-taskId
 * message — mirroring `resolveRequestError`. An ill-formed `userId` is the one
 * failure that names itself instead.
 */
export function taskCancelRequestError(error: z.ZodError): string {
  return illFormedStringError(error) ?? TASK_ID_REQUIRED;
}

/**
 * `GET /api/tasks` query parameters — the task queue as a bounded page.
 * `limit` is clamped inside the DO; `cursor` is the opaque keyset token from a
 * prior page's `nextCursor`. Shares `limitParam` with the audit page, so the
 * blank-`limit`-is-absent rule is written once for both readers.
 */
export const TasksListRequest = z.object({
  userId: userIdField,
  limit: z.number().optional(),
  cursor: z.string().nullish(),
});
export type TasksListRequest = z.infer<typeof TasksListRequest>;

/** Parse `GET /api/tasks`'s query string. */
export function parseTasksListQuery(params: URLSearchParams): TasksListRequest {
  return TasksListRequest.parse({
    userId: params.get("userId"),
    limit: limitParam(params),
    cursor: params.get("cursor"),
  });
}

/**
 * `GET /api/tasks/get` query parameters. `taskId` is required and non-empty —
 * the route answers 400 without one and 404 for an unknown one, so the two
 * failures stay distinguishable to a caller.
 */
export const TaskGetRequest = z.object({
  userId: userIdField,
  taskId: z.string().min(1),
});
export type TaskGetRequest = z.infer<typeof TaskGetRequest>;

/**
 * Parse `GET /api/tasks/get`'s query string. Returns the parse result rather
 * than throwing, because the missing-`taskId` case is a 400 the route reports
 * with `taskGetRequestError`, not an exception.
 */
export function parseTaskGetQuery(
  params: URLSearchParams,
): z.ZodSafeParseResult<TaskGetRequest> {
  return TaskGetRequest.safeParse({
    userId: params.get("userId"),
    taskId: params.get("taskId"),
  });
}

/**
 * Map a `TaskGetRequest` parse failure to a stable message. Same shape and same
 * reasoning as `taskCancelRequestError`: only `taskId` can fail, so the message
 * is the one the route has always answered with. No ill-formed-string branch
 * here, unlike the cancel body: this request is read from a query string, whose
 * values arrive from the URL decoder already well-formed.
 */
export function taskGetRequestError(_error: z.ZodError): string {
  return TASK_ID_REQUIRED;
}
