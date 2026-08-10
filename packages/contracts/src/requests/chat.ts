// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField } from "./common.js";

/**
 * `POST /api/chat` body. `message` is the only field with an explicit failure
 * message today (`"message is required"`).
 */
export const ChatRequest = z.object({
  userId: userIdField,
  message: z.string().min(1),
});
