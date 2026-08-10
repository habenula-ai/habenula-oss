// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiClient, GrantView, HeldCallRecord } from "../api-client";
import { sessionTimes } from "./repl-meta";
import {
  clampSanitized,
  displayWidth,
  layoutField,
  renderUntrusted,
  terminalWidth,
} from "../render/attribution";
import { colorize, detectColorDepth, type ColorDepth } from "../render/color";

const MAX_NOUN = 64;
const MAX_GOAL = 200;
const FLAG_TEXT = "⚠ unusual value";
// State glyphs carry the state at every depth (they survive NO_COLOR, where the
// hue washes out) — the load-bearing signal.
const GRANTED_GLYPH = "✓";
const PENDING_GLYPH = "●";

/**
 * `habenula status`. The session
 * line, active grants, and any pending held call all come from the aggregate
 * `getStatus()` — one atomic snapshot, so the three are mutually consistent
 * (dropping the separate `getActiveSession()` call). `getPolicy()` (the default
 * floor) and `listServices()` stay their own reads.
 *
 * `depth` is passed by the REPL (computed once at boot) and defaults to a fresh
 * detection for the top-level `habenula status` subcommand.
 */
export async function runStatus(
  client: ApiClient,
  depth: ColorDepth = detectColorDepth(),
): Promise<number> {
  const [{ session, grants, held }, { effectiveDecision }, { services }] =
    await Promise.all([client.getStatus(), client.getPolicy(), client.listServices()]);
  const now = new Date();
  const width = terminalWidth();
  const header = (label: string): string => colorize(label, "habenula", depth);

  // The active session first — it's what a refusal points the user at.
  // Age is the concurrency-awareness tell.
  if (session) {
    const times = sessionTimes(session, now);
    const when = times ? ` — started ${times.age} ago, ${times.left} left` : "";
    console.log(`${header("Active session:")} ${session.sessionId}${when}`);
  } else {
    console.log("No active session.");
  }

  console.log(`${header("Default policy:")} ${effectiveDecision}`);

  // Every pending held call (oldest first — the first is the next to
  // answer), plus one next-step line for the lot.
  if (held.length > 0) {
    console.log(
      header(
        held.length === 1
          ? "Pending confirmation:"
          : `Pending confirmations (${held.length}):`,
      ),
    );
    for (const record of held) {
      for (const row of renderHeld(record, depth, width)) console.log(row);
    }
    console.log(
      held.length === 1
        ? "Send a message or start a chat to review and approve it."
        : "Send a message or start a chat to review and approve them, oldest first.",
    );
  }

  // Connected services, each with the grants scoped to it nested beneath. Grants
  // (from /api/status) and services (from /api/services) are two lists joined
  // client-side on the shared `service` id. A grant whose service is no longer
  // connected (e.g. it outlived a disconnect) falls to an "Other grants" bucket
  // rather than vanishing.
  const grantsByService = new Map<string, GrantView[]>();
  for (const g of grants) {
    const list = grantsByService.get(g.service);
    if (list) list.push(g);
    else grantsByService.set(g.service, [g]);
  }

  if (services.length === 0) {
    console.log("No connected services.");
  } else {
    console.log(header("Connected services:"));
    for (const s of services) {
      // Human-typed via `:connect`, but escaped + width-wrapped before display too
      // (defense-in-depth — the forge guard applies to this surface as well).
      const name = clampSanitized(s.service, MAX_NOUN);
      const prefixPlain = "  - ";
      const since = `(since ${s.connected_at})`;
      for (const row of layoutField({
        prefixColored: prefixPlain,
        prefixWidth: prefixPlain.length,
        value: name.text,
        width,
        continuationIndent: 4,
        suffixColored: since,
        suffixWidth: since.length,
      })) {
        console.log(row);
      }
      const svcGrants = grantsByService.get(s.service);
      grantsByService.delete(s.service); // consumed — leftover keys are orphans
      if (!svcGrants || svcGrants.length === 0) {
        console.log(colorize("      (no active grants)", "muted", depth));
      } else {
        for (const grant of svcGrants) {
          for (const row of renderNestedGrant(grant, now, depth, width)) console.log(row);
        }
      }
    }
  }

  // Orphan grants — service not in the connected list — rendered with the full
  // `service · verb` prefix since there is no heading to nest them under.
  const orphanServices = [...grantsByService.keys()];
  if (orphanServices.length > 0) {
    console.log(header("Other grants (service not connected):"));
    for (const svc of orphanServices) {
      for (const grant of grantsByService.get(svc)!) {
        for (const row of renderGrant(grant, now, depth, width)) console.log(row);
      }
    }
  }

  // One nudge when there are no grants at all.
  if (grants.length === 0) {
    console.log(
      "No active grants yet. Ask the agent to do something — you'll be prompted to approve.",
    );
  }

  return 0;
}

/**
 * One grant row: a deep-seafoam `✓` state glyph + brand-text `service · verb` chrome +
 * byte-sanitized noun + lifetime (chrome stays the brand text color,
 * the glyph carries state, so the governance identity is consistent and the
 * load-bearing state signal is the glyph, not the row hue). Routed through
 * `layoutField` so a wide/bidi/long grant noun hard-wraps instead of
 * soft-wrapping the row into a forged flush-left line — `GrantView.noun`
 * is unvalidated on the read path. An altered noun is flagged.
 */
function renderGrant(grant: GrantView, now: Date, depth: ColorDepth, width: number): string[] {
  const chromePlain = `${grant.service} · ${grant.verb}`;
  const prefixPlain = `  ${GRANTED_GLYPH} ${chromePlain} · `;
  const prefixColored = `  ${colorize(GRANTED_GLYPH, "granted", depth)} ${colorize(chromePlain, "habenula", depth)} · `;
  // Untrusted on the read path — quoted so a `·` in the noun can't forge a
  // second scope, flagged if it carries one.
  const noun = renderUntrusted(grant.noun, MAX_NOUN);
  const suffix = buildSuffix(noun.altered || noun.truncated, grantLifetime(grant, now), depth);
  return layoutField({
    prefixColored,
    prefixWidth: displayWidth(prefixPlain),
    value: noun.text,
    width,
    continuationIndent: 4,
    ...suffix,
  });
}

/**
 * A grant nested under its connected-service heading: the deep-seafoam `✓` glyph +
 * brand-text `verb` chrome + byte-sanitized noun + lifetime, indented beneath the
 * service. The `service ·` prefix is dropped — the heading already names the
 * service; `renderGrant` keeps the full prefix for the orphan "Other grants"
 * bucket, where there is no heading. Same forge guard: trusted glyph+verb chrome,
 * the untrusted noun quoted and width-wrapped through `layoutField`.
 */
function renderNestedGrant(grant: GrantView, now: Date, depth: ColorDepth, width: number): string[] {
  const prefixPlain = `      ${GRANTED_GLYPH} ${grant.verb} · `;
  const prefixColored = `      ${colorize(GRANTED_GLYPH, "granted", depth)} ${colorize(grant.verb, "habenula", depth)} · `;
  const noun = renderUntrusted(grant.noun, MAX_NOUN);
  const suffix = buildSuffix(noun.altered || noun.truncated, grantLifetime(grant, now), depth);
  return layoutField({
    prefixColored,
    prefixWidth: displayWidth(prefixPlain),
    value: noun.text,
    width,
    continuationIndent: 8,
    ...suffix,
  });
}

/** The lifetime text (no leading separator): a session grant's remaining minutes or a task grant's single-use. */
function grantLifetime(grant: GrantView, now: Date): string {
  if (grant.source === "task") return "— single-use";
  if (grant.expiresAt === null) return "";
  const left = new Date(grant.expiresAt).getTime() - now.getTime();
  if (Number.isNaN(left)) return "";
  return `— ~${Math.floor(Math.max(0, left) / 60_000)}m left`;
}

/**
 * The pending held call: a peach `●` state glyph + brand-text chrome + sanitized
 * noun (mirrors the prompt action line). A commissioned hold (origin set) leads
 * with the `↑ incoming` badge + goal — `habenula status` is the pre-wiring
 * discovery surface for a parked commission, so it must distinguish an external
 * agent's request from the user's own agent's call, same as the prompt.
 */
function renderHeld(held: HeldCallRecord, depth: ColorDepth, width: number): string[] {
  const rows: string[] = [];
  if (held.origin === "mcp_commission") {
    rows.push(
      `  ${colorize("↑ incoming", "incoming", depth)} ${colorize("· commissioned by an external agent", "habenula", depth)}`,
    );
    if (held.goal !== undefined) {
      // Goal is external-agent-authored — sanitized untrusted data,
      // flagged only on tampering (a long goal's truncation is benign).
      const goal = renderUntrusted(held.goal, MAX_GOAL);
      const goalPrefix = "    goal: ";
      rows.push(
        ...layoutField({
          prefixColored: goalPrefix,
          prefixWidth: displayWidth(goalPrefix),
          value: goal.text,
          width,
          continuationIndent: 6,
          ...(goal.altered
            ? { suffixColored: colorize(FLAG_TEXT, "pending", depth), suffixWidth: displayWidth(FLAG_TEXT) }
            : {}),
        }),
      );
    }
  }
  const chromePlain = `${held.service} · ${held.verb}`;
  const prefixPlain = `  ${PENDING_GLYPH} ${chromePlain} · `;
  const prefixColored = `  ${colorize(PENDING_GLYPH, "pending", depth)} ${colorize(chromePlain, "habenula", depth)} · `;
  // Untrusted on the read path — quoted + flagged like the grant noun.
  const noun = renderUntrusted(held.noun, MAX_NOUN);
  const suffix = buildSuffix(noun.altered || noun.truncated, "", depth);
  rows.push(
    ...layoutField({
      prefixColored,
      prefixWidth: displayWidth(prefixPlain),
      value: noun.text,
      width,
      continuationIndent: 4,
      ...suffix,
    }),
  );
  return rows;
}

/** Compose the trailing flag + lifetime into one colored suffix and its plain display width. */
function buildSuffix(
  altered: boolean,
  lifetime: string,
  depth: ColorDepth,
): { suffixColored?: string; suffixWidth?: number } {
  const flagPlain = altered ? FLAG_TEXT : "";
  const parts = [flagPlain, lifetime].filter((p) => p !== "");
  if (parts.length === 0) return {};
  const coloredFlag = altered ? colorize(FLAG_TEXT, "pending", depth) : "";
  const coloredParts = [coloredFlag, lifetime].filter((p) => p !== "");
  return { suffixColored: coloredParts.join(" "), suffixWidth: displayWidth(parts.join(" ")) };
}
