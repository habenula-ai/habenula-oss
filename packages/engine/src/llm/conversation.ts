// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { UNRECOGNIZED_TOOL_NAME } from "@habenula-ai/contracts";
import { lookupTool, toolName } from "@habenula-ai/tools";
import { CONTROL_PLANE_REFUSAL } from "./control-plane";
import type {
  LLMClient,
  LLMCreateParams,
  LLMMessage,
  LLMToolDefinition,
  LLMToolUseBlock,
  LLMToolResultBlock,
} from "./types";
import { fenceUntrusted } from "./untrusted-fence";

const MAX_ITERATIONS = 10;

declare const registryValidated: unique symbol;

/**
 * A tool name that has been resolved against the registry: an identifier the
 * registry holds, or `UNRECOGNIZED_TOOL_NAME`. `recordToolName` is the only way
 * to obtain one, so a `ToolCallRecord` construction site cannot echo a raw
 * `tool_use` name — it fails tsc instead of shipping model prose to a client.
 *
 * The brand is compile-time only. The value is an ordinary string, and the wire
 * field stays `z.string()` (`@habenula-ai/contracts`): the guarantee is this
 * engine's to keep, and a client parsing JSON cannot re-derive it.
 */
export type RecordedToolName = string & { readonly [registryValidated]: true };

/**
 * The name a `ToolCallRecord` carries for a call the model named `rawName`.
 *
 * Every legitimate name is registry-derived — `buildToolDefinitions` builds the
 * whole offered surface from `listTools()` + `toolName()` — so a name that
 * misses the registry was never a tool this engine offered, and echoing it
 * would put model prose on the record's `name`. Substituting
 * `UNRECOGNIZED_TOOL_NAME` makes the field's contract structural rather than
 * per-client: `name` is a registry identifier or that one token, nothing else.
 * (One direction only: the registry is a superset of what any single run
 * offers, so a hit does not prove the tool was offered on THIS run. It proves
 * the name is Habenula-authored, which is what makes it safe to display.)
 *
 * The raw name is NOT discarded — dispatch, governance, and the audit row's
 * `tool_name` all still see exactly what the model asked for, so the forensic
 * record is unchanged. This substitution is on the display surface only.
 */
export function recordToolName(rawName: string): RecordedToolName {
  const entry = lookupTool(rawName);
  // The registry's own identifier on a hit, not `rawName`: identical today
  // (`lookupTool` matches on `toolName` exactly), and returning the canonical
  // value keeps the closed set true whatever matching `lookupTool` grows.
  return (
    entry === null ? UNRECOGNIZED_TOOL_NAME : toolName(entry)
  ) as RecordedToolName;
}

/**
 * Outcome of a single tool call within a conversation loop iteration.
 *
 * - success: tool executed and returned data.
 * - denied: governance policy denied the call. Terminal for this attempt, but
 *   not for the action: the user can grant it at a confirmation or adjust their
 *   policy, so a client is right to point them at one.
 * - boundary_refused: the two-surface boundary refused a control-plane tool
 *   named by a run that may not reach it. Also a deny under the hood, and
 *   distinct for the same reason not_connected is: the remediation differs, and
 *   here there is none. No grant, policy edit or retry makes the call allowed,
 *   so a client must not offer one — "grant it at a confirmation" is the exact
 *   question this boundary refuses rather than asks. The model reads back
 *   CONTROL_PLANE_REFUSAL for the same reason.
 * - not_connected: the underlying service has no credential / is not
 *   connected (the user can fix this by connecting the service). Reported
 *   as a deny by the governance pipeline but distinct from a policy deny —
 *   surfaced separately so clients can guide the user to the correct
 *   remediation, and so Claude narrates the right reason.
 * - needs_authorization: the service is connected but the stored
 *   credential's granted scopes don't cover this tool's capability
 *   the user can fix this by re-connecting the
 *   service to grant the wider scope. Like not_connected, a deny under the
 *   hood but distinct so the model says "re-authorize" rather than
 *   reporting a generic error it can't distinguish from an API failure.
 * - error: tool dispatch threw or the external API errored after the call
 *   was permitted.
 * - held: governance returned `pending` — the call has no grant and the
 *   engine parked it to ask the user. The turn stops; the LLM
 *   never sees a held call. Resolved out-of-band via resolveConfirmation().
 */
export type ToolCallOutcome =
  | "success"
  | "denied"
  | "boundary_refused"
  | "not_connected"
  | "needs_authorization"
  | "error"
  | "held";

export interface ExecuteToolFn {
  (toolName: string, toolParams: Record<string, unknown>): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    denied?: boolean;
    /** True when the deny reason is "service not connected", not "policy". */
    notConnected?: boolean;
    /**
     * True when the deny reason is "connected but the credential's granted
     * scopes don't cover this tool" — remediation is
     * re-connecting the service, not changing policy.
     */
    needsAuthorization?: boolean;
    /**
     * True when the deny is the two-surface boundary refusing a control-plane
     * tool named by a run that may not reach it. Not a remediation — there is
     * none — so it carries no `denyReason`; it exists so the model is told the
     * boundary refused the call rather than that a policy denied it.
     */
    boundaryRefused?: boolean;
    /**
     * True when governance returned `pending` and the call was held.
     * Carries the held-call id the engine persisted so the loop can
     * record the in-flight turn state against it.
     */
    held?: boolean;
    heldCallId?: string;
    pendingAuditEntryId?: string;
  }>;
}

/**
 * Which trust surface drove a run — the tool-surface axis that decides whether
 * the `habenula` control-plane tools are offered. DISTINCT from `AuditOrigin`
 * (`"human" | "mcp_commission"`, audit
 * attribution). Only `internal` gets the control plane
 * (`allowControlPlane: true`); every other origin fails closed:
 *
 * - `internal` — the trusted internal MCP drive surface (`/internal/mcp`),
 *   authorized by a verified caller token (`INTERNAL_MCP_TOKEN`). This is the
 *   ONLY surface that reaches the control plane.
 * - `human` — the local interactive `/api/chat` path, gated by network locality
 *   only. Trusted enough to task external services, NOT to operate Habenula's
 *   own control plane — so a token-free local route cannot offer `kill` /
 *   `disconnect` to the agent. This is the fail-closed default.
 * - `commission` — the external inbound commission surface (`/mcp`); never gets
 *   the control plane.
 *
 * `human` is the default so a caller that omits `origin` fails closed rather
 * than silently gaining the control plane.
 */
export type RunOrigin = "internal" | "human" | "commission";

/**
 * The complete in-flight turn state, persisted when a call is held so the
 * turn can be reconstructed and resumed after the user confirms — even across
 * a DO eviction. Everything resume needs to pick
 * the turn back up lives here; the in-memory loop stack does not survive a
 * hold, so this record is authoritative on resume.
 */
export interface HeldTurnState {
  /** Conversation messages up to and including the assistant turn that held. */
  messages: LLMMessage[];
  /** The held tool_use block (id, name, parked parameters). */
  heldCall: LLMToolUseBlock;
  /** Remaining unanswered tool_use blocks parked behind the held one. */
  parkedCalls: LLMToolUseBlock[];
  /** tool_results already produced this turn, keyed by tool_use_id. */
  producedResults: LLMToolResultBlock[];
  /** Loop iterations already consumed — the budget carries across resume. */
  iterationsUsed: number;
  /**
   * Tool-call records accumulated so far this turn. Typed unbranded because a
   * parsed row is only as trustworthy as the engine that wrote it; resume
   * re-resolves every name it carries.
   */
  toolCalls: PersistedToolCallRecord[];
  /** Token usage accumulated so far this turn. */
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Set once the held call has been resolved (granted+dispatched, or denied)
   * but before the resume LLM round-trip has succeeded. Makes resume
   * recoverable and idempotent: if the resume throws, the
   * held row survives carrying this answer, and a retry resumes from it without
   * re-dispatching the tool. Cleared (with the row) on successful resume.
   */
  answered?: {
    resolvedResult: LLMToolResultBlock;
    resolvedOutcome: ToolCallOutcome;
    /**
     * Unfenced error text for the resolved call's client record, set only when
     * `resolvedOutcome` is `error`. `resolvedResult.content` carries the
     * same text but fenced for the LLM, so it cannot be reused here. Optional
     * and additive: a row persisted before this field existed parses with it
     * undefined, which is why it needs no canonical-shape version bump.
     */
    resolvedError?: string;
  };
  /**
   * Committed to the held row immediately BEFORE the tool dispatches on a grant
   * resolve. If a crash/eviction lands between a
   * successful dispatch and persisting `answered`, a retry sees this flag and
   * does NOT re-dispatch — the tool already ran, and re-running a side-effecting
   * call (send/delete) would double-execute. Makes resume idempotent on
   * execution, not just authorization.
   */
  dispatched?: boolean;
  /**
   * Set when the hold was parked by a direct POST /api/tools/execute call
   * rather than the conversation loop. There is no conversation
   * to resume: resolveConfirmation dispatches (or denies) the held tool and
   * returns a terminal result, skipping the LLM re-entry. Absent on chat-path
   * holds, whose turn_state carries the real in-flight conversation.
   */
  directExecute?: boolean;
  /**
   * The trust surface the held run came in on, so resume re-derives both halves
   * of the control-plane boundary — the offered tool surface and the dispatch
   * gate — rather than guessing.
   * Optional and additive — this did NOT bump `CANONICAL_SHAPE_VERSION` (the
   * canonical LLM block set is unchanged). A legacy row written before this
   * field existed has no `origin`; the fallback is fail-closed on the run link
   * (run-linked → `commission`, otherwise → `human`), never `internal`.
   */
  origin?: RunOrigin;
}

export interface ConversationLoopParams {
  userMessage: string;
  client: LLMClient;
  tools: LLMToolDefinition[];
  executeTool: ExecuteToolFn;
  messages: LLMMessage[];
  /** From the deployment's LLMConfig — no in-loop default. */
  model: string;
  /** From the deployment's LLMConfig — no in-loop default. */
  maxTokens: number;
  system?: string;
  /**
   * Persist the in-flight turn state when a call is held. Called inside the
   * loop the moment a hold occurs, before returning the held result, so the
   * turn survives a DO eviction. Receives the held-call id the engine minted.
   */
  persistHeldTurn?: (heldCallId: string, state: HeldTurnState) => void;
  /**
   * Resume state, set when re-entering the loop after a confirmation. When
   * present, the loop reconstructs the turn from this record (authoritative)
   * rather than starting a fresh user turn.
   */
  resumeState?: ResumeState;
}

/**
 * Drives a single resume re-entry: the held call's answer plus the parked
 * calls to re-evaluate against current policy (a fresh grant may now cover
 * some). The loop answers the held call, re-evaluates parked calls (holding
 * the next that needs a decision), and once every tool_use is answered,
 * assembles the complete tool_result user message and re-invokes the LLM.
 */
export interface ResumeState {
  state: HeldTurnState;
  /** The tool_result for the just-resolved held call. */
  resolvedResult: LLMToolResultBlock;
  /** Outcome to record for the resolved held call. */
  resolvedOutcome: ToolCallOutcome;
  /** Unfenced error text for that record, set only when the outcome is `error`. */
  resolvedError?: string;
}

export interface ToolCallRecord {
  /**
   * The tool's registry identifier, or `UNRECOGNIZED_TOOL_NAME` when the model
   * named a tool the registry does not hold. Never the raw `tool_use` name: the
   * branded type admits only `recordToolName`'s return value, so a client can
   * treat this field as a closed set rather than as agent text. Mirrored as a
   * plain `z.string()` on the wire — see `RecordedToolName`.
   */
  name: RecordedToolName;
  id: string;
  outcome: ToolCallOutcome;
  /**
   * Why the call failed, set only on `outcome: "error"` — the tool's own error
   * text, verbatim and unfenced. The LLM sees this same string fenced by
   * `classifyToolResult`; the client sees it raw and owns rendering it as
   * bounded untrusted data. Mirrored in `ToolCallRecord` in
   * `@habenula-ai/contracts`; edit both together.
   */
  error?: string;
}

/**
 * A `ToolCallRecord` as it comes back off a persisted turn state: the same
 * shape, with `name` unbranded. `parseTurnState` casts a JSON blob that
 * whatever engine version parked the hold wrote, so nothing in it has been
 * through `recordToolName` on this side of a deploy. Resume re-resolves those
 * names on the way out, and this type is what forces it to.
 */
export type PersistedToolCallRecord = Omit<ToolCallRecord, "name"> & {
  name: string;
};

export interface ConversationLoopResult {
  response: string;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  iterations: number;
  /**
   * Set when the turn parked a call to ask the user. The LLM
   * produced no final text — the turn is suspended until resolveConfirmation()
   * answers `heldCallId`. `response` is empty in this case.
   */
  held?: { heldCallId: string };
}

export async function runConversationLoop(
  params: ConversationLoopParams
): Promise<ConversationLoopResult> {
  const {
    userMessage,
    client,
    tools,
    executeTool,
    messages,
    model,
    maxTokens,
    system,
    persistHeldTurn,
    resumeState,
  } = params;

  // Carried-over records are re-resolved, not copied: `parseTurnState` casts
  // the persisted blob, so a hold parked by an OLDER engine can carry a raw
  // `tool_use` name in a record from earlier in the same turn (a first call that
  // force-denied, then a second that held). The wire's closed set has to survive
  // that upgrade too, and the resolved record below is not the only one this
  // resume returns.
  const toolCalls: ToolCallRecord[] = resumeState
    ? resumeState.state.toolCalls.map((call) => ({
        ...call,
        name: recordToolName(call.name),
      }))
    : [];
  let totalInput = resumeState ? resumeState.state.usage.inputTokens : 0;
  let totalOutput = resumeState ? resumeState.state.usage.outputTokens : 0;
  // The iteration budget carries across resume — a chain of holds consumes
  // the per-turn budget rather than resetting it (finding #4).
  const startIteration = resumeState ? resumeState.state.iterationsUsed : 0;

  // Resume re-entry: reconstruct the turn from the authoritative held record,
  // answer the resolved held call, then re-evaluate any parked calls. If a
  // parked call holds again, persist and return held; otherwise assemble the
  // full tool_result message and fall through into the LLM loop.
  // Capture rollback point BEFORE adding this turn's messages, so an LLM API
  // failure restores the array to its pre-turn state (no dangling user msg).
  const rollbackLength = messages.length;

  if (resumeState) {
    const resumed = await answerAndDrainParkedCalls({
      messages,
      base: resumeState.state,
      firstAnswer: resumeState.resolvedResult,
      firstOutcome: resumeState.resolvedOutcome,
      firstError: resumeState.resolvedError,
      heldCallName: resumeState.state.heldCall.name,
      heldCallId: resumeState.state.heldCall.id,
      executeTool,
      toolCalls,
      iterationsUsed: startIteration,
      usage: { inputTokens: totalInput, outputTokens: totalOutput },
      persistHeldTurn,
    });
    if (resumed.held) {
      return resumed.held;
    }
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  for (let i = startIteration; i < MAX_ITERATIONS; i++) {
    const createParams: LLMCreateParams = {
      model,
      max_tokens: maxTokens,
      messages,
      // Omit `tools` entirely when the surface is empty (fresh user with
      // nothing connected) so the request is unambiguously "no tools". An
      // empty `tools: []` is needless, and whether the API treats it as
      // "no tools" or "tools present, zero of them" is unspecified.
      ...(tools.length > 0 ? { tools } : {}),
      ...(system ? { system } : {}),
    };

    let response;
    try {
      response = await client.createMessage(createParams);
    } catch (err) {
      // Rollback messages to pre-call state so next chat() isn't corrupted
      messages.length = rollbackLength;
      throw err;
    }
    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    // An assistant turn with zero content blocks (an empty, truncated, or
    // content-filtered upstream reply — realistic on OpenAI-compatible local
    // runtimes) is unrepresentable on both provider wires: persisting it makes
    // every LATER request 400, wedging the conversation until DO eviction,
    // and the rollback above only covers a thrown createMessage. Substitute a
    // minimal text block so the buffer stays wire-valid.
    const assistantContent =
      response.content.length > 0
        ? response.content
        : [{ type: "text" as const, text: "[the model returned an empty response]" }];
    messages.push({ role: "assistant", content: assistantContent });

    const toolUseBlocks = response.content.filter(
      (b): b is LLMToolUseBlock => b.type === "tool_use"
    );

    // Terminal on stop_reason — but ALSO when a claimed tool_use turn carries
    // zero tool_use blocks (a buggy runtime): entering the tool branch with
    // nothing to answer would push an empty tool_result user message, which
    // the provider wires reject or drop (defense in depth behind the
    // adapters' own block-derived stop_reason).
    if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      const text = response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        response: text,
        toolCalls,
        usage: { inputTokens: totalInput, outputTokens: totalOutput },
        iterations: i + 1,
      };
    }

    const toolResults: LLMToolResultBlock[] = [];
    for (let j = 0; j < toolUseBlocks.length; j++) {
      const block = toolUseBlocks[j]!;
      const result = await executeTool(block.name, block.input);

      // Hold path: the call has no grant and was parked. The
      // Anthropic API requires every tool_use in the assistant message to be
      // answered before the next call, so we cannot send a partial answer —
      // park this call AND every remaining tool_use block, persist the whole
      // in-flight turn state, and return held. The LLM is never told.
      if (result.held) {
        const heldCallId = result.heldCallId ?? block.id;
        toolCalls.push({
          name: recordToolName(block.name),
          id: block.id,
          outcome: "held",
        });
        persistHeldTurn?.(heldCallId, {
          messages: [...messages],
          heldCall: block,
          parkedCalls: toolUseBlocks.slice(j + 1),
          producedResults: toolResults,
          iterationsUsed: i + 1,
          toolCalls,
          usage: { inputTokens: totalInput, outputTokens: totalOutput },
        });
        return {
          response: "",
          toolCalls,
          usage: { inputTokens: totalInput, outputTokens: totalOutput },
          iterations: i + 1,
          held: { heldCallId },
        };
      }

      const { content, isError, outcome, error } = classifyToolResult(result);
      toolCalls.push({
        name: recordToolName(block.name),
        id: block.id,
        outcome,
        error,
      });
      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content,
        is_error: isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Max iterations reached — return whatever text we have
  return {
    response: "[max iterations reached]",
    toolCalls,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
    iterations: MAX_ITERATIONS,
  };
}

/**
 * Map an executeTool result to its tool_result content + outcome label.
 *
 * Success data and error text come from the downstream provider, so both are
 * wrapped in the untrusted-output fence before entering the LLM context
 * (the engine-authored strings that also flow
 * through the error branch are harmlessly fenced as data). The fixed
 * `denied` / `not_connected` / `needs_authorization` / boundary-refusal strings
 * are engine prose and stay unfenced.
 *
 * The boundary refusal is checked before the generic deny. Both label the
 * outcome `denied` — the wire's outcome set is closed and a refused action is
 * denied — but "Denied by governance policy" would be a false reason here:
 * there is no policy to change, and telling the model there is invites it to
 * ask the user for a grant that must never be given.
 */
function classifyToolResult(result: {
  success: boolean;
  data?: unknown;
  error?: string;
  denied?: boolean;
  notConnected?: boolean;
  needsAuthorization?: boolean;
  boundaryRefused?: boolean;
}): {
  content: string;
  isError: boolean;
  outcome: ToolCallOutcome;
  /**
   * The unfenced error text for the client record. Set only on the
   * `error` branch: every refusal branch carries engine prose the client
   * already renders from `outcome` alone, and duplicating it would put engine
   * chrome through the untrusted render path for no gain.
   */
  error?: string;
} {
  if (result.notConnected) {
    return {
      content:
        "The required service is not connected — no credential is available. Tell the user the service needs to be connected before this tool can run.",
      isError: true,
      outcome: "not_connected",
    };
  }
  if (result.needsAuthorization) {
    return {
      content:
        "The service is connected, but its stored authorization does not cover this action. Tell the user to re-connect the service (e.g. `habenula connect gmail`) to grant the additional access before this tool can run.",
      isError: true,
      outcome: "needs_authorization",
    };
  }
  // Before the `denied` branch: a boundary refusal sets `denied` too, and the
  // two must not collapse. The model reads a different reason and the client
  // owes the user a different next step (none).
  if (result.boundaryRefused) {
    return {
      content: CONTROL_PLANE_REFUSAL,
      isError: true,
      outcome: "boundary_refused",
    };
  }
  if (result.denied) {
    return { content: "Denied by governance policy", isError: true, outcome: "denied" };
  }
  if (!result.success) {
    const error = result.error ?? "Tool execution failed";
    return {
      content: fenceUntrusted(error),
      isError: true,
      outcome: "error",
      error,
    };
  }
  return {
    content: fenceUntrusted(JSON.stringify(result.data ?? null)),
    isError: false,
    outcome: "success",
  };
}

/**
 * On resume: answer the just-resolved held call, then re-evaluate the parked
 * calls against current policy. A grant created while resolving may now cover
 * some parked calls (they execute); another may still match nothing and hold
 * again — the one-held-call-per-DO invariant survives the cascade. Once every
 * tool_use in the turn is answered, assemble the
 * complete tool_result user message (correct id mapping) and push it so the
 * caller's loop can re-invoke the LLM.
 *
 * Returns `{ held }` if a parked call held again; otherwise resolves and the
 * caller continues into the LLM loop.
 */
async function answerAndDrainParkedCalls(args: {
  messages: LLMMessage[];
  base: HeldTurnState;
  firstAnswer: LLMToolResultBlock;
  firstOutcome: ToolCallOutcome;
  firstError?: string;
  heldCallName: string;
  heldCallId: string;
  executeTool: ExecuteToolFn;
  toolCalls: ToolCallRecord[];
  iterationsUsed: number;
  usage: { inputTokens: number; outputTokens: number };
  persistHeldTurn?: (heldCallId: string, state: HeldTurnState) => void;
}): Promise<{ held?: ConversationLoopResult }> {
  const {
    messages,
    base,
    firstAnswer,
    firstOutcome,
    firstError,
    heldCallName,
    heldCallId,
    executeTool,
    toolCalls,
    iterationsUsed,
    usage,
    persistHeldTurn,
  } = args;

  // Reconstruct the conversation from the authoritative held record — warm or
  // cold, the persisted state is the single source of truth.
  messages.length = 0;
  messages.push(...base.messages);

  const answered: LLMToolResultBlock[] = [...base.producedResults, firstAnswer];
  // The carried-over array already records this call as `held` (pushed when it
  // parked, then persisted with the turn state). Replace that record with the
  // final outcome rather than appending a second one — the wire contract is one
  // record per tool_use, and a leftover `held` beside the real outcome reads
  // downstream as a still-pending confirmation (and doubles the CLI tool line).
  // Replace the array slot, not the record object: the array is a shallow copy
  // of the parsed turn state, so mutating the record would reach into it.
  const staleHeld = toolCalls.findIndex(
    (c) => c.id === heldCallId && c.outcome === "held",
  );
  const resolvedRecord: ToolCallRecord = {
    name: recordToolName(heldCallName),
    id: heldCallId,
    outcome: firstOutcome,
    error: firstError,
  };
  if (staleHeld === -1) toolCalls.push(resolvedRecord);
  else toolCalls[staleHeld] = resolvedRecord;

  const remaining = [...base.parkedCalls];
  while (remaining.length > 0) {
    const block = remaining.shift()!;
    const result = await executeTool(block.name, block.input);

    if (result.held) {
      const nextHeldId = result.heldCallId ?? block.id;
      toolCalls.push({
        name: recordToolName(block.name),
        id: block.id,
        outcome: "held",
      });
      persistHeldTurn?.(nextHeldId, {
        messages: [...messages],
        heldCall: block,
        parkedCalls: remaining,
        producedResults: answered,
        iterationsUsed,
        toolCalls,
        usage,
      });
      return {
        held: {
          response: "",
          toolCalls,
          usage,
          iterations: iterationsUsed,
          held: { heldCallId: nextHeldId },
        },
      };
    }

    const { content, isError, outcome, error } = classifyToolResult(result);
    toolCalls.push({
      name: recordToolName(block.name),
      id: block.id,
      outcome,
      error,
    });
    answered.push({
      type: "tool_result" as const,
      tool_use_id: block.id,
      content,
      is_error: isError,
    });
  }

  // Every tool_use answered — push the complete tool_result user message.
  messages.push({ role: "user", content: answered });
  return {};
}
