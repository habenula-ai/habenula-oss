// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient } from "../api-client";

export async function runDisconnect(
  client: ApiClient,
  service: string,
): Promise<number> {
  const { removed } = await client.disconnect(service);
  if (!removed) {
    // Idempotent no-op: the name matched no connection. Report it honestly
    // rather than the former unconditional "Disconnected".
    console.error(`not connected: ${service}`);
    return 1;
  }
  console.log(`Disconnected: ${service}`);
  return 0;
}
