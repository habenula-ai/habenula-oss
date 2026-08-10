// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HabenulaEnv } from "../env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Tool schemas author against the SDK's zod major via the pinned alias — the
// SDK's runtime zod-compat accepts engine-v4 schemas but its TYPES are
// v3-shaped (the spike's pinned finding; zod-authoring.test.ts is the
// tripwire). Never `import { z } from "zod"` in this module.
import { z } from "zod-mcp";
// The canonical resolve-choice vocabulary. A plain readonly string array, not
// a zod schema, so importing it does not breach this module's zod-mcp rule —
// and deriving from it means the enum can no longer drift from the contract.
import { RESOLVE_CHOICES } from "@habenula-ai/contracts";
import { PHASE0_AGENT_ID } from "../agent/phase0";
import type { UserAgent } from "../agent/user-agent";
import { ENGINE_VERSION } from "./commission-server";

/** One tool result whose single content block is a JSON payload. */
function jsonResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The `UserAgent` surface the internal drive verbs reach — exactly these three
 * methods and nothing else, typed straight off the class so a signature drift
 * fails `tsc` instead of surfacing at runtime (mirrors `CommissionStub`). This
 * is the *drive* surface: send a message, answer a held confirmation, read
 * status. Control-plane operations (kill / disconnect / quit / policy) are NOT
 * exposed here as stub methods — they are reached by the agent's own tool loop
 * offered because `send` drives `chat` with `origin:"internal"`.
 * (RPC promise-wraps the sync members; `await` on them
 * is correct.)
 */
type InternalStub = Pick<
  UserAgent,
  "chat" | "resolveConfirmation" | "readStatus"
>;

/**
 * The trusted internal MCP surface, served
 * Worker-level from the `/internal/mcp` route via `createMcpHandler` — no
 * Durable Object of its own; every piece of state lives in the user's DO.
 * Built per request, closing over `env` and the request's `userId`, and
 * discarded with it: stateless by construction, exactly like
 * `buildCommissionServer`.
 *
 * This is the ONLY surface that reaches the control plane, and it does so
 * indirectly: `send` drives `chat` with `origin:"internal"`, which offers the
 * governed `habenula_*` control-plane tools to the agent. The
 * caller-token check on the route (index.ts) is the trust predicate; this
 * server never sees or handles that token (Hard Invariant #1).
 */
export function buildInternalServer(
  env: HabenulaEnv,
  userId: string,
): McpServer {
  const server = new McpServer({ name: "habenula", version: ENGINE_VERSION });
  const stub = () =>
    env.USER_AGENT.get(
      env.USER_AGENT.idFromName(userId),
    ) as unknown as InternalStub;

  server.registerTool(
    "send",
    {
      description:
        "Send a message to the Habenula agent and run one turn. The agent " +
        "plans and executes on the trusted internal surface: it can both task " +
        "external services and operate Habenula's own control plane (status, " +
        "kill, disconnect, quit) — every action governed by the user's policy " +
        "and held for confirmation on first use. If the turn parks a tool call, " +
        "the result carries a `held` reference; answer it with `resolve`.",
      inputSchema: { message: z.string().min(1) },
    },
    async ({ message }: { message: string }) => {
      try {
        // Drives the turn on the trusted surface: the
        // `internal` origin is what offers the control-plane tools this turn.
        const result = await stub().chat({
          message,
          userId,
          agentId: PHASE0_AGENT_ID,
          origin: "internal",
        });
        return jsonResult(result);
      } catch {
        // Fixed string only — a DO throw (e.g. an upstream LLM failure) must
        // not leak workerd/SQLite internals to the client (commission-server
        // error hygiene).
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerTool(
    "resolve",
    {
      description:
        "Answer a held confirmation by its handle. `deny` rejects the call; " +
        "`tell_more` returns the action's registry metadata without deciding; " +
        "`task` grants it once (consumed on use); `session` grants it for the " +
        "session; `approve_once` answers a SPEND hold — it dispatches the one " +
        "parked order and mints nothing (a spend hold accepts only deny and " +
        "approve_once; an ordinary hold rejects approve_once). A `resumed` " +
        "result carries the continued turn; a `not_found` status means the " +
        "held call is unknown or expired.",
      inputSchema: {
        heldCallId: z.string().min(1),
        choice: z.enum(RESOLVE_CHOICES),
      },
    },
    async ({
      heldCallId,
      choice,
    }: {
      heldCallId: string;
      choice: (typeof RESOLVE_CHOICES)[number];
    }) => {
      try {
        const resolution = await stub().resolveConfirmation({
          heldCallId,
          choice,
          userId,
          agentId: PHASE0_AGENT_ID,
        });
        return jsonResult(resolution);
      } catch {
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  server.registerTool(
    "status",
    {
      description:
        "Read the current governed-session snapshot: the active session, its " +
        "active grants, and every pending held call (oldest first). Carries " +
        "no conversation content.",
    },
    async () => {
      try {
        return jsonResult(await stub().readStatus());
      } catch {
        return jsonResult({ error: "internal engine error" }, true);
      }
    },
  );

  return server;
}
