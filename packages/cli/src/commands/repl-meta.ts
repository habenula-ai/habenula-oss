// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * REPL meta-command parser and dispatcher helpers.
 *
 * Inside the interactive REPL, lines beginning with ':' are interpreted as
 * meta-commands that call the same underlying runners as the top-level CLI
 * subcommands (:connect → runConnect, :status → runStatus, etc.). Anything
 * else is a chat turn sent to the agent.
 *
 * Exit vs quit are DIFFERENT verbs under single-session:
 * ':exit' / '.exit' / Ctrl-D DETACH — leave the CLI, the session survives and
 * a returning launch re-attaches. ':quit' / '.quit' END the active session
 * (POST /api/session/quit — grants expire, the slot frees), then leave. The
 * dot forms stay as synonyms of their colon forms (colon for vim/IRC, dot for
 * Node REPL — both are common muscle memory).
 */

import type { ActiveSessionView, ToolCallOutcome } from "../api-client";

export type ReplInput =
  | { kind: "chat"; text: string }
  | { kind: "connect"; service: string }
  | { kind: "disconnect"; service: string }
  | { kind: "status" }
  | { kind: "cap" }
  | { kind: "kill" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "exit" }
  | { kind: "quit" }
  | { kind: "blank" }
  | { kind: "error"; message: string };

/**
 * The canonical set of REPL meta-commands, in the order the autocomplete menu
 * offers them. One source of truth: `parseReplLine`'s switch
 * below and the completion model (`input/completion.ts`) both derive from this,
 * so a command added here surfaces in the menu without a second edit. `arg`
 * marks the commands that take a service name, so completion knows to offer the
 * service catalog after the command token. Only `:`-form names live here; the
 * `.`-form synonyms are parser-only muscle-memory aliases, never menu items.
 */
export interface MetaCommand {
  /** The `:`-prefixed command token (e.g. `:connect`). */
  readonly name: string;
  /** Set when the command takes a service-name argument (`:connect`/`:disconnect`). */
  readonly arg?: "service";
}

export const META_COMMANDS: readonly MetaCommand[] = [
  { name: ":help" },
  { name: ":status" },
  { name: ":cap" },
  { name: ":connect", arg: "service" },
  { name: ":disconnect", arg: "service" },
  { name: ":clear" },
  { name: ":kill" },
  { name: ":quit" },
  { name: ":exit" },
];

const EXIT_TOKENS = new Set([":exit", ".exit"]);
// Re-pointed: previously pure exit synonyms that never touched the
// server; now they end the active session. Deliberate muscle-memory change —
// the CLI verb must match the spec's "quit = end the session".
const QUIT_TOKENS = new Set([":quit", ".quit"]);

/**
 * Parse a raw REPL line. Pure function — no side effects.
 */
export function parseReplLine(line: string): ReplInput {
  const trimmed = line.trim();

  if (!trimmed) return { kind: "blank" };
  if (EXIT_TOKENS.has(trimmed)) return { kind: "exit" };
  if (QUIT_TOKENS.has(trimmed)) return { kind: "quit" };

  if (!trimmed.startsWith(":")) {
    return { kind: "chat", text: trimmed };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const head = parts[0] ?? "";
  const rest = parts.slice(1);

  switch (head) {
    case "help":
      return { kind: "help" };

    case "status":
      return { kind: "status" };

    case "cap":
      return { kind: "cap" };

    case "kill":
      return { kind: "kill" };

    case "clear":
      return { kind: "clear" };

    case "connect": {
      const service = rest[0];
      if (!service) {
        return {
          kind: "error",
          message: "Usage: :connect <service>  (e.g. mock_email, gmail)",
        };
      }
      return { kind: "connect", service };
    }

    case "disconnect": {
      const service = rest[0];
      if (!service) {
        return {
          kind: "error",
          message: "Usage: :disconnect <service>",
        };
      }
      return { kind: "disconnect", service };
    }

    default:
      return {
        kind: "error",
        message: `Unknown meta-command: :${head}. Type :help for the full list.`,
      };
  }
}

export const REPL_HELP = `REPL commands:
  :help                         Show this help.
  :status                       Show the active session, active grants, any pending confirmation, connected services, and default policy.
  :cap                          Show the spending caps and current window totals (set them with \`habenula cap\`).
  :connect <service>            Connect a service via OAuth (e.g. mock_email, gmail). Ctrl-C cancels a pending connect.
  :disconnect <service>         Disconnect a service.
  :clear                        Clear the screen, redraw the banner and prompt (touches no session or grant state).
  :kill                         Kill switch: clear all grants, deny all (connections preserved).
  :quit                         End the session (grants expire, slot frees), then leave. (.quit is a synonym)
  :exit                         Leave the REPL; the session stays active. (.exit is a synonym)

Anything else you type is sent to the agent as a chat message.`;

/**
 * The attach-on-refusal visibility notice: a second
 * launch is never locked out — the DO refused to CREATE a second session and
 * the client attaches to the active one. The common "I'm just back" case
 * reads as reassurance; the unexpected-collision case gets a beat and a
 * lever (:quit / :status). Pure — `now` injected for tests. Times are
 * omitted when unparseable/absent (the server's defensive expiry:null edge).
 */
export function resumeNotice(session: ActiveSessionView, now: Date): string {
  const times = sessionTimes(session, now);
  const when = times ? ` (started ${times.age} ago, ${times.left} left)` : "";
  return (
    `Resuming active session${when}. ` +
    "Not you? Another terminal may be connected — :quit to end it, or :status for detail."
  );
}

/**
 * Human age/remaining strings for a session ("12m", "78m"), or null when
 * either instant is missing/unparseable. Minutes-only: the 90-minute session
 * lifetime bounds both spans, so an hours form would be dead code. Values
 * clamp at "0m" (an expired session is reaped server-side before it is ever
 * reported, so negatives only mean clock skew).
 */
export function sessionTimes(
  session: ActiveSessionView,
  now: Date,
): { age: string; left: string } | null {
  if (session.expiry === null) return null;
  const started = new Date(session.startedAt).getTime();
  const expiry = new Date(session.expiry).getTime();
  if (Number.isNaN(started) || Number.isNaN(expiry)) return null;
  const minutes = (ms: number): string => `${Math.floor(Math.max(0, ms) / 60_000)}m`;
  return {
    age: minutes(now.getTime() - started),
    left: minutes(expiry - now.getTime()),
  };
}

/**
 * Derive post-turn CLI hints from the outcomes of the tool calls that
 * happened on this chat turn. Pure function — returns the lines to print
 * and lets the caller decide where they go (tested directly).
 *
 * Priority: not_connected > needs_authorization > boundary_refused > denied >
 * error. The most actionable hint for the user is the one that fires. Only one
 * hint per turn to keep the output tight.
 *
 * Why not_connected wins over denied: if no service is connected, the
 * user's first move is :connect. The governance pipeline reports both as a
 * deny under the hood, but the remediation is different and the wrong hint
 * sends the user into a loop.
 *
 * Why boundary_refused outranks denied: it is the one refusal with no
 * remediation at all, so the deny hint's "grant it via a confirmation" is not
 * merely unhelpful but false — the engine will never offer that confirmation.
 */
export function postTurnHints(
  toolCalls: ReadonlyArray<{ outcome: ToolCallOutcome; error?: string }>,
): string[] {
  // Defensive completeness: the held path renders the confirmation prompt and
  // returns before hints fire, so this branch is reached only if a "held"
  // outcome ever coexists with a fully-rendered turn. It still points the user
  // at the pending call rather than falling through to a connect/deny hint.
  const held = toolCalls.some((c) => c.outcome === "held");
  if (held) {
    return [
      "A tool call is awaiting your confirmation — run ':status' to review it.",
    ];
  }

  const notConnected = toolCalls.some((c) => c.outcome === "not_connected");
  if (notConnected) {
    return [
      "Tip: try ':connect mock_email' (or ':connect gmail') to connect a service.",
    ];
  }

  // Connected, but the stored credential's granted scopes don't cover the
  // tool. The remediation is a re-connect to grant
  // the wider access — not a policy change, and not a retry.
  const needsAuthorization = toolCalls.some(
    (c) => c.outcome === "needs_authorization",
  );
  if (needsAuthorization) {
    return [
      "Tip: the connected service isn't authorized for that action — re-connect it (e.g. ':connect gmail') to grant the access.",
    ];
  }

  // Not a policy outcome and not yours to change: the engine refused a
  // Habenula control operation named from a surface that may not reach one. The
  // hint states that and offers nothing, because there is nothing to offer —
  // no grant, no policy edit and no retry makes the call allowed.
  const boundaryRefused = toolCalls.some((c) => c.outcome === "boundary_refused");
  if (boundaryRefused) {
    return [
      "Habenula's own controls are reachable only from a trusted surface, so the engine refused that call. It isn't a policy setting, and no confirmation will be offered — use the ':kill', ':disconnect' or ':quit' command directly.",
    ];
  }

  const denied = toolCalls.some((c) => c.outcome === "denied");
  if (denied) {
    return [
      "This action was denied by your policy. Grant it via a confirmation when prompted.",
    ];
  }

  // An `error` outcome means the call passed the connection gate and then
  // failed during execution — the service is already connected, so a :connect
  // hint would loop the user through a pointless reconnect.
  const errored = toolCalls.filter((c) => c.outcome === "error");
  if (errored.length > 0) {
    // The tool line above now carries the reason, so the hint stops
    // apologizing for not having one and just names where to look. Only when
    // no reason came through — an older engine sends no `error` field — does
    // it fall back to the expectation-setting wording it had before.
    const hasReason = errored.some((c) => c.error !== undefined && c.error !== "");
    return hasReason
      ? [
          "That tool ran and failed — the reason is on its '[tool: …]' line above. Reconnecting won't help; try again or rephrase.",
        ]
      : [
          "That tool ran and failed — it's already connected, so reconnecting won't help. Try again, or rephrase your request.",
        ];
  }

  return [];
}
