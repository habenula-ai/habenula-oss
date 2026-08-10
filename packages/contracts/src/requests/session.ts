// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField } from "./common.js";

/**
 * `POST /api/session/start` and `POST /api/session/quit` bodies (one shape:
 * `userId` only, defaulted like every other route). At launch it runs one hardcoded
 * agent, so the boundary supplies `agentId` itself rather than accepting one.
 */
export const SessionRequest = z.object({
  userId: userIdField,
});
