import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { asTurn } from "../helpers/turn";
import { parseTurnState, wrapTurnState } from "../../src/llm/canonical";
import { CANONICAL_SHAPE_VERSION } from "../../src/llm/canonical";
import { CONTROL_PLANE_REFUSAL } from "../../src/llm/control-plane";
import type {
  LLMClient,
  LLMContentBlock,
  LLMCreateParams,
  LLMMessage,
  LLMResponse,
  LLMToolResultBlock,
  LLMToolUseBlock,
} from "../../src/llm/types";

/**
 * Control-plane tools — governance (the trust
 * boundary). The `habenula` service adds five governed
 * tools that operate the control plane through the EXACT governance pipeline
 * every external tool uses, plus a tool-surface gate that keeps them off any
 * commission-originated run.
 *
 * All tests run against a real DO (Hard Invariant #5) with an injected mock LLM
 * — no platform primitives are mocked. The mock emits a scripted tool call
 * directly, which is exactly how an attacker-authored goal reaches the control
 * plane: a model can name a tool it was never offered. So the surface is
 * asserted twice over — the OFFER, by capturing the tools sent to the model, and
 * the DISPATCH, by scripting a control-plane name on a run that may not reach it
 * and asserting the engine refuses rather than parks it. A test that means to
 * exercise a control-plane dispatch drives `origin: "internal"`, because that is
 * the only surface from which one is reachable.
 */

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

function cpToolUse(name: string, input: Record<string, unknown> = {}): LLMToolUseBlock {
  return { type: "tool_use", id: `tu-${name}`, name, input };
}

/** Mock LLM emitting a scripted sequence, one response per call. */
function scriptedLLM(
  script: Array<{ tools?: LLMToolUseBlock[]; text?: string }>,
): LLMClient {
  let i = 0;
  return {
    async createMessage(_params: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step.tools && step.tools.length > 0) {
        return {
          id: `msg_${i}`,
          content: step.tools,
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: `msg_${i}`,
        content: [{ type: "text", text: step.text ?? "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

/**
 * Wrap an LLM to record what each request showed the model: the tool surface
 * (names offered) and the messages (what it was told about earlier calls).
 */
function capturing(inner: LLMClient): {
  client: LLMClient;
  toolNamesPerCall: string[][];
  messagesPerCall: LLMMessage[][];
} {
  const toolNamesPerCall: string[][] = [];
  const messagesPerCall: LLMMessage[][] = [];
  const client: LLMClient = {
    async createMessage(params) {
      toolNamesPerCall.push((params.tools ?? []).map((t) => t.name));
      messagesPerCall.push(
        JSON.parse(JSON.stringify(params.messages)) as LLMMessage[],
      );
      return inner.createMessage(params);
    },
  };
  return { client, toolNamesPerCall, messagesPerCall };
}

/** Every tool_result block the model was shown across all recorded requests. */
function toolResultsSeen(messagesPerCall: LLMMessage[][]): LLMToolResultBlock[] {
  return messagesPerCall
    .flat()
    .flatMap((m): LLMContentBlock[] => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is LLMToolResultBlock => b.type === "tool_result");
}

const CONTROL_PLANE_NAMES = [
  "habenula_status",
  "habenula_kill",
  "habenula_disconnect",
  "habenula_quit",
  "habenula_read",
];

describe("control-plane tools — held on first use (no read bypass)", () => {
  it("a control-plane read holds for confirmation — NOT force-denied not_connected", async () => {
    // habenula is never OAuth-connected. Without the not-connected exemption the
    // call would force-deny as not_connected before the askable path; with it,
    // the call reaches the pending/held path exactly like any external tool.
    const userId = "cp-hold-user";
    const stub = getStub();
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_status")] }]);

    const result = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "what's my status?", userId, origin: "internal" })
        .then(asTurn);
    });

    expect(result.held?.heldCallId).toBeTruthy();
    expect(result.response).toBe("");
    expect(result.toolCalls.at(-1)?.outcome).toBe("held");

    const audit = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ tool_name: string; decision: string; outcome: string }>`
        SELECT tool_name, decision, outcome FROM audit_log ORDER BY sequence_num
      `;
    });
    // session.start, then a PENDING decision for the read — not a not_connected deny.
    expect(audit.map((r) => r.tool_name)).toEqual(["session.start", "habenula_status"]);
    expect(audit[1]!.decision).toBe("pending");

    const held = await runInDurableObject(stub, (instance) => {
      return instance.sql<{ id: string; turn_state: string }>`
        SELECT id, turn_state FROM held_tool_calls
      `;
    });
    expect(held).toHaveLength(1);
    expect(held[0]!.turn_state).not.toBe("");
  });

  it("holds the read even against a persisted default-deny floor (governed like any tool)", async () => {
    const userId = "cp-hold-policy-user";
    const stub = getStub();
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_read")] }]);
    const result = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "show policy", userId, origin: "internal" })
        .then(asTurn);
    });
    expect(result.held?.heldCallId).toBeTruthy();
  });
});

describe("control-plane tools — dispatch routes to the DO method on grant", () => {
  it("habenula_status → readStatus (resumed with the status snapshot)", async () => {
    const userId = "cp-status-user";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_status")] },
      { text: "here is your status" },
    ]);
    const first = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.chat({ message: "status", userId, origin: "internal" }).then(asTurn);
    });
    const heldCallId = first.held!.heldCallId;
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "session", userId }),
    );
    expect(resolved.status).toBe("resumed");
    if (resolved.status === "resumed") {
      expect(resolved.result.toolCalls).toEqual([
        { name: "habenula_status", id: "tu-habenula_status", outcome: "success" },
      ]);
    }
  });

  it("habenula_read → getStandingEntries (resumed successfully)", async () => {
    const userId = "cp-read-user";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_read")] },
      { text: "policy read" },
    ]);
    const first = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "read policy", userId, origin: "internal" })
        .then(asTurn);
    });
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: first.held!.heldCallId,
        choice: "session",
        userId,
      }),
    );
    expect(resolved.status).toBe("resumed");
    if (resolved.status === "resumed") {
      expect(resolved.result.toolCalls.at(-1)?.outcome).toBe("success");
    }
  });

  it("habenula_disconnect → disconnectService(params.service) clears the connection", async () => {
    const userId = "cp-disconnect-user";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_disconnect", { service: "mock_email" })] },
      { text: "disconnected" },
    ]);
    const first = await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(client);
      expect(instance.isServiceConnected("mock_email")).toBe(true);
      return instance
        .chat({ message: "disconnect mock_email", userId, origin: "internal" })
        .then(asTurn);
    });
    await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: first.held!.heldCallId,
        choice: "session",
        userId,
      }),
    );
    const stillConnected = await runInDurableObject(stub, (instance) =>
      instance.isServiceConnected("mock_email"),
    );
    expect(stillConnected).toBe(false);
  });

  it("habenula_quit → endSession('quit') ends the active session", async () => {
    const userId = "cp-quit-user";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_quit")] },
      { text: "session ended" },
    ]);
    const first = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.chat({ message: "quit", userId, origin: "internal" }).then(asTurn);
    });
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: first.held!.heldCallId,
        choice: "session",
        userId,
      }),
    );
    expect(resolved.status).toBe("resumed");
    const session = await runInDurableObject(stub, (instance) =>
      instance.getActiveSession(),
    );
    expect(session).toBeNull();
  });

  it("habenula_kill → killSwitch sets the deny-all floor (and does not throw mid-resume)", async () => {
    const userId = "cp-kill-user";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_kill")] },
      { text: "killed" },
    ]);
    const first = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "kill everything", userId, origin: "internal" })
        .then(asTurn);
    });
    // Granting kill mints a session grant, then killSwitch (dispatched inside
    // the resolve) sweeps every grant AND every held row — including the one
    // being finalized. resumeAndFinalize's delete-by-id becomes a harmless
    // no-op; the resume must still complete without throwing.
    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({
        heldCallId: first.held!.heldCallId,
        choice: "session",
        userId,
      }),
    );
    expect(resolved.status).toBe("resumed");
    const after = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      entries: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map(
        (r) => r.id,
      ),
    }));
    expect(after.held).toBe(0);
    expect(after.entries).toEqual(["default-deny"]); // only the deny floor remains
  });
});

describe("control-plane tools — trust boundary", () => {
  it("a default (no-origin) chat is NOT offered the control-plane tools — fail-closed", async () => {
    // The default origin is `human`: a caller that omits
    // `origin` — the local `/api/chat` path, gated by network locality only —
    // must NOT be offered the control plane. Only the token-gated `/internal/mcp`
    // surface (origin:internal, asserted below) reaches it.
    const userId = "cp-default-surface";
    const stub = getStub();
    const { client, toolNamesPerCall } = capturing(scriptedLLM([{ text: "hi" }]));
    await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.chat({ message: "hello", userId }).then(asTurn);
    });
    expect(toolNamesPerCall).toHaveLength(1);
    for (const cp of CONTROL_PLANE_NAMES) {
      expect(toolNamesPerCall[0]).not.toContain(cp);
    }
  });

  it("an internal chat with origin:internal is offered them; nothing else changes the axis", async () => {
    const userId = "cp-internal-explicit";
    const stub = getStub();
    const { client, toolNamesPerCall } = capturing(scriptedLLM([{ text: "hi" }]));
    await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "hello", userId, origin: "internal" })
        .then(asTurn);
    });
    for (const cp of CONTROL_PLANE_NAMES) {
      expect(toolNamesPerCall[0]).toContain(cp);
    }
  });

  it("a commission run is NEVER offered the control-plane tools", async () => {
    const userId = "cp-commission-surface";
    const stub = getStub();
    const { client, toolNamesPerCall } = capturing(scriptedLLM([{ text: "done" }]));
    await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.commissionGoal({
        goal: "summarize my unread mail",
        userId,
        agentId: "agent-1",
      });
    });
    expect(toolNamesPerCall.length).toBeGreaterThanOrEqual(1);
    for (const names of toolNamesPerCall) {
      for (const cp of CONTROL_PLANE_NAMES) {
        expect(names).not.toContain(cp);
      }
    }
  });

  it("an internal hold persists origin=internal on the held-turn state", async () => {
    const userId = "cp-origin-internal";
    const stub = getStub();
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_status")] }]);
    await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "status", userId, origin: "internal" })
        .then(asTurn);
    });
    const origin = await runInDurableObject(stub, (instance) => {
      const row = [...instance.sql<{ turn_state: string }>`
        SELECT turn_state FROM held_tool_calls
      `][0]!;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) throw new Error("held turn_state must parse");
      return parsed.state.origin;
    });
    expect(origin).toBe("internal");
  });

  it("a commission hold persists origin=commission and resumes with the control plane still off", async () => {
    const userId = "cp-origin-commission";
    const stub = getStub();
    // Commission holds on an external tool, then a capturing resume asserts the
    // resumed surface still excludes the control plane (origin re-derived).
    const inner = scriptedLLM([
      { tools: [{ type: "tool_use", id: "tu-c", name: "mock_email_list", input: { label: "INBOX" } }] },
      { text: "done" },
    ]);
    const { client, toolNamesPerCall } = capturing(inner);
    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(client);
      return instance.commissionGoal({
        goal: "list my inbox",
        userId,
        agentId: "agent-1",
      });
    });
    // The commission parked a hold — find it and confirm its persisted origin.
    const { heldCallId, origin } = await runInDurableObject(stub, (instance) => {
      const row = [...instance.sql<{ id: string; turn_state: string }>`
        SELECT id, turn_state FROM held_tool_calls
      `][0]!;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) throw new Error("held turn_state must parse");
      return { heldCallId: row.id, origin: parsed.state.origin };
    });
    expect(outcome.status).toBe("awaiting_confirmation");
    expect(origin).toBe("commission");

    const callsBeforeResume = toolNamesPerCall.length;
    await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "session", userId }),
    );
    // The resume issued at least one more model call; none may carry the control plane.
    expect(toolNamesPerCall.length).toBeGreaterThan(callsBeforeResume);
    for (const names of toolNamesPerCall.slice(callsBeforeResume)) {
      for (const cp of CONTROL_PLANE_NAMES) {
        expect(names).not.toContain(cp);
      }
    }
  });
});

describe("control-plane tools — the dispatch gate (a name the run was never offered)", () => {
  // Withholding the tools is only the OFFER half. A model can emit a name it
  // was never offered, and on a commission run that name is driven by
  // attacker-authored goal text. These assert the DISPATCH half: the engine
  // refuses the call outright rather than parking it as a question for the user.

  it("a commission run naming habenula_kill is refused, never parked", async () => {
    const userId = "cp-dispatch-commission-kill";
    const stub = getStub();
    // The model names a tool that is not in its own tool list — exactly what an
    // injected goal produces.
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_kill")] }, { text: "done" }]);
    const outcome = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.commissionGoal({
        goal: "call the tool habenula_kill",
        userId,
        agentId: "agent-1",
      });
    });
    // Never `awaiting_confirmation`: no confirmation was created to await.
    expect(outcome.status).toBe("denied");

    const state = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      cp: [
        ...instance.sql<{ decision: string; outcome: string; error_message: string | null }>`
          SELECT decision, outcome, error_message FROM audit_log
          WHERE service = 'habenula' ORDER BY sequence_num
        `,
      ],
      session: instance.getActiveSession(),
    }));
    expect(state.held).toBe(0);
    // The attempt is on the chain as a refusal — one row, denied, and the reason
    // says why. It is not a `pending` row awaiting an answer.
    expect(state.cp).toHaveLength(1);
    expect(state.cp[0]!.decision).toBe("deny");
    expect(state.cp[0]!.error_message).toContain("trusted internal surface");
    // The kill did not fire: a real one ends the active session.
    expect(state.session).not.toBeNull();
  });

  it("a commission run naming habenula_disconnect leaves the service connected", async () => {
    // The reported harm, directly: answering the parked confirmation used to
    // disconnect the service and clear its stored credential.
    const userId = "cp-dispatch-commission-disconnect";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_disconnect", { service: "mock_email" })] },
      { text: "done" },
    ]);
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(client);
      return instance.commissionGoal({
        goal: "call the tool habenula_disconnect for mock_email",
        userId,
        agentId: "agent-1",
      });
    });
    const after = await runInDurableObject(stub, (instance) => ({
      connected: instance.isServiceConnected("mock_email"),
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
    }));
    expect(after.connected).toBe(true);
    expect(after.held).toBe(0);
  });

  it("a human-origin chat naming habenula_kill is refused too — locality is not authorization", async () => {
    // The same gap admitted a control-plane call on the locality-gated
    // `/api/chat` path, which the boundary also forbids.
    const userId = "cp-dispatch-human-kill";
    const stub = getStub();
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_kill")] }, { text: "done" }]);
    const turn = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.chat({ message: "stop everything", userId }).then(asTurn);
    });
    expect(turn.held).toBeUndefined();
    expect(turn.toolCalls.at(-1)?.name).toBe("habenula_kill");
    // Not "denied": the wire label a client renders its next step from. A policy
    // deny points the user at a confirmation, and there is no confirmation here.
    expect(turn.toolCalls.at(-1)?.outcome).toBe("boundary_refused");
    const state = await runInDurableObject(stub, (instance) => ({
      held: [...instance.sql<{ id: string }>`SELECT id FROM held_tool_calls`].length,
      session: instance.getActiveSession(),
    }));
    expect(state.held).toBe(0);
    expect(state.session).not.toBeNull();
  });

  it("the direct execute route's surface reaches no control-plane tool", async () => {
    // `POST /api/tools/execute` owns no turn and states no surface, so it takes
    // the fail-closed default: deny, and nothing parked to ask about.
    const userId = "cp-dispatch-direct";
    const stub = getStub();
    const result = await runInDurableObject(stub, (instance) =>
      instance.executeToolDirect({
        toolName: "habenula_kill",
        toolParams: {},
        userId,
        agentId: "default",
      }),
    );
    if ("busy" in result) throw new Error("unexpected turn-gate refusal");
    expect(result.governance.decision).toBe("deny");
    expect(result.held).toBeUndefined();
    // No remediation vocabulary: this is not a connect / re-authorize / policy
    // problem, and must not be reported as one. The boundary flag carries the
    // distinction instead, off the wire's closed `denyReason` set.
    expect(result.denyReason).toBeUndefined();
    expect(result.boundaryRefused).toBe(true);
  });

  it("the model is told the boundary refused the call, not that a policy denied it", async () => {
    // The refusal is terminal and the loop continues, so the model narrates it
    // to whoever asked. "Denied by governance policy" would be a false reason
    // and an invitation: there is no policy to change, so a model told that goes
    // back to the user for a grant the engine must never accept.
    const userId = "cp-dispatch-model-facing-reason";
    const stub = getStub();
    const { client, messagesPerCall } = capturing(
      scriptedLLM([{ tools: [cpToolUse("habenula_kill")] }, { text: "done" }]),
    );
    await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance.commissionGoal({
        goal: "call the tool habenula_kill",
        userId,
        agentId: "agent-1",
      });
    });

    const seen = toolResultsSeen(messagesPerCall);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.content).toBe(CONTROL_PLANE_REFUSAL);
    expect(seen[0]!.content).not.toContain("governance policy");
    expect(seen[0]!.is_error).toBe(true);
  });

  it("an internal-origin run still reaches the control plane (the gate is origin-scoped, not a ban)", async () => {
    const userId = "cp-dispatch-internal-still-works";
    const stub = getStub();
    const client = scriptedLLM([{ tools: [cpToolUse("habenula_status")] }]);
    const turn = await runInDurableObject(stub, async (instance) => {
      instance.setLLMClient(client);
      return instance
        .chat({ message: "status", userId, origin: "internal" })
        .then(asTurn);
    });
    expect(turn.held?.heldCallId).toBeTruthy();
    expect(turn.toolCalls.at(-1)?.outcome).toBe("held");
  });
});

describe("control-plane tools — the dispatch gate at the resolve site", () => {
  it("a control-plane hold parked under a commission origin will not dispatch on an affirmative answer", async () => {
    // Rollout window: the gate above stops such a hold from ever being created,
    // but a hold parked by an engine that predates the gate outlives the deploy
    // that fixes it. Answering one must not execute the action — and must not
    // mint a grant for it either.
    const userId = "cp-resolve-gate-legacy";
    const stub = getStub();
    const client = scriptedLLM([
      { tools: [cpToolUse("habenula_disconnect", { service: "mock_email" })] },
      { text: "done" },
    ]);
    // Park it the only way this engine still can: on the internal surface.
    const first = await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(client);
      return instance
        .chat({ message: "disconnect mock_email", userId, origin: "internal" })
        .then(asTurn);
    });
    const heldCallId = first.held!.heldCallId;

    // Rewrite the persisted surface to `commission`, standing in for a hold a
    // pre-gate engine admitted from the inbound door.
    await runInDurableObject(stub, (instance) => {
      const row = [...instance.sql<{ turn_state: string }>`
        SELECT turn_state FROM held_tool_calls WHERE id = ${heldCallId}
      `][0]!;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) throw new Error("held turn_state must parse");
      instance.storeHeldTurnState(
        heldCallId,
        wrapTurnState({ ...parsed.state, origin: "commission" }),
      );
    });

    const resolved = await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "session", userId }),
    );
    expect(resolved.status).toBe("resumed");
    if (resolved.status === "resumed") {
      // The resolve site reports the refusal as itself on the wire too. An
      // affirmative answer that came back labelled "denied" would read to the
      // client as the user's own decision on a policy they could change.
      expect(resolved.result.toolCalls.at(-1)?.outcome).toBe("boundary_refused");
    }
    const after = await runInDurableObject(stub, (instance) => ({
      connected: instance.isServiceConnected("mock_email"),
      grants: [...instance.sql<{ id: string }>`SELECT id FROM policy_entries`].map(
        (r) => r.id,
      ),
      refusal: [
        ...instance.sql<{ decision: string; error_message: string | null }>`
          SELECT decision, error_message FROM audit_log
          WHERE service = 'habenula' AND decision = 'deny' ORDER BY sequence_num
        `,
      ],
    }));
    // The service survives, the affirmative answer minted nothing, and the
    // refusal is recorded as the engine's, not as the user's decision.
    expect(after.connected).toBe(true);
    expect(after.grants).toEqual(["default-deny"]);
    expect(after.refusal).toHaveLength(1);
    expect(after.refusal[0]!.error_message).toContain("trusted internal surface");
  });
});

describe("control-plane tools — legacy hold fail-closed fallback", () => {
  it("a commission hold with NO persisted origin resumes with control plane still off", async () => {
    // Defense-in-depth for the rollout window: a commission hold parked by
    // pre-0291B code (or any origin-less turn_state) has no persisted `origin`.
    // Resume must fall back on the run link — a run-linked (commission) hold
    // derives `commission`, so the control plane stays off. This exercises
    // `heldRunOrigin`'s fallback, NOT the persisted-origin path the other
    // boundary test covers.
    const userId = "cp-legacy-fallback";
    const stub = getStub();
    const inner = scriptedLLM([
      { tools: [{ type: "tool_use", id: "tu-l", name: "mock_email_list", input: { label: "INBOX" } }] },
      { text: "done" },
    ]);
    const { client, toolNamesPerCall } = capturing(inner);
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("mock_email");
      instance.setLLMClient(client);
      return instance.commissionGoal({ goal: "list inbox", userId, agentId: "agent-1" });
    });

    // Strip the persisted `origin`, simulating a hold written before the field
    // existed — the row keeps its run_id (commission), turn_state loses origin.
    const heldCallId = await runInDurableObject(stub, (instance) => {
      const row = [...instance.sql<{ id: string; turn_state: string }>`
        SELECT id, turn_state FROM held_tool_calls
      `][0]!;
      const parsed = parseTurnState(row.turn_state);
      if (!parsed.ok) throw new Error("held turn_state must parse");
      const { origin: _dropped, ...withoutOrigin } = parsed.state;
      instance.storeHeldTurnState(row.id, wrapTurnState(withoutOrigin));
      return row.id;
    });

    // Confirm the strip worked — the row now has no origin.
    const strippedOrigin = await runInDurableObject(stub, (instance) => {
      const row = [...instance.sql<{ turn_state: string }>`
        SELECT turn_state FROM held_tool_calls WHERE id = ${heldCallId}
      `][0]!;
      const parsed = parseTurnState(row.turn_state);
      return parsed.ok ? parsed.state.origin : "PARSE_FAIL";
    });
    expect(strippedOrigin).toBeUndefined();

    const callsBeforeResume = toolNamesPerCall.length;
    await runInDurableObject(stub, (instance) =>
      instance.resolveConfirmation({ heldCallId, choice: "session", userId }),
    );
    expect(toolNamesPerCall.length).toBeGreaterThan(callsBeforeResume);
    for (const names of toolNamesPerCall.slice(callsBeforeResume)) {
      for (const cp of CONTROL_PLANE_NAMES) {
        expect(names).not.toContain(cp);
      }
    }
  });
});

describe("control-plane tools — envelope invariants", () => {
  it("the canonical shape version is unchanged (origin was additive, not a bump)", () => {
    expect(CANONICAL_SHAPE_VERSION).toBe(1);
  });

  it("parseTurnState never throws on an origin-carrying envelope", () => {
    // A v1 envelope with origin present, and a legacy bare state with none —
    // both parse without throwing (the no-throw contract).
    const withOrigin = JSON.stringify({
      v: 1,
      state: { messages: [], heldCall: { type: "tool_use", id: "x", name: "habenula_kill", input: {} }, parkedCalls: [], producedResults: [], iterationsUsed: 0, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, origin: "commission" },
    });
    const legacyBare = JSON.stringify({
      messages: [], heldCall: { type: "tool_use", id: "x", name: "gmail_list", input: {} }, parkedCalls: [], producedResults: [], iterationsUsed: 0, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(parseTurnState(withOrigin).ok).toBe(true);
    const parsedLegacy = parseTurnState(legacyBare);
    expect(parsedLegacy.ok).toBe(true);
    if (parsedLegacy.ok) expect(parsedLegacy.state.origin).toBeUndefined();
  });
});
