// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * `GET /api/services/catalog` — the connectable set. Discovery only, distinct
 * from the user's connected services (`ServicesResponse`). The id is exactly
 * the string `connect` posts; a display-label field may be added later
 * without breaking consumers, but doing so must update this schema first —
 * it is the definition of the bytes.
 */
export const CatalogResponse = z.strictObject({
  services: z.array(z.strictObject({ service: z.string() })),
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;

/** `GET /api/services` — the user's connected services. */
export const ServicesResponse = z.strictObject({
  services: z.array(
    z.strictObject({ service: z.string(), connected_at: z.string() }),
  ),
});
export type ServicesResponse = z.infer<typeof ServicesResponse>;

/**
 * `POST /api/services/disconnect` — idempotent. `disconnected` echoes the
 * requested name; `removed` is whether a connected-service row actually
 * existed and was deleted. `removed: false` means the name matched no
 * connection (a typo, or a service that was never connected), so the caller
 * can report the no-op honestly instead of a false success.
 */
export const DisconnectResponse = z.strictObject({
  disconnected: z.string(),
  removed: z.boolean(),
});
export type DisconnectResponse = z.infer<typeof DisconnectResponse>;
