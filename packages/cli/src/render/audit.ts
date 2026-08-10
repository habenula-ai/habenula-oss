// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `habenula log` table: the newest audit
 * entries, rendered for a human. Two fields the render must carry because
 * incident investigation sends users here for them: the entry `id` (the one
 * value a user is asked to quote) and `parametersMetadata` (the whole of what
 * "and its parameters" can mean while content capture is off).
 *
 * `noun`, `toolName`, `parametersMetadata`, and `errorMessage` originate
 * outside Habenula's trust boundary (LLM- and external-agent-authored), so
 * all four go through the shared `render/attribution` primitives — a
 * prompt-injected tool call must not be able to author a line that reads as
 * Habenula's own chrome.
 */

import type { AuditChainEntry } from "../api-client";
// The subpath, not the barrel, so no workers-typed module enters the CLI's
// typecheck program — the same way verify-chain is imported.
import { LIFECYCLE_TOOLS, checkDecisionClosure } from "@habenula-ai/audit/decision-closure";
import type { DecisionClosure } from "@habenula-ai/audit/decision-closure";
import {
  clampSanitized,
  displayWidth,
  layoutField,
  MAX_ERROR,
  MAX_TOOL,
  renderUntrusted,
} from "./attribution";
import { colorize, type ColorDepth, type ColorRole } from "./color";

const MAX_NOUN = 64;
const MAX_PARAMS = 256;
/** Decision/outcome are engine-authored from a closed set, but travel as
 * plain strings on the verbatim wire shape — clamped defensively. */
const MAX_VERDICT_WORD = 24;

/** State glyph + hue by decision/outcome, the same glyph-first convention as
 * the task queue (the glyph survives NO_COLOR). */
function entryGlyph(decision: string, outcome: string): { glyph: string; role: ColorRole } {
  if (decision === "deny") return { glyph: "✗", role: "denied" };
  if (decision === "pending") return { glyph: "●", role: "pending" };
  if (outcome === "error" || outcome === "timeout") return { glyph: "✗", role: "denied" };
  return { glyph: "✓", role: "granted" };
}

// Lifecycle rows are not governance verdicts: their decision/outcome columns
// carry fixed placeholders (session.end stamps deny/timeout, so painting the
// placeholder would render every ordinary session ending as a denied action).
// They render neutrally, with the disposition labeled a reason. The set now
// lives in @habenula-ai/audit (`decision-closure.ts`) — one definition for the CLI
// and the closure check alike; the dev-model page keeps an inline copy only
// because it is client JavaScript inside a template string.

/** A short relative age from an ISO timestamp; empty when unparseable/future. */
function formatAge(iso: string, now: Date): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * The closure marker a decision row's tuple line carries, or null for a row
 * the check found nothing on. Appended beside the stored decision/outcome
 * words, never replacing them (the render must not misrepresent what
 * the row stores). The WORD for an open decision comes off the verdict's
 * `openKind` rather than re-deriving from the stored `decision` — the check
 * decides the fact, this surface picks the word: a `dispatched` decision
 * with nothing recorded is a real gap (`unresolved`, and the one that stands
 * out); an `awaiting` one is an open prompt, the ordinary state — one word
 * for both would print "something is wrong" on every confirmation prompt and
 * stop meaning anything.
 */
function closureMarker(
  closure: DecisionClosure | undefined,
  depth: ColorDepth,
): { plain: string; colored: string } | null {
  if (closure === undefined) return null;
  if (closure.status === "conflicted") {
    const word = "⚠ conflicted";
    return { plain: ` ${word}`, colored: ` ${colorize(word, "denied", depth)}` };
  }
  if (closure.status === "unresolved") {
    const word = closure.openKind === "dispatched" ? "⚠ unresolved" : "… awaiting";
    return { plain: ` ${word}`, colored: ` ${colorize(word, "pending", depth)}` };
  }
  return null;
}

/** One audit entry as a block: the governed tuple line, then the identity
 * line (id + tool), the closers line (only on a conflicted decision), the
 * parameters line, and — only when present — the error line (a lifecycle
 * row's reason line). */
function renderEntry(
  entry: AuditChainEntry,
  now: Date,
  depth: ColorDepth,
  width: number,
  closure: DecisionClosure | undefined,
): string[] {
  const lifecycle = LIFECYCLE_TOOLS.has(entry.toolName);
  const { glyph, role } = lifecycle
    ? { glyph: "○", role: "muted" as ColorRole }
    : entryGlyph(entry.decision, entry.outcome);
  const decision = clampSanitized(entry.decision, MAX_VERDICT_WORD).text;
  const outcome = clampSanitized(entry.outcome, MAX_VERDICT_WORD).text;
  const service = clampSanitized(entry.service, MAX_NOUN).text;
  const verb = clampSanitized(entry.verb, MAX_NOUN).text;

  const rows: string[] = [];
  const chromePlain = lifecycle ? `${glyph} event` : `${glyph} ${decision} · ${outcome}`;
  const marker = closureMarker(closure, depth);
  const tuplePlain = `  ${chromePlain}${marker?.plain ?? ""}  ${service} · ${verb} · `;
  const tupleColored = `  ${colorize(chromePlain, role, depth)}${marker?.colored ?? ""}  ${colorize(`${service} · ${verb} · `, "habenula", depth)}`;
  const noun = renderUntrusted(entry.noun, MAX_NOUN);
  const age = formatAge(entry.timestamp, now);
  rows.push(
    ...layoutField({
      prefixColored: tupleColored,
      prefixWidth: displayWidth(tuplePlain),
      value: noun.text,
      width,
      continuationIndent: 4,
      ...(age !== ""
        ? { suffixColored: colorize(age, "muted", depth), suffixWidth: displayWidth(age) }
        : {}),
    }),
  );

  // The id is Habenula-minted chrome; the tool name is registry-derived but
  // rides the untrusted path like the task queue's labels.
  const tool = renderUntrusted(entry.toolName, MAX_TOOL);
  const idPlain = `    id ${entry.id} · tool `;
  rows.push(
    ...layoutField({
      prefixColored: `    ${colorize("id", "muted", depth)} ${entry.id} ${colorize("· tool", "muted", depth)} `,
      prefixWidth: displayWidth(idPlain),
      value: tool.text,
      width,
      continuationIndent: 6,
    }),
  );

  // The conflicted evidence: every closer the check saw, with the agreement
  // label. COMPLETE by construction — page one's upper edge is the chain tip
  // and a closer is always written after its decision, so a decision this
  // page renders has every closer of it on the same page; there is no
  // per-closer "unchecked" case for this line to carry.
  if (closure?.status === "conflicted") {
    const closerList = closure.closers
      .map(
        (c) =>
          `${clampSanitized(c.decision, MAX_VERDICT_WORD).text}·${clampSanitized(c.outcome, MAX_VERDICT_WORD).text} id ${c.id}`,
      )
      .join("; ");
    rows.push(
      ...layoutField({
        prefixColored: `    ${colorize("closers", "denied", depth)} `,
        prefixWidth: displayWidth("    closers "),
        value: `${closerList} (${closure.agreement ?? "conflicted"})`,
        width,
        continuationIndent: 6,
      }),
    );
  }

  const params = renderUntrusted(entry.parametersMetadata, MAX_PARAMS);
  rows.push(
    ...layoutField({
      prefixColored: `    ${colorize("params", "muted", depth)} `,
      prefixWidth: displayWidth("    params "),
      value: params.text,
      width,
      continuationIndent: 6,
    }),
  );

  if (entry.errorMessage !== null && entry.errorMessage !== "") {
    const error = renderUntrusted(entry.errorMessage, MAX_ERROR);
    const label = lifecycle ? "reason" : "error";
    rows.push(
      ...layoutField({
        prefixColored: `    ${colorize(label, lifecycle ? "muted" : "denied", depth)} `,
        prefixWidth: displayWidth(`    ${label} `),
        value: error.text,
        width,
        continuationIndent: 6,
      }),
    );
  }
  return rows;
}

/** The newest page, newest first. A non-null `nextCursor` is surfaced as a
 * footer so page one never reads as the whole log (silent-truncation guard —
 * older entries are reached with `log dump`). The closure check runs over
 * the page (page one's upper edge is the chain tip, so it is closed); what
 * the page genuinely cannot show is a decision OLDER than its edge whose
 * closers are on the page — there is no tuple line to hang a marker on, so
 * the footer names that limit and `habenula log verify` is the surface that
 * sees it. */
export function renderAuditPage(
  entries: AuditChainEntry[],
  nextCursor: string | null,
  opts: { now: Date; depth: ColorDepth; width: number },
): string[] {
  const { now, depth, width } = opts;
  if (entries.length === 0) {
    return ["Audit log is empty. Governed actions are recorded here as they run."];
  }
  const verdict = checkDecisionClosure([...entries].reverse(), { upperEdgeClosed: true });
  const closureById = new Map<string, DecisionClosure>();
  for (const finding of verdict.conflicted) closureById.set(finding.id, finding);
  for (const finding of verdict.unresolved) closureById.set(finding.id, finding);
  const rows: string[] = [colorize("Audit log — newest first:", "habenula", depth)];
  for (const entry of entries) {
    rows.push(...renderEntry(entry, now, depth, width, closureById.get(entry.id)));
  }
  if (nextCursor !== null) {
    rows.push(
      colorize(
        `  … older entries not shown (showing the ${entries.length} newest; \`habenula log dump\` reaches the rest). ` +
          `A decision older than this page can be conflicted or unresolved with nothing shown here — \`habenula log verify\` checks the whole chain.`,
        "muted",
        depth,
      ),
    );
  }
  return rows;
}
