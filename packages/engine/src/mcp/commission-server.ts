// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HabenulaEnv } from "../env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Tool schemas author against the SDK's zod major via the pinned alias — the
// SDK's runtime zod-compat accepts engine-v4 schemas but its TYPES are
// v3-shaped (the spike's pinned finding; zod-authoring.test.ts is the
// tripwire). Never `import { z } from "zod"` in this module.
import { z } from "zod-mcp";
import { PHASE0_AGENT_ID } from "../agent/phase0";
import type { UserAgent } from "../agent/user-agent";
import { listTools, publishedDataSlots, SERVICES } from "@habenula-ai/tools";

import { version as pkgVersion } from "../../package.json";

/**
 * Reported by `habenula_status` and as both MCP servers' serverInfo version.
 * Sourced from package.json, which the release train owns: a released engine
 * reports its real semver; a dev checkout reports the 0.0.0 placeholder.
 * Named import so esbuild tree-shakes the JSON to this one string instead of
 * inlining the whole manifest into the bundle.
 */
export const ENGINE_VERSION: string = pkgVersion;

import {
  COMMISSION_DATA_MAX_CHARS,
  COMMISSION_GOAL_MAX_CHARS,
} from "../agent/user-agent";

export const CAPABILITIES_URI = "habenula://capabilities";

/** One tool result whose single content block is a JSON payload. */
function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Boundary validation for an inbound `data` map, shared by commission / provide /
 * amend: only published slot keys (the closed vocabulary),
 * total value size within the cap. Returns an error tool-result to return
 * verbatim, or null when the map is acceptable. Unknown keys are rejected NAMING
 * the vocabulary so the client gets deterministic feedback with no LLM in the loop.
 * The DO re-validates as a fail-closed backstop.
 */
function validateDataMap(data: Record<string, string>): ReturnType<typeof jsonResult> | null {
  const published = publishedDataSlots();
  const unknown = Object.keys(data).filter((k) => !published.has(k));
  if (unknown.length > 0) {
    return jsonResult(
      {
        error: "unknown data keys",
        unknownKeys: unknown,
        publishedKeys: [...published.keys()],
      },
      true,
    );
  }
  const total = Object.values(data).reduce((n, v) => n + v.length, 0);
  if (total > COMMISSION_DATA_MAX_CHARS) {
    return jsonResult(
      {
        error: `data values exceed ${COMMISSION_DATA_MAX_CHARS} characters in total`,
      },
      true,
    );
  }
  return null;
}

/**
 * The `UserAgent` surface the commission verbs reach — exactly these methods
 * and nothing else, typed straight off the class so a signature drift fails
 * `tsc` instead of surfacing at runtime (0028A review). The closed interface
 * is enforced by what this module wires up: no
 * approve, kill, policy, chat, or credential path is reachable from an MCP
 * client. (RPC promise-wraps the sync members; `await` on them is correct.)
 */
type CommissionStub = Pick<
  UserAgent,
  | "commissionGoal"
  | "readCommissionRun"
  | "provideTaskInput"
  | "cancelTask"
  | "amendTask"
  | "listConnectedServices"
>;

/**
 * The inbound MCP commission surface, served
 * Worker-level from the `/mcp` route via `createMcpHandler` — no Durable
 * Object of its own; every piece of commission state lives in the user's DO.
 * Built per request, closing over `env` and the
 * request's `userId`, and discarded with it: stateless by construction.
 */
export function buildCommissionServer(
  env: HabenulaEnv,
  userId: string,
): McpServer {
  const server = new McpServer({ name: "habenula", version: ENGINE_VERSION });
  const stub = () =>
    env.USER_AGENT.get(
      env.USER_AGENT.idFromName(userId),
    ) as unknown as CommissionStub;

  server.registerTool(
    "habenula_commission",
    {
      description:
        "Commission Habenula to accomplish a goal. State the goal in your own " +
        "words — you never name or call Habenula's tools; its governed runtime " +
        "interprets the goal and selects the actions, each gated by the user's " +
        "policy. Put concrete values (identifiers, addresses, content) under " +
        "the published data slots (see the habenula://capabilities resource) so " +
        "they bind verbatim instead of round-tripping through a model. Include " +
        "everything the task needs: Habenula cannot ask you follow-up " +
        "questions. If the returned status is awaiting_confirmation, the user " +
        "must approve the action in their Habenula CLI — tell them so, then " +
        "poll habenula_result.",
      inputSchema: {
        goal: z.string().min(1).max(COMMISSION_GOAL_MAX_CHARS),
        data: z.record(z.string()).optional(),
      },
    },
    async ({ goal, data }: { goal: string; data?: Record<string, string> }) => {
      // Boundary validation of the data map, shared with
      // provide/amend so the three verbs cannot drift.
      if (data) {
        const invalid = validateDataMap(data);
        if (invalid) return invalid;
      }
      let outcome;
      try {
        outcome = await stub().commissionGoal({
          goal,
          data,
          userId,
          agentId: PHASE0_AGENT_ID,
        });
      } catch {
        // Fixed string only — a DO throw must not leak workerd/SQLite
        // internals to the untrusted client.
        return jsonResult({ error: "internal engine error" }, true);
      }
      if (outcome.status === "busy") {
        // No run was created; the client retries.
        return jsonResult({ busy: true, reason: outcome.reason });
      }
      return jsonResult(outcome);
    },
  );

  server.registerTool(
    "habenula_status",
    {
      description:
        "Lightweight liveness check for the Habenula engine. Returns whether " +
        "the runtime is reachable and its version. Carries no per-run state — " +
        "use habenula_result to read a commissioned run's status.",
    },
    () => jsonResult({ running: true, version: ENGINE_VERSION }),
  );

  server.registerTool(
    "habenula_result",
    {
      description:
        "Read the status of a commissioned run by its handle. Returns " +
        "run-level status (running, awaiting_confirmation, needs_input, " +
        "completed, failed, denied, expired, cancelled) plus a per-action " +
        "breakdown and, for a needs_input run, the published data-slot key(s) " +
        "it awaits — answer those with habenula_provide. Never the work " +
        "product; results of governed actions stay inside the user's runtime.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }: { runId: string }) => {
      try {
        const view = await stub().readCommissionRun(runId);
        return jsonResult(view ?? { status: "not_found" });
      } catch {
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerTool(
    "habenula_provide",
    {
      description:
        "Answer a commissioned task that is waiting on a required value " +
        "(status needs_input). Supply the value(s) under the published " +
        "data-slot key(s) named in the task's awaitedSlotKeys (see " +
        "habenula_result / the habenula://capabilities resource); they bind " +
        "verbatim, exactly like the original commission's data, and the task " +
        "resumes. Input-only: it cannot approve, deny, or reach a tool, and " +
        "answers only a task you commissioned. If the resumed action still " +
        "needs the user's approval the status becomes awaiting_confirmation — " +
        "tell them so, then poll habenula_result.",
      inputSchema: {
        taskId: z.string().min(1),
        data: z.record(z.string()),
      },
    },
    async ({ taskId, data }: { taskId: string; data: Record<string, string> }) => {
      // Boundary validation of the data map, shared with
      // commission/amend so the three verbs cannot drift.
      const invalid = validateDataMap(data);
      if (invalid) return invalid;
      try {
        const outcome = await stub().provideTaskInput({
          taskId,
          data,
          userId,
          agentId: PHASE0_AGENT_ID,
        });
        // A key set that doesn't intersect the awaited slots is a boundary
        // refusal (like an unknown key) — surface it as an error naming the
        // slots the task actually awaits.
        if (outcome.status === "no_matching_slot") {
          return jsonResult(outcome, true);
        }
        return jsonResult(outcome);
      } catch {
        // Fixed string only — a DO throw must not leak internals to the
        // untrusted client.
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerTool(
    "habenula_cancel",
    {
      description:
        "Cancel a commissioned task by its handle. Moves a parked task to " +
        "cancelled and sweeps the holds it owns. Scoped to commissioned tasks: " +
        "it cannot cancel the user's own CLI-originated tasks, approve anything, " +
        "or reach a tool. A running task holds the live turn and is not cancelled " +
        "mid-flight (status 'running' — retry once it parks); a task whose " +
        "confirmation is mid-resolve returns 'resolving'; an already-finished " +
        "task returns 'not_cancellable'.",
      inputSchema: { taskId: z.string().min(1) },
    },
    async ({ taskId }: { taskId: string }) => {
      try {
        const outcome = await stub().cancelTask({
          taskId,
          // Origin-scoped: a cross-ORIGIN cancel (of a `human` task) is refused
          // inside the DO. There is no inbound client
          // identity, so this is not per-client ownership — see the DO docstring.
          surface: "mcp",
          userId,
          agentId: PHASE0_AGENT_ID,
        });
        // Collapse `forbidden` and `not_found` into ONE identical response: two
        // distinguishable shapes would let an external client probe which task
        // ids exist in the user's DO and which are out of its scope.
        if (outcome.status === "forbidden" || outcome.status === "not_found") {
          return jsonResult({ status: "not_found" });
        }
        return jsonResult(outcome);
      } catch {
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerTool(
    "habenula_amend",
    {
      description:
        "Correct a commissioned task that is waiting on input (status " +
        "needs_input): re-supply its data value(s) under the published " +
        "data-slot key(s). Values bind verbatim, exactly like the original " +
        "commission's data. Input-only: it cannot approve, deny, cancel another " +
        "origin's task, or reach a tool. Amend only PERSISTS the corrected data — " +
        "use habenula_provide to actually answer and resume the task. A task " +
        "already awaiting the user's approval is NOT amendable (the user must " +
        "approve the value they were shown); cancel and re-commission instead.",
      inputSchema: {
        taskId: z.string().min(1),
        data: z.record(z.string()),
      },
    },
    async ({ taskId, data }: { taskId: string; data: Record<string, string> }) => {
      const invalid = validateDataMap(data);
      if (invalid) return invalid;
      try {
        const outcome = await stub().amendTask({
          taskId,
          data,
          userId,
          agentId: PHASE0_AGENT_ID,
        });
        // Collapse `forbidden` and `not_found` — see habenula_cancel: two
        // distinguishable shapes are an existence/scope oracle.
        if (outcome.status === "forbidden" || outcome.status === "not_found") {
          return jsonResult({ status: "not_found" });
        }
        return jsonResult(outcome);
      } catch {
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerResource(
    "capabilities",
    CAPABILITIES_URI,
    {
      description:
        "What Habenula can be commissioned to do for this user: every " +
        "service with its connection state, verb classes, and published data " +
        "slots. Informational — none of these are callable tools here.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      let connectedList: { service: string }[];
      try {
        connectedList = await stub().listConnectedServices();
      } catch {
        // Never fabricate "nothing connected" — the resource's whole purpose
        // is freshness. Fixed string keeps error hygiene.
        throw new Error("internal engine error");
      }
      const connected = new Set(connectedList.map((s) => s.service));
      const services = SERVICES.map((def) => ({
        service: def.service,
        connected: connected.has(def.service),
        verbs: listTools()
          .filter((t) => t.service === def.service)
          .map((t) => ({
            verb: t.verb,
            dataSlots: t.dataSlots ?? [],
          })),
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ services }),
          },
        ],
      };
    },
  );

  return server;
}
