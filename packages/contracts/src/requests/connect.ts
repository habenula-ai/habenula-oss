// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField } from "./common.js";

/**
 * `POST /api/connect/cancel` body. `flow` is the handle the connect entry
 * returned (`ConnectResponse.flow`); the Worker routes to the caller's DO by
 * `userId`, so the handle can only ever name a flow in that user's own DO.
 */
export const ConnectCancelRequest = z.object({
  userId: userIdField,
  flow: z.string().min(1),
});

/**
 * `GET /api/connect/status` query parameters. The read names the same flow the
 * cancel body does, over the query string rather than a body. `service` and
 * `flow` are both required: the route answers 400 without either, and this is
 * the only query schema in the package with a required parameter besides
 * `GET /api/tasks/get`.
 */
export const ConnectFlowStatusRequest = z.object({
  userId: userIdField,
  service: z.string().min(1),
  flow: z.string().min(1),
});
export type ConnectFlowStatusRequest = z.infer<typeof ConnectFlowStatusRequest>;

/**
 * Parse `GET /api/connect/status`'s query string. Safe-parse, because a missing
 * `service` or `flow` is a 400 the route reports with
 * `connectFlowStatusRequestError` rather than an exception.
 */
export function parseConnectFlowStatusQuery(
  params: URLSearchParams,
): z.ZodSafeParseResult<ConnectFlowStatusRequest> {
  return ConnectFlowStatusRequest.safeParse({
    userId: params.get("userId"),
    service: params.get("service"),
    flow: params.get("flow"),
  });
}

/**
 * Map a `ConnectFlowStatusRequest` parse failure to a stable message. Both
 * required parameters share one message, which is what the route has always
 * answered — naming which of the two is missing would be new behavior. Like
 * `taskGetRequestError`, it needs no ill-formed-string branch: a query string's
 * values arrive from the URL decoder already well-formed.
 */
export function connectFlowStatusRequestError(_error: z.ZodError): string {
  return "service and flow query parameters are required";
}
