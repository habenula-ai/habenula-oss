// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The confirmation prompt renderer.
 * One renderer both the reactive path (a `held` chat turn) and the
 * poll call. It draws the held action, four numbered choices annotated with
 * their real scope and lifetime, reads the user's pick, loops on "Tell me more"
 * without resolving, and resolves the rest.
 *
 * An ordinary hold offers four choices; a spending hold offers three (Deny,
 * Tell me more, Approve). Choices are tinted by outcome (Deny coral, grants
 * deep seafoam, Tell-more brand text) as a scanning affordance. The number and text carry the
 * meaning, so the color is additive — the choices stay legible under `NO_COLOR`.
 */

import type { ApiClient, ResolveChoice } from "../api-client";
import type {
  ActiveSessionView,
  HeldCallRecord,
  ResolveResponse,
} from "@habenula-ai/contracts";
import { ApiError } from "../api-client";
import type { PresenceGate } from "../gate/confirm-presence";
import { sessionTimes, postTurnHints } from "../commands/repl-meta";
import {
  attribute,
  clampSanitized,
  displayWidth,
  layoutField,
  renderUntrusted,
  terminalWidth,
  toolCallLine,
  type Speaker,
} from "./attribution";
import { colorize, tintKeyword, inputSgr, type ColorDepth, type ColorRole } from "./color";
import { dollars } from "./money";
import type { SelectionChoice } from "../input/menu";
import { withSpinner } from "./spinner";

const MAX_NOUN = 64;
const MAX_PARAM = 160;
const MAX_KEY = 40;
const MAX_DESC = 400;
const MAX_GOAL = 200;
const FLAG_TEXT = "⚠ unusual value";

export interface PromptContext {
  client: ApiClient;
  record: HeldCallRecord;
  session: ActiveSessionView | null;
  /**
   * Read one line as the user's choice, displaying `prompt`. The REPL routes it
   * through its line controller (so reactive and polled confirmations read the
   * same way); tests inject a scripted reader. Replaces the old `rl.question`.
   */
  readChoice: (prompt: string) => Promise<string>;
  /**
   * Arrow-key confirmation chooser: when present (a TTY editor), the four
   * choices are navigated with ↑/↓ + Enter (digits jump), and this resolves with
   * the chosen choice's token. Absent (plain reader / scripted test IO) →
   * `renderPrompt` falls back to the static numbered list + `readChoice`.
   */
  readSelection?: (
    prompt: string,
    choices: readonly SelectionChoice[],
    defaultIndex: number,
  ) => Promise<string>;
  depth: ColorDepth;
  now: Date;
  /** Output sink; defaults to `console.log`. Injectable for tests. */
  write?: (line: string) => void;
  /**
   * Human Touch presence gate: consulted before an
   * affirmative resolve (`task`/`session`) is sent; `deny`/`tell_more` never
   * consult it. Defaults to always-true when omitted.
   */
  confirmPresence?: PresenceGate;
}

/** The spend block a spend hold's record carries. */
type SpendBlock = NonNullable<HeldCallRecord["spend"]>;



/**
 * Map a typed line to a choice, or null to re-prompt. Hold-shape-aware:
 * a spend hold offers three answers — Deny, Tell me more,
 * and Approve this order — so "2" keeps its everywhere-else meaning and the
 * affirmative is "3"; the grant-choice
 * numbers/phrases parse to nothing (the engine would reject them anyway; the
 * restriction here is UX, engine-side is the enforcement).
 */
export function parseChoice(
  input: string,
  spend?: SpendBlock,
): ResolveChoice | null {
  const s = input.trim().toLowerCase();
  if (s === "1" || s === "deny" || s === "d") return "deny";
  if (spend) {
    // 2 keeps its meaning from every other prompt — "tell me more, no
    // decision" — so the trained keystroke never becomes the one that spends.
    if (s === "2" || s === "tell me more" || s === "tell" || s === "more" || s === "?")
      return "tell_more";
    if (s === "3" || s === "approve this order" || s === "approve" || s === "a")
      return "approve_once";
    return null;
  }
  if (s === "2" || s === "tell me more" || s === "tell" || s === "more" || s === "?")
    return "tell_more";
  if (s === "3" || s === "for this task" || s === "task" || s === "t") return "task";
  if (s === "4" || s === "for this session" || s === "session" || s === "s")
    return "session";
  return null;
}

/**
 * The confirmation choices as structured data — four on an ordinary hold,
 * three on a spending hold — the single source of truth
 * shared by the static numbered list (`choiceLines`, the typed-input fallback)
 * and the arrow-key chooser (`renderSelection`, via `readSelection`). Each
 * carries its outcome `role` (Deny coral, Tell me more brand text, the two grants
 * deep seafoam), the numbered `label`, and the `token` the chooser submits (`"1".."4"`,
 * which `parseChoice` maps). The session line carries the remaining lifetime read
 * from the session's server-computed expiry ("~N min left"), omitted when
 * unknown. Order is load-bearing: Deny is index 0, the safe default highlight.
 */
export function confirmChoices(
  session: ActiveSessionView | null,
  now: Date,
  spend?: SpendBlock,
): SelectionChoice[] {
  // A spend hold's restricted answer set: Deny, Tell me more, and
  // Approve-this-order. No grant is minted, no ceiling is raised, and every
  // subsequent over-cap action asks again. Deny stays index 0. This widens
  // the money hold's two answers by one on purpose: `tell_more` mints
  // nothing and leaves the call parked, and refusing it made the money prompt
  // the only one where the user cannot ask what a tool does.
  if (spend) {
    const amount = spend.amountCents !== null ? ` ${dollars(spend.amountCents)}` : "";
    // Deny stays index 0 (an accidental Enter denies) and 2 keeps its
    // everywhere-else meaning, so the affirmative sits at 3 where an
    // affirmative has always sat.
    return [
      {
        token: "1",
        role: "denied",
        keyword: "Deny",
        label: "1. Deny — don't place this order; nothing is spent.",
      },
      {
        token: "2",
        role: "habenula",
        keyword: "Tell me more",
        label: "2. Tell me more — show what this tool does (no decision yet).",
      },
      {
        token: "3",
        role: "granted" as ColorRole,
        keyword: "Approve",
        label:
          spend.reason === "unpriced"
            ? "3. Approve anyway — the amount could not be read; this could charge any amount."
            : `3. Approve — place this one order${amount ? ` for${amount}` : ""}. I'll ask again next time an order goes over a limit.`,
      },
    ];
  }
  const times = session ? sessionTimes(session, now) : null;
  const sessionLeft = times ? ` (~${times.left} left)` : "";
  return [
    { token: "1", role: "denied", keyword: "Deny", label: "1. Deny — don't run this; nothing is granted." },
    {
      token: "2",
      role: "habenula",
      keyword: "Tell me more",
      label: "2. Tell me more — show what this tool does (no decision yet).",
    },
    { token: "3", role: "granted", keyword: "Allow", label: "3. Allow — for this task." },
    {
      token: "4",
      role: "granted" as ColorRole,
      keyword: "Allow",
      label: `4. Allow — for this session${sessionLeft}.`,
    },
  ];
}

/**
 * The choice lines for the static numbered list (the typed-input fallback):
 * each choice's outcome word tinted by role, two-space indented. Additive
 * color — the number and text carry the meaning, so at `depth: "none"` (NO_COLOR
 * / non-TTY) the lines render as legible plain text.
 */
export function choiceLines(
  session: ActiveSessionView | null,
  now: Date,
  depth: ColorDepth,
  spend?: SpendBlock,
): string[] {
  return confirmChoices(session, now, spend).map((c) =>
    tintKeyword(`  ${c.label}`, c.keyword, c.role, depth),
  );
}

/**
 * An action line: `service · verb` trusted chrome (brand text) + the byte-sanitized
 * noun as data (NOT chrome — unvalidated on the read path), flagged when
 * sanitization/truncation altered its bytes. Routed through `layoutField` so a
 * long or wide noun hard-wraps instead of soft-wrapping into a forged flush-left
 * row; continuation rows are indented.
 */
function writeActionLine(
  service: string,
  verb: string,
  rawNoun: string,
  depth: ColorDepth,
  width: number,
  write: (l: string) => void,
): void {
  const indent = "    ";
  const chromePlain = `${service} · ${verb}`;
  const prefixPlain = `${indent}${chromePlain} · `;
  const prefixColored = `${indent}${colorize(chromePlain, "habenula", depth)} · `;
  // The noun is untrusted agent text on the read path — quoted so a
  // contained `·` cannot forge extra chrome, flagged if it carries one.
  const noun = renderUntrusted(rawNoun, MAX_NOUN);
  for (const row of layoutField({
    prefixColored,
    prefixWidth: displayWidth(prefixPlain),
    value: noun.text,
    width,
    continuationIndent: 6,
    // A truncated noun implies a narrower grant than the raw key, so flag it too
    // — unlike the goal, where a length cap is benign.
    ...(noun.altered || noun.truncated
      ? { suffixColored: colorize(FLAG_TEXT, "pending", depth), suffixWidth: displayWidth(FLAG_TEXT) }
      : {}),
  })) {
    write(row);
  }
}

/**
 * The `↑ incoming` badge + commission goal, drawn only for a run-linked
 * (commissioned) hold — a call an external agent raised, not one the user's own
 * turn produced. The badge word is the purple `incoming` role
 * (a state indicator, not speech, so it carries no `Habenula ›` label); the
 * lead-in is trusted brand-text chrome. The `goal` is external-agent-authored, so
 * it renders through `renderUntrusted` like the noun — quoted, escaped,
 * width-wrapped, and flagged `⚠ unusual value` if its bytes were altered — and
 * never as trusted chrome.
 */
function drawCommissionHeader(
  goal: string | undefined,
  depth: ColorDepth,
  width: number,
  write: (l: string) => void,
): void {
  const badge = colorize("↑ incoming", "incoming", depth);
  const lead = colorize("· commissioned by an external agent", "habenula", depth);
  write(`${badge} ${lead}`);
  if (goal === undefined) return;
  const value = renderUntrusted(goal, MAX_GOAL);
  const prefixPlain = "    goal: ";
  for (const row of layoutField({
    prefixColored: prefixPlain,
    prefixWidth: displayWidth(prefixPlain),
    value: value.text,
    width,
    continuationIndent: 6,
    ...(value.altered
      ? { suffixColored: colorize(FLAG_TEXT, "pending", depth), suffixWidth: displayWidth(FLAG_TEXT) }
      : {}),
  })) {
    write(row);
  }
}

/**
 * Draw the held action + params (the confirmation body, everything above the
 * choices). The choices themselves are drawn by the caller — statically
 * (`choiceLines`) in the typed-input fallback, or by the editor's arrow-key
 * chooser when `readSelection` is present. Pure output, no read.
 */
function drawPromptBody(ctx: PromptContext): void {
  const write = ctx.write ?? ((l: string) => console.log(l));
  const { record, depth } = ctx;
  const width = terminalWidth();

  // A commissioned hold leads with the incoming badge + goal before the action,
  // set off by a blank line from the confirmation body that follows.
  if (record.origin === "mcp_commission") {
    drawCommissionHeader(record.goal, depth, width, write);
    write("");
  }

  // The lead line names the stakes in words, so "this spends money" survives
  // NO_COLOR and a fast scan rather than resting on the pending tint alone.
  const lead = record.spend
    ? "A tool call that SPENDS MONEY is awaiting your confirmation:"
    : "A tool call is awaiting your confirmation:";
  for (const row of attribute("habenula", lead, { depth })) {
    write(row);
  }

  writeActionLine(record.service, record.verb, record.noun, depth, width, write);

  // A spend hold names the money: the amount, each
  // breached window's overage against its running total, and the estimate
  // caveat. Engine-computed integers — trusted chrome, no untrusted render.
  if (record.spend) {
    drawSpendBlock(record.spend, depth, width, write);
  }

  // The user already asked for the email count, so echoing `maxResults` back
  // reads as a leaked internal token — drop it from the readout. Every
  // other param stays visible for transparency, and the header is skipped when
  // that leaves nothing to show.
  // `maxResults` is a leaked internal token the user already implied;
  // on a spending hold the quote id and idempotency key are the same kind of
  // noise, and they are 100% of the params — the user decides on the amount and
  // the merchant, never on an opaque handle. The raw ids stay in the audit log.
  const INTERNAL_PARAMS = record.spend
    ? ["maxResults", "quoteId", "idempotencyKey"]
    : ["maxResults"];
  const paramKeys = Object.keys(record.params).filter(
    (key) => !INTERNAL_PARAMS.includes(key),
  );
  if (paramKeys.length > 0) {
    write("    requested with:");
    for (const key of paramKeys) {
      // Both key and value are untrusted agent input. `renderUntrusted` reveals
      // object/array structure instead of `[object Object]` and quotes
      // strings so a contained `·` can't forge chrome. The row flags
      // `⚠ unusual value` if sanitization/truncation altered EITHER, or either
      // carried the chrome separator — the tamper signal the old loop dropped.
      const k = renderUntrusted(key, MAX_KEY);
      const value = renderUntrusted(record.params[key], MAX_PARAM);
      const prefixPlain = `      ${k.text}: `;
      const altered = k.altered || k.truncated || value.altered || value.truncated;
      for (const row of layoutField({
        prefixColored: prefixPlain,
        prefixWidth: displayWidth(prefixPlain),
        value: value.text,
        width,
        continuationIndent: 8,
        ...(altered
          ? { suffixColored: colorize(FLAG_TEXT, "pending", depth), suffixWidth: displayWidth(FLAG_TEXT) }
          : {}),
      })) {
        write(row);
      }
    }
  }
}

/**
 * The spend hold's money lines. Why the call is held decides the copy:
 * `over_limit` names the amount and each breached window's limit and running
 * total; `unpriced` says the amount could not be read from the call;
 * `totals_unavailable` says the spending record could not be read. Totals are
 * named as estimates (the spec's wording — committed estimates, unreconciled).
 */
function drawSpendBlock(
  spend: SpendBlock,
  depth: ColorDepth,
  width: number,
  write: (l: string) => void,
): void {
  // Every money line hard-wraps with its indent preserved: at 80
  // columns these are the longest lines on the prompt, and a soft wrap to
  // column 0 loses the indent that marks them as part of the held action.
  const line = (text: string, indent = "    "): void => {
    for (const row of layoutField({
      prefixColored: indent,
      prefixWidth: indent.length,
      value: text,
      width,
      continuationIndent: indent.length + 2,
    })) {
      write(row);
    }
  };
  const amount = spend.amountCents !== null ? dollars(spend.amountCents) : null;

  // What is being bought, first — the user decides on the order, not on a
  // price in isolation. Engine-derived from the service's bound quote, so it
  // renders as trusted chrome like the amounts.
  if (spend.summary) {
    line(spend.summary);
  }

  if (spend.reason === "unpriced") {
    line(
      `${colorize("This order spends money", "pending", depth)}, and its amount could not be read from the call, so it cannot be checked against your limits. Deny is the safe answer — ask the agent to price the order again.`,
    );
    return;
  }
  if (spend.reason === "totals_unavailable") {
    line(
      `${colorize(`This order spends ${amount ?? "money"}`, "pending", depth)}, and your spending record could not be read, so it cannot be checked against your limits. Deny is the safe answer — try again in a moment, or run \`habenula cap\` to see your limits and spending.`,
    );
    return;
  }

  line(`${colorize(`This order spends ${amount ?? "money"}`, "pending", depth)}.`);
  for (const breach of spend.breaches) {
    const window = breach.window === "session" ? "this session" : "this month";
    // Lead with the outcome, not the inputs: the total the order would reach
    // and the overage are the numbers that explain why this is being asked.
    if (spend.amountCents !== null) {
      const total = breach.spentCents + spend.amountCents;
      const over = total - breach.limitCents;
      line(`That would take your spending ${window} to ${dollars(total)}.`, "      ");
      line(
        `${dollars(over)} over your ${dollars(breach.limitCents)} limit — ${dollars(breach.spentCents)} spent so far.`,
        "      ",
      );
    } else {
      line(
        `Your ${dollars(breach.limitCents)} limit for ${window} is already at ${dollars(breach.spentCents)}.`,
        "      ",
      );
    }
  }
  line(
    "Amounts are counted when an order is placed, before the merchant's final charge.",
    "      ",
  );
}

/** Render a `tell_more` metadata block (registry-authored; sanitized defensively). */
function drawMetadata(
  metadata: { service: string; verb: string; noun: string; description: string },
  depth: ColorDepth,
  write: (l: string) => void,
): void {
  const width = terminalWidth();
  for (const row of attribute("habenula", "Tell me more:", { depth })) write(row);
  writeActionLine(metadata.service, metadata.verb, metadata.noun, depth, width, write);
  const desc = clampSanitized(metadata.description, MAX_DESC);
  for (const row of layoutField({
    prefixColored: "    ",
    prefixWidth: 4,
    value: desc.text,
    width,
    continuationIndent: 4,
  })) {
    write(row);
  }
}

/** Render an agent turn (response + tool markers) through the attribution guard. */
function drawResumedTurn(
  result: Extract<ResolveResponse, { status: "resumed" }>["result"],
  depth: ColorDepth,
  write: (l: string) => void,
): void {
  for (const call of result.toolCalls) {
    // Shared with the normal-turn renderer (chat.ts) so the resumed path shows
    // the same marker, failure suffix, and failure reason. Validating the name
    // against the tool registry belongs engine-side, where the registry lives.
    for (const row of attribute("habenula", toolCallLine(call), { depth })) write(row);
  }
  if (result.response !== "") {
    // Gap between the tool-call markers and the agent's prose, matching the
    // normal-turn renderer.
    if (result.toolCalls.length > 0) write("");
    for (const row of attribute("agent", result.response, { depth })) write(row);
  }
}

function habenulaLine(text: string, depth: ColorDepth, write: (l: string) => void): void {
  for (const row of attribute("habenula", text, { depth })) write(row);
}

/**
 * The one-line instruction drawn above the arrow-key chooser. Muted, so it
 * reads as a hint rather than an outcome; the choices below carry the meaning. No
 * typed-input tint — there is nothing to type. `sanitize`-safe (Habenula-authored).
 */
function selectionPrompt(depth: ColorDepth, choiceCount: number): string {
  return colorize(`Choose with ↑/↓ then Enter (or press 1–${choiceCount}):`, "muted", depth);
}

/**
 * Render the confirmation prompt and drive it to a resolution. Loops on "Tell
 * me more" (fetches metadata, re-prompts, never resolves) and re-prompts on
 * empty/unrecognized input, so a blank line can never grant. On a grant/deny it
 * resolves; a `resumed` result whose turn parks a NEW held call cascades into a
 * fresh prompt. 404 renders "expired", 409 ("busy") re-prompts and leaves the
 * call parked (dead before the turn gate, wired now). Any other error propagates.
 */
export async function renderPrompt(ctx: PromptContext): Promise<void> {
  const write = ctx.write ?? ((l: string) => console.log(l));
  // Read `client`/`readChoice`/`readSelection`/`depth` fresh each iteration from
  // `ctx`, and never cache `record` — a cascade reassigns `ctx.record` to the next
  // held call, and the resolve below must target it, not the stale first id.
  const { client, readChoice, readSelection, depth } = ctx;

  // Loop covers the "Tell me more" re-prompt without resolving.
  for (;;) {
    drawPromptBody(ctx);
    write(""); // blank line between the action body and the choices

    // A spend hold offers two choices; an ordinary hold four. Everything
    // below is range-aware off this one set.
    const spend = ctx.record.spend;
    const choices = confirmChoices(ctx.session, ctx.now, spend);

    let choice: ResolveChoice | null = null;
    if (readSelection) {
      // Arrow-key chooser: the editor draws the choices and reads the
      // pick. Deny (index 0) is the default highlight, so an accidental Enter
      // denies rather than grants. A chooser only ever submits a valid token or
      // rejects (Ctrl-C / EOF), so there is no invalid-input re-prompt.
      let answer: string;
      try {
        answer = await readSelection(selectionPrompt(depth, choices.length), choices, 0);
      } catch {
        // Cancelled or EOF: the call stays parked, nothing granted (as below).
        return;
      }
      choice = parseChoice(answer, spend);
      if (choice === null) continue; // defensive: an unknown token re-draws
    } else {
      // Fallback (plain reader / scripted IO): the static numbered list + typed
      // digits, re-prompting on empty/unrecognized input so a blank line can't grant.
      for (const line of choiceLines(ctx.session, ctx.now, depth, spend)) write(line);
      while (choice === null) {
        let answer: string;
        try {
          // Trailing SGR (no reset) tints the user's typed choice in the brand text
          // color, matching the idle prompt; empty at depth none so piped input is
          // unaffected.
          answer = await readChoice(`Your choice [1-${choices.length}]: ${inputSgr(depth)}`);
        } catch {
          // The choice read rejected: either the input stream closed (EOF /
          // Ctrl-D) or the REPL dismissed this prompt on Ctrl-C (
          // `ReplController.cancelChoice`). Abort the turn either way: the call
          // stays parked (the engine is authoritative), nothing is granted, and we
          // stop re-prompting on a closed or dismissed prompt.
          return;
        }
        choice = parseChoice(answer, spend);
        if (choice === null) {
          habenulaLine(
            spend ? "Please choose 1, 2, or 3." : "Please choose 1, 2, 3, or 4.",
            depth,
            write,
          );
        }
      }
    }

    // Human Touch: the last check before the wire, guarding
    // only the affirmative choices — `approve_once` moves money, so the answer
    // that spends is never the one that skips the gate.
    // A tier-1 LOCAL presence gate, not a security boundary — the engine
    // accepts /api/resolve with no proof of presence. Not-confirmed is a
    // non-resolution: nothing is sent, the call stays parked, and the loop
    // re-prompts so the user can retry or Deny.
    if (choice === "task" || choice === "session" || choice === "approve_once") {
      const confirmed = await (ctx.confirmPresence ?? (async () => true))();
      if (!confirmed) {
        habenulaLine(
          "Approval not confirmed — Touch ID was cancelled or failed. The request is still waiting; choose again or Deny.",
          depth,
          write,
        );
        continue;
      }
    }

    let response: ResolveResponse;
    try {
      response = await withSpinner("resolving…", () =>
        client.resolve(ctx.record.heldCallId, choice),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        habenulaLine(
          "That confirmation has expired — ask again and I'll re-request it.",
          depth,
          write,
        );
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        // A choice invalid for this hold's kind (the hold changed shape under
        // us, e.g. re-parked as a spending hold by a concurrent resolve). The
        // call stays parked; re-prompt against the hold as it now is.
        habenulaLine(
          `That answer doesn't apply to this request — ${err.message}`,
          depth,
          write,
        );
        try {
          const status = await withSpinner("checking…", () => client.getStatus());
          // Re-read THIS hold by id — several can be parked, and swapping the
          // prompt to a different one mid-interaction would mislead.
          const record = status.held.find(
            (h) => h.heldCallId === ctx.record.heldCallId,
          );
          if (record) {
            ctx = { ...ctx, record, session: status.session };
          }
        } catch {
          // Keep the record we have and re-prompt with it.
        }
        continue;
      }
      if (err instanceof ApiError && err.status === 409) {
        // Turn-in-flight (dead before the turn gate, wired now). The
        // call stays parked and unresolved; re-prompt so the user can retry
        // rather than dropping them back to the bare REPL.
        habenulaLine(
          "Another turn is in progress — try again in a moment; the request is still waiting.",
          depth,
          write,
        );
        continue;
      }
      throw err;
    }

    if (response.status === "info") {
      drawMetadata(response.metadata, depth, write);
      continue; // re-prompt; the call stays parked
    }

    // resumed: render the continued turn, then cascade if it parked a new call.
    drawResumedTurn(response.result, depth, write);
    const cascade = response.result.held;
    if (!cascade) {
      // Mirror the normal chat-turn path (chat.ts): after a terminal resumed
      // turn, surface the same post-turn remediation hint (connect / re-auth /
      // denied / error). Before this, the confirmation-resume path rendered the
      // tool lines and the agent prose but never the hint, so a call that hit an
      // unconnected / under-authorized service — or errored during execution —
      // right after the user approved it left them with no next step. Regression
      // since postTurnHints was first wired into chat.ts only (widened by the
      // error suffix). On a cascade (a new held call) we fall through to
      // re-prompt instead, matching chat.ts, which returns before hints fire
      // when a turn parks a call.
      const hints = postTurnHints(response.result.toolCalls);
      if (hints.length > 0) {
        write("");
        for (const hint of hints) write(hint);
      }
      return;
    }
    try {
      const status = await withSpinner("resolving…", () => client.getStatus());
      // The cascade names the freshly parked call; render THAT one — with
      // several holds parked, held[0] may be an older, unrelated question.
      const record = status.held.find(
        (h) => h.heldCallId === cascade.heldCallId,
      );
      if (!record) {
        habenulaLine(
          "Another tool call is awaiting confirmation — run `:status` to review it.",
          depth,
          write,
        );
        return;
      }
      ctx = { ...ctx, record, session: status.session };
      continue;
    } catch {
      habenulaLine(
        "Another tool call is awaiting confirmation — run `:status` to review it.",
        depth,
        write,
      );
      return;
    }
  }
}

// Re-export for callers that render a bare attributed line (chat fallback).
export { attribute };
export type { Speaker };
