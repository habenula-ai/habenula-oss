// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The pure completion model behind the REPL's `:`-command autocomplete.
 * No terminal, no I/O — given the current input buffer
 * and the known service names, it decides what the menu should offer; given a
 * menu state and a navigation key, it moves the highlight. The raw-mode editor
 * (`input/line-editor.ts`) owns the keystrokes and the drawing; everything
 * decidable without a terminal lives here so it is unit-tested headlessly.
 *
 * Two completion contexts, both keyed off the buffer text:
 *   - **command** — the buffer is a bare `:`-stem with no space yet
 *     (`:co` → `:connect`). Offers matching `META_COMMANDS`.
 *   - **service argument** — the buffer is a service-taking command followed by
 *     a space (`:connect gm` → `gmail`). Offers matching service names, sourced
 *     from the connectable catalog for `:connect` and the connected set for
 *     `:disconnect`.
 * Anything else — a chat message, an unknown command, a second argument token —
 * yields no completions, so the menu stays closed.
 */

import { META_COMMANDS } from "../commands/repl-meta";

/**
 * The service names each argument-taking command completes against. `:connect`
 * draws from the connectable catalog; `:disconnect` from the user's connected
 * services. The editor fetches both at startup and re-seeds
 * them after a mid-session `:connect`/`:disconnect` (`ReplIO.refreshCompletions`);
 * this module only reads them. Server-side changes the CLI didn't
 * initiate stay invisible until the next refresh — no push channel yet.
 */
export interface ServiceSource {
  /** Connectable services (the catalog) — the `:connect` argument set. */
  connectable: readonly string[];
  /** Currently-connected services — the `:disconnect` argument set. */
  connected: readonly string[];
}

/** A resolved menu item: the full token to insert, and how the command's arg (if any) is handled on accept. */
export interface Completion {
  /** The text shown in the menu row and used to replace the current token. */
  readonly value: string;
  /**
   * True when accepting this item should leave the menu open for a follow-on
   * argument — a service-taking command completed at the command stage. The
   * editor appends a space and re-derives the (service) completions.
   */
  readonly expectsArg: boolean;
}

/**
 * Match `:`-command names against a bare command stem (no space typed yet).
 * `":"` alone matches every command; `":co"` narrows by prefix. Returns `[]`
 * for a non-`:` buffer (a chat message) or once a space has been typed (the
 * command token is complete — service-argument completion takes over).
 */
export function filterCommands(input: string): Completion[] {
  if (!input.startsWith(":") || input.includes(" ")) return [];
  return META_COMMANDS.filter((c) => c.name.startsWith(input)).map((c) => ({
    value: c.name,
    expectsArg: c.arg === "service",
  }));
}

/**
 * Match service names for a service-taking command against the partial argument
 * `stem`. An empty stem lists every candidate; a non-empty stem narrows by
 * prefix. Returns `[]` for a command that takes no service argument.
 */
export function filterServiceArgs(
  command: string,
  stem: string,
  services: ServiceSource,
): Completion[] {
  const list =
    command === ":connect"
      ? services.connectable
      : command === ":disconnect"
        ? services.connected
        : [];
  return list
    .filter((s) => s.startsWith(stem))
    .map((s) => ({ value: s, expectsArg: false }));
}

/**
 * The single entry the editor calls on every buffer change: decide the menu
 * items for the current buffer. Splits on the FIRST space — everything before
 * is the command token, everything after is the argument region. A second space
 * in the argument region (`:connect gmail x`) means the argument is already
 * committed, so nothing more completes.
 */
export function computeCompletions(input: string, services: ServiceSource): Completion[] {
  const firstSpace = input.indexOf(" ");
  if (firstSpace === -1) return filterCommands(input);
  const command = input.slice(0, firstSpace);
  const argRegion = input.slice(firstSpace + 1);
  // Only a single argument token completes; a space within it commits the arg.
  if (argRegion.includes(" ")) return [];
  return filterServiceArgs(command, argRegion, services);
}

/** The autocomplete menu's state: the current items, the highlighted index, and whether it is showing. */
export interface MenuState {
  readonly items: readonly Completion[];
  readonly index: number;
  readonly open: boolean;
}

/** The empty (closed) menu — the editor's starting and reset state. */
export const CLOSED_MENU: MenuState = { items: [], index: 0, open: false };

/**
 * The menu reducer. Pure: a state and an action in, the
 * next state out, so the arrow-navigation and open/close logic is unit-tested
 * without a terminal.
 *
 *   - `set` — recompute after a buffer change. Opens iff there are items;
 *     resets the highlight to the top (Claude-Code-style: a fresh filter always
 *     highlights the first match).
 *   - `up` / `down` — move the highlight with wraparound; a no-op on a closed or
 *     empty menu.
 *   - `close` — dismiss (Esc). Stays closed until the next `set` reopens it, so
 *     Enter after Esc submits the line rather than accepting a hidden item.
 */
export type MenuAction =
  | { type: "set"; items: Completion[] }
  | { type: "up" }
  | { type: "down" }
  | { type: "close" };

export function reduceMenu(state: MenuState, action: MenuAction): MenuState {
  switch (action.type) {
    case "set":
      return { items: action.items, index: 0, open: action.items.length > 0 };
    case "close":
      return { ...state, open: false };
    case "up":
    case "down": {
      const n = state.items.length;
      if (!state.open || n === 0) return state;
      const delta = action.type === "down" ? 1 : -1;
      return { ...state, index: (state.index + delta + n) % n };
    }
  }
}
