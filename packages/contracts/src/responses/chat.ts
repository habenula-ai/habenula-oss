// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { HeldRef } from "./held.js";

/**
 * `POST /api/chat` — hand-authored Zod mirror of the engine's
 * `ConversationLoopResult` (`packages/engine/src/llm/conversation.ts`). The
 * wire equals that internal type wholesale; the two definitions are kept in
 * lockstep by a compile-time equality assertion in the engine's contract test
 * (mirror, not unify). Edit both together.
 */

/**
 * Per-tool-call outcome; `held` means the call is parked awaiting the user.
 *
 * `denied` and `boundary_refused` are both terminal refusals, and the split is
 * the client's next step. A `denied` call can become allowed: the user answers a
 * confirmation, or edits their policy. A `boundary_refused` call never can — the
 * two-surface trust boundary refused a Habenula control operation named by a
 * surface that may not reach one, and no grant, policy edit or retry changes
 * that. A client that collapses the two ends up telling the user to grant
 * permission the engine must never accept, which is the confirmation this
 * boundary exists to never ask for.
 */
export const ToolCallOutcome = z.enum([
  "success",
  "denied",
  "boundary_refused",
  "not_connected",
  "needs_authorization",
  "error",
  "held",
]);
export type ToolCallOutcome = z.infer<typeof ToolCallOutcome>;

/**
 * The `name` a `ToolCallRecord` carries when the model named a tool the
 * registry does not hold. One engine-owned token, so `name` stays a closed set
 * — a registry identifier or this — on the line a client renders next to its
 * own chrome. Defined here, with the field it describes, so the engine and
 * every client share one definition of the token rather than each spelling it.
 *
 * The angle brackets are deliberate. A registry identifier is
 * `${service}_${verb}`, so bracketed text can never collide with a real name.
 * A client that renders into markup escapes this value like every other field
 * on the record.
 */
export const UNRECOGNIZED_TOOL_NAME = "<unrecognized>";

export const ToolCallRecord = z.strictObject({
  /**
   * The tool's registry identifier, or `UNRECOGNIZED_TOOL_NAME` when the model
   * named a tool the registry does not hold. The engine resolves every record's
   * name against the registry as it builds the record, so this is a closed set
   * and never the raw `tool_use` name the model authored. The audit log keeps
   * the raw name (`tool_name`) for forensics.
   *
   * A plain string on purpose: the registry lives in the engine, so this schema
   * cannot check membership, and a client that parses a response is taking the
   * engine's word for the field. The engine's own record type brands it, so on
   * that side only the validator can produce a value for it.
   */
  name: z.string(),
  id: z.string(),
  outcome: ToolCallOutcome,
  /**
   * Why the call failed, present only on `outcome: "error"` — the tool's own
   * error text, verbatim and unfenced. The LLM channel fences this same string
   * as untrusted; this is the client channel, so the client is responsible for
   * rendering it as bounded data and never as trusted chrome. It can embed
   * content (a recipient, a path), the same exposure the audit log's
   * `error_message` already carries.
   */
  error: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/**
 * A chat turn. When the turn parked a tool call awaiting confirmation,
 * `held` carries the id to resolve and `response` is empty.
 */
export const ChatResponse = z.strictObject({
  response: z.string(),
  toolCalls: z.array(ToolCallRecord),
  usage: z.strictObject({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  iterations: z.number(),
  held: HeldRef.optional(),
});
export type ChatResponse = z.infer<typeof ChatResponse>;
