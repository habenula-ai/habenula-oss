// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";

/**
 * The `habenula` control-plane service. Operating Habenula itself — status,
 * kill, disconnect, quit,
 * read-policy — becomes a family of first-class governed `(habenula, verb,
 * noun)` tools, so the agent driving the control plane stays inside the exact
 * governance frame every external tool uses: denied against the
 * `default-deny` floor and held for confirmation-as-onboarding on first use,
 * reads (`status`, `read`) included — there is no default-allow read path.
 *
 * `connect: { type: "none" }` — this is the first non-OAuth service. It holds
 * no credential: there is nothing to authorize, and every tool here operates
 * the local Durable Object. Dispatch is special-cased in the DO
 * (`dispatchTool` → the existing `readStatus`/`killSwitch`/`disconnectService`/
 * `endSession`/`getStandingEntries` methods), so the `execute` bodies below are
 * an unreachable guard, never the live path. The tools carry no
 * `requiredScopes` (a `none` service has no granted-scope blob to gate on), and
 * they are exempted from the connection pre-check and the `[NOT CONNECTED]`
 * definition tag — without those exemptions every call would force-deny as
 * `not_connected` before reaching the askable/held path.
 *
 * Nouns are concrete literals (`self`, `all`, `session`, `standing`) or the
 * verbatim service name for `disconnect` — never wildcards, which
 * `assertScopedGrant` rejects.
 */

/**
 * Shared unreachable-path guard. Control-plane tools never execute through the
 * catalog `execute`; dispatch routes `service === "habenula"` to a DO method.
 * If this ever runs, routing regressed — fail closed and loud rather than
 * silently succeeding.
 */
const CONTROL_PLANE_GUARD: ToolExecutionResult = {
  success: false,
  error:
    "habenula control-plane tools dispatch via the Durable Object, not the tool executor",
};

const controlPlaneGuard = (): Promise<ToolExecutionResult> =>
  Promise.resolve(CONTROL_PLANE_GUARD);

/**
 * Report the agent's own operating state: the active session, its grants, and
 * any pending held call (→ `readStatus`). A read, and governed as one — held
 * for confirmation on first use like every other control-plane tool, so
 * `status` cannot be used for silent reconnaissance from an injected prompt.
 */
export const HABENULA_STATUS: Tool = {
  service: "habenula",
  verb: "status",
  description:
    "Report Habenula's own operating state: the active session, its active " +
    "grants, and any tool call awaiting the user's confirmation. Takes no " +
    "parameters.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  nounExtractor: () => "self",
  execute: controlPlaneGuard,
};

/**
 * Emergency stop — set the global deny-all floor, sweeping every session and
 * task grant and every held call (→ `killSwitch`). Governed as the coarsest
 * control-plane action (noun `all`); a first-use call is held for the user to
 * confirm before the kill takes effect.
 */
export const HABENULA_KILL: Tool = {
  service: "habenula",
  verb: "kill",
  description:
    "Emergency stop: revoke all grants and halt all agent tool execution by " +
    "setting Habenula's global deny-all floor. Connections and stored " +
    "credentials are left intact. Takes no parameters.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  nounExtractor: () => "all",
  execute: controlPlaneGuard,
};

/**
 * Disconnect one service and clear its stored credential (→
 * `disconnectService`). The governed noun is the service being disconnected —
 * a grant is per-target-service, and the DO call disconnects the exact same
 * string the noun is derived from, so noun and effect cannot diverge.
 */
export const HABENULA_DISCONNECT: Tool = {
  service: "habenula",
  verb: "disconnect",
  description:
    "Disconnect a connected service and clear its stored credential. Takes " +
    "the internal service name to disconnect, e.g. gmail or slack.",
  inputSchema: {
    type: "object",
    properties: {
      service: {
        type: "string",
        description:
          "Internal name of the service to disconnect, e.g. gmail, slack, github.",
      },
    },
    required: ["service"],
  },
  nounExtractor: (params) => String(params.service),
  execute: controlPlaneGuard,
};

/**
 * End the active session explicitly, freeing the single-session slot without
 * waiting out the 90-minute timeout (→ `endSession("quit")`). Governed on the
 * `session` noun.
 */
export const HABENULA_QUIT: Tool = {
  service: "habenula",
  verb: "quit",
  description:
    "End the active Habenula session now, freeing the session slot without " +
    "waiting for the 90-minute timeout. Takes no parameters.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  nounExtractor: () => "session",
  execute: controlPlaneGuard,
};

/**
 * Read the standing policy entries (→ `getStandingEntries`). Read-only: policy
 * mutation over `/api` was removed, and `habenula policy edit` stays a
 * client-side `$EDITOR` flow outside the agent's tool reach. Governed on the
 * `standing` noun; held for confirmation on first use like the `status` read.
 */
export const HABENULA_POLICY: Tool = {
  service: "habenula",
  verb: "read",
  description:
    "Read Habenula's standing policy entries (the persistent governance " +
    "floor). Read-only — this does not change any policy. Takes no parameters.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  nounExtractor: () => "standing",
  execute: controlPlaneGuard,
};

/**
 * The habenula service: declarative data only. `connect: { type: "none" }` — no
 * OAuth, no credential. Dispatch of these tools is special-cased in the DO;
 * the catalog entries carry only the governance-facing metadata
 * (service/verb/nounExtractor/inputSchema/description).
 */
export const habenula: ServiceDefinition = {
  service: "habenula",
  connect: {
    type: "none",
  },
  tools: [
    HABENULA_STATUS,
    HABENULA_KILL,
    HABENULA_DISCONNECT,
    HABENULA_QUIT,
    HABENULA_POLICY,
  ],
};
