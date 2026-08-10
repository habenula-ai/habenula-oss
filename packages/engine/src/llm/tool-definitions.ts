// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { listTools, toolName } from "@habenula-ai/tools";
import { CONTROL_PLANE_SERVICE } from "./control-plane";
import type { LLMToolDefinition } from "./types";

/** Connection-status tags prefixed onto each tool's description. */
const CONNECTED_TAG = "[CONNECTED]";
const NOT_CONNECTED_TAG = "[NOT CONNECTED]";

/**
 * Build the tool surface sent to the LLM for a turn, derived from the tool
 * registry and the user's connected services. Every registered tool is
 * surfaced — `gmail_list`, `mock_email_list` — so the model is aware of the
 * full catalog; name/description/input_schema come straight from the registry
 * so definitions and registry never drift.
 *
 * Connection status is a per-request, per-user fact, so it is rendered here
 * rather than in the static registry: each description is prefixed with a
 * `[CONNECTED]` / `[NOT CONNECTED]` tag. The model can't read the
 * connected_services table, so this projection is the only channel that
 * carries connection state into its context. The system prompt explains the
 * tags and steers the model toward connected services; governance still denies
 * an unconnected call as a backstop. Tools are emitted in registration order —
 * array position is not a documented tool-selection signal, so the tag (not
 * ordering) does the steering.
 *
 * The `habenula` control-plane service is gated on
 * `allowControlPlane`. This is the OFFER half of the two-surface trust boundary:
 * a commission-originated run is built with
 * `allowControlPlane: false`, so its loop is never even offered `kill` /
 * `disconnect` / `status` / `quit` / `read`; the interactive (internal) run
 * passes `true`. The default is `false` — fail-closed, so a caller that forgets
 * to opt in never leaks the control plane. Callers derive the flag from the
 * run's origin through `controlPlaneAllowed`, the same predicate the DISPATCH
 * half applies to the name the model sends back — withholding a tool is not the
 * boundary on its own, because a model can emit a name it was never offered.
 * See `control-plane.ts` for both halves. Governance (default-deny floor +
 * held-on-first-use) remains the backstop below this projection. `habenula` is
 * not an OAuth service and holds no credential, so it is exempt from the
 * `[NOT CONNECTED]` tag — it is always presented as `[CONNECTED]` when offered.
 */
export function buildToolDefinitions(
  connectedServices: string[],
  options?: { allowControlPlane?: boolean },
): LLMToolDefinition[] {
  const connected = new Set(connectedServices);
  const allowControlPlane = options?.allowControlPlane === true;
  return listTools()
    .filter((tool) => tool.service !== CONTROL_PLANE_SERVICE || allowControlPlane)
    .map((tool) => {
      // habenula holds no credential — never tag it [NOT CONNECTED].
      const tag =
        tool.service === CONTROL_PLANE_SERVICE || connected.has(tool.service)
          ? CONNECTED_TAG
          : NOT_CONNECTED_TAG;
      return {
        name: toolName(tool),
        description: `${tag} ${tool.description}`,
        input_schema: tool.inputSchema,
      };
    });
}
