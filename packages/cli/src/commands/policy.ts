// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient } from "../api-client";

export async function runPolicyList(client: ApiClient): Promise<number> {
  const result = await client.getPolicy();
  console.log(`Effective policy: ${result.effectiveDecision}`);
  const entries = result.entries;
  if (entries.length === 0) {
    console.log("No policy entries.");
    return 0;
  }
  console.log("Policy entries:");
  for (const e of entries) {
    const scope = `${e.service}:${e.verb}:${e.noun}`;
    console.log(`  ${e.id.slice(0, 8)}  ${scope}  →  ${e.decision}  (${e.source}, priority ${e.priority})`);
  }
  return 0;
}
