// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The active session as the Worker reports it. `expiry`
 * is `started_at + 90min`, or null when the server could not compute it
 * (defensive server-side edge, e.g. a poisoned `started_at` anchor — render
 * times only when present). The nullable is load-bearing: a happy-path test
 * never produces it, production can.
 */
export const ActiveSessionView = z.strictObject({
  sessionId: z.string(),
  startedAt: z.string(),
  expiry: z.string().nullable(),
});
export type ActiveSessionView = z.infer<typeof ActiveSessionView>;

/**
 * `POST /api/session/start` — the launch handshake. `refused` arrives as
 * HTTP 409 and carries the session that blocked the start: an expected
 * outcome the client attaches to, not an error. Both variants validate
 * against this schema (return-kind rule), never `ErrorResponse`.
 */
export const StartSessionResponse = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("started"),
    activeSession: ActiveSessionView,
  }),
  z.strictObject({
    status: z.literal("refused"),
    activeSession: ActiveSessionView,
  }),
]);
export type StartSessionResponse = z.infer<typeof StartSessionResponse>;

/** `POST /api/session/quit` — `ended: false` when no session was active. */
export const QuitResponse = z.strictObject({
  ended: z.boolean(),
});
export type QuitResponse = z.infer<typeof QuitResponse>;

/** `GET /api/session` — the active session, or `{ active: null }`. */
export const GetSessionResponse = z.strictObject({
  active: ActiveSessionView.nullable(),
});
export type GetSessionResponse = z.infer<typeof GetSessionResponse>;
