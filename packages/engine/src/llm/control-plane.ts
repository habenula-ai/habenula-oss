// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { lookupTool } from "@habenula-ai/tools";
import type { RunOrigin } from "./conversation";

/**
 * The two-surface trust boundary, as one predicate both halves consult.
 *
 * The boundary is a first-class invariant: there is no path from an external
 * commissioning agent to `kill`, `disconnect`, or any other Habenula control,
 * and a locality-gated local route does not reach the control plane either.
 * Only a run driven from the trusted internal surface (`/internal/mcp`,
 * authorized by a verified caller token) may operate Habenula itself.
 *
 * Enforcing that takes BOTH halves, because the two are answerable to different
 * things:
 *
 *  - the OFFER — `buildToolDefinitions` withholds the `habenula` tools from a
 *    run that may not reach them, so the model is never told they exist;
 *  - the DISPATCH — `executeTool` refuses a `habenula` tool named by a run that
 *    may not reach them, however the name got there.
 *
 * The offer half alone is not the boundary. A commissioned goal is
 * attacker-authored text, and a model that is told to call a tool can emit a
 * name it was never offered. Gating only the projection leaves the boundary
 * enforced by what the engine offers rather than by what it accepts, and a
 * named-anyway call is then admitted at dispatch, governed, and parked as an
 * ordinary confirmation for the user to answer.
 */

/** The control-plane service in the tool registry. */
export const CONTROL_PLANE_SERVICE = "habenula";

/**
 * Whether a run on this trust surface may reach the control plane. The single
 * predicate — fail-closed on every origin but `internal`, so a surface added
 * later has to opt in deliberately rather than inherit access.
 */
export function controlPlaneAllowed(origin: RunOrigin): boolean {
  return origin === "internal";
}

/**
 * Whether `toolName` is a registered control-plane tool. Takes the raw name the
 * model emitted: an unregistered name resolves to no entry and is not a
 * control-plane tool, so it keeps travelling the ordinary unknown-tool path.
 */
export function isControlPlaneTool(toolName: string): boolean {
  return lookupTool(toolName)?.service === CONTROL_PLANE_SERVICE;
}

/**
 * The engine's refusal text. Fixed engine vocabulary — never model prose — so a
 * log reader can key on it and every site that reports a refusal says the same
 * thing.
 *
 * It lands in two places: the audit row's error message, on every refusal; and
 * the tool_result the model reads back, at the dispatch site and the resolve
 * site alike. It is never a wire `denyReason` — that field is the closed set of
 * remediations a caller can act on, and this refusal has none. The boundary
 * alarm carries registry-derived identifiers rather than this text, so it states
 * the same fact without a second copy of the string to keep in step.
 */
export const CONTROL_PLANE_REFUSAL =
  "Refused: Habenula's control plane is reachable only from the trusted internal surface";
