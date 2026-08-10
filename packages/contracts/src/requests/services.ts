// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { userIdField } from "./common.js";

/**
 * `POST /api/services/disconnect` body. `service` is the only field with an
 * explicit failure message today (`"service is required"`), so any parse
 * failure collapses to that one string at the handler.
 */
export const DisconnectServiceRequest = z.object({
  userId: userIdField,
  service: z.string().min(1),
});
