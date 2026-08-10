// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createInterface } from "node:readline/promises";
import type { ApiClient } from "../api-client";
import { EngineUnavailableError } from "../api-client";
import { EngineState } from "../engine-state";
import type { PresenceGate } from "../gate/confirm-presence";
import { printError } from "../errors";
import { runConnect } from "./connect";
import { runDisconnect } from "./disconnect";
import { runKill } from "./kill";
import { runQuit } from "./quit";

import { runCap } from "./cap";
import { runStatus } from "./status";
import {
  parseReplLine,
  postTurnHints,
  REPL_HELP,
  resumeNotice,
  type ReplInput,
} from "./repl-meta";
import { attribute, displayWidth, sanitize, toolCallLine } from "../render/attribution";
import { colorize, detectColorDepth, inputSgr, type ColorDepth } from "../render/color";
import { renderBanner, shouldShowBanner } from "../render/banner";
import { renderPrompt } from "../render/prompt";
import { withSpinner } from "../render/spinner";
import { defaultPollOnError, startPoll, PromptLatch, type PollableIO } from "../poll";
import { RawLineEditor, type RawInput } from "../input/line-editor";
import type { SelectionChoice } from "../input/menu";
import type { ServiceSource } from "../input/completion";
import type { ServicesResponse, StatusResponse } from "@habenula-ai/contracts";

/**
 * Interactive REPL. Lines beginning with ':' are meta-commands that call the
 * same underlying runners as the top-level CLI subcommands; everything else is a
 * chat turn sent to /api/chat. After each chat turn, deterministic post-turn
 * hints fire for denied or errored tool calls.
 *
 * The REPL runs on a `line` listener rather than an idle `rl.question("> ")`:
 * the proactive poll must be able to draw a confirmation over the
 * pending input while the user sits idle, which a pending `question` promise
 * forbids (readline won't queue a second `question`). A single line router hands
 * each entered line to the *current consumer* — the idle dispatcher, or, while a
 * confirmation is open, that prompt's choice reader (which takes precedence). A
 * shared `PromptLatch` keeps the poll and the reactive path from both rendering
 * the same held call.
 *
 * Current scope: synchronous request/response, no streaming. Upgrade to
 * WebSocket is tracked in the technical backlog.
 */

/**
 * The readline surface the REPL drives. Injectable so wiring tests can script
 * the loop without a PTY. `node:readline`'s `Interface` (+ the stdout cursor
 * helpers) satisfies it structurally via `defaultIO`. It is line-driven (not
 * `question`-based) so the poll can compose over a pending input line: read the
 * half-typed buffer, erase it (display-width-aware, so a wrapped/wide line is
 * fully cleared), draw the confirmation above, and restore.
 */
export interface ReplIO {
  /** Register the single line handler; each entered line invokes it. */
  onLine(cb: (line: string) => void): void;
  /** Register the close (EOF / Ctrl-D / stream end) handler. */
  onClose(cb: () => void): void;
  /**
   * Register the Ctrl-C handler (readline's interface `SIGINT` event, PTY-
   * verified). Registering suppresses readline's default
   * kill-the-process behavior; the REPL uses it to cancel a pending
   * `:connect`, or dismiss an open confirmation prompt (the held call stays
   * parked) — or, with nothing pending, to close like Ctrl-D.
   */
  onSigint(cb: () => void): void;
  /** Set the input prompt string (e.g. `> ` or `Your choice [1-4]: `). */
  setPrompt(prompt: string): void;
  /** (Re)display the prompt; `preserveCursor` keeps the half-typed buffer. */
  showPrompt(preserveCursor?: boolean): void;
  /**
   * Enter confirmation-chooser mode: draw `prompt` with the `choices` listed
   * beneath it, `defaultIndex` highlighted, and resolve the pending choice read
   * (via `onLine`) with the chosen `token` on Enter (arrow-key nav).
   * Present only on the raw-mode editor (a TTY); absent on the plain readline
   * reader, whose confirmations fall back to typed `1-4`. `ReplController` and
   * `renderPrompt` feature-detect it, so the seam stays optional.
   */
  beginSelection?(prompt: string, choices: readonly SelectionChoice[], defaultIndex: number): void;
  /** The current half-typed input buffer (readline's `.line`). */
  currentLine(): string;
  /**
   * Visually clear the (empty) prompt line so the confirmation can draw from
   * column 0. The poll only calls this when the input line is empty (it defers
   * while the user is mid-typing — node:readline can't lift a live buffer
   * aside), so there is no half-typed text to preserve. Paired with `restoreInput`.
   */
  eraseInputLine(): void;
  /** Re-show the `> ` prompt after a confirmation drew over it. */
  restoreInput(): void;
  /** Write a line of output above the input. */
  write(text: string): void;
  /**
   * Whether the poll should defer this tick rather than draw a confirmation over
   * the input. The raw-mode editor owns its buffer, so it defers only while the
   * completion menu is open; the plain readline reader can't
   * lift a live buffer, so it defers while the user is mid-typing (the original
   * constraint).
   */
  deferPoll(): boolean;
  /**
   * Feed the latest `GET /api/status` snapshot so the editor can repaint its live
   * status line. A no-op on the plain reader, which has no
   * status line.
   */
  setStatus(status: StatusResponse): void;
  /**
   * Re-seed the completion service sources after a mid-session
   * `:connect`/`:disconnect` changed what is connected. Best-effort and
   * non-blocking like the boot seed: fire-and-forget fetches, and an
   * unreachable Worker leaves the last-known sets in place. Present only on
   * the raw-mode editor — the plain reader has no completion menu — so the
   * seam stays optional (the `beginSelection` pattern).
   */
  refreshCompletions?(): void;
  close(): void;
}

/**
 * The `node:readline` surface `defaultIO` uses. The promises `Interface` has all
 * of these at runtime (it extends the callback `Interface`), but our minimal
 * typings expose only a thin slice — so `defaultIO` casts to this structural type
 * for the line buffer, prompt control, and `line`/`close` events it needs.
 */
interface NodeReadline {
  on(event: "line", cb: (line: string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "SIGINT", cb: () => void): void;
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  getPrompt(): string;
  readonly line: string;
  close(): void;
}

/**
 * How many visual rows the prompt + typed buffer occupy at `cols` columns — the
 * height `eraseInputLine` walks up to clear. The prompt is `sanitize`d first so a
 * zero-width SGR it carries (the typed-input tint) is never counted
 * as visible columns and cannot overcount the height. Pure and
 * exported so the row math is unit-tested rather than only dogfooded.
 */
export function wrappedRowCount(promptText: string, bufferText: string, cols: number): number {
  const width = displayWidth(sanitize(promptText)) + displayWidth(bufferText);
  const c = cols > 0 ? cols : 80;
  return Math.max(1, Math.ceil((width || 1) / c));
}

/**
 * Choose the REPL's line producer. An interactive TTY gets the hand-rolled
 * raw-mode editor — command autocomplete, owned buffer; a
 * piped / non-interactive session, or an explicit `HABENULA_PLAIN_INPUT=1`
 * opt-out (the rollback lever), gets the plain readline
 * reader. Both satisfy the same `ReplIO` seam, so `ReplController`, the loop,
 * and the poll are identical either way — including the `onSigint` Ctrl-C
 * routing, which the editor delivers from a raw `0x03` byte instead
 * of readline's SIGINT event.
 */
function defaultIO(
  client: ApiClient,
  depth: ColorDepth,
  connectedOnce: Promise<ServicesResponse>,
): ReplIO {
  const stdin = process.stdin as { isTTY?: boolean };
  const plain = process.env.HABENULA_PLAIN_INPUT;
  const usePlain = !stdin.isTTY || (plain !== undefined && plain !== "");
  if (usePlain) return plainIO();

  // The editor completes against the service catalog (`:connect`) and the
  // connected set (`:disconnect`). Fetch both at boot, best-effort: the menu
  // shows service arguments as soon as they load, and never blocks the prompt
  // on the network — an unreachable Worker just means no service completions.
  // The connected set reuses the boot `listServices` read the nudge also consumes.
  const sources = serviceSourceCell();
  sources.seed(loadServices(client, connectedOnce));
  const editor = new RawLineEditor({
    input: process.stdin as unknown as RawInput,
    output: process.stdout,
    depth,
    getServices: sources.get,
    onExit: (cb) => process.on("exit", cb),
  });
  // Mid-session re-seed: the editor re-reads `getServices` on every
  // keystroke, so refreshing is just repopulating the cell. Same best-effort
  // loader as the boot seed, but against a FRESH `listServices` read
  // (`connectedOnce` is by now a stale snapshot). A failed read reports `null`
  // and the cell keeps that source's last-known set, so completions degrade
  // to stale, never to none. The catalog rides along even though a connect
  // can't change it: the refresh is the one later moment a failed boot
  // catalog read can heal (it fires only while the engine is reachable), and
  // `CatalogResponse` doesn't promise the set is session-immutable anyway.
  return Object.assign(editor, {
    refreshCompletions: (): void => {
      sources.seed(loadServices(client, client.listServices()));
    },
  });
}

/**
 * One best-effort read of the two completion sources. A source that failed to
 * load is `null` — nothing learned, keep what you have — distinct from a
 * successful empty read (`[]`), which is real data (no connected services
 * after disconnecting the last one) and must overwrite.
 */
export interface ServiceLoad {
  connectable: readonly string[] | null;
  connected: readonly string[] | null;
}

/**
 * Holder for the editor's completion sources. `seed` stamps each load with an
 * issue-order generation, and each SOURCE keeps the newest successful read it
 * has seen: a load's result lands only where no newer load has already landed
 * that source, and a failed (`null`) source lands nothing. The boot seed and
 * every mid-session refresh are unordered fire-and-forget fetches, so
 * without the stamp a slow boot read (e.g. a hung catalog fetch) could settle
 * after a fresher refresh and clobber it with a pre-connect snapshot —
 * resurrecting exactly the staleness the refresh exists to fix.
 *
 * Freshness is judged per source, not per load: a refresh whose catalog read
 * failed learned nothing about the catalog, so it must not stop a slower boot
 * read — still the newest SUCCESSFUL catalog read — from landing it. A
 * rejected load is treated as a wholly-failed read (both sources `null`)
 * rather than left to reject unhandled; none is expected, since `loadServices`
 * settles per-source failures to `null`.
 */
export function serviceSourceCell(): {
  get: () => ServiceSource;
  seed: (load: Promise<ServiceLoad>) => void;
} {
  const services: { connectable: readonly string[]; connected: readonly string[] } = {
    connectable: [],
    connected: [],
  };
  let issued = 0;
  const applied = { connectable: 0, connected: 0 };
  return {
    get: () => services,
    seed: (load) => {
      const g = ++issued;
      void load.then(
        (s) => {
          for (const key of ["connectable", "connected"] as const) {
            const read = s[key];
            if (read !== null && g > applied[key]) {
              services[key] = read;
              applied[key] = g;
            }
          }
        },
        () => {},
      );
    },
  };
}

/**
 * Best-effort fetch of the completion service sources. The two sources are
 * independent endpoints — `getCatalog` (`/api/services/catalog`) feeds
 * `:connect`, `listServices` (`/api/services`) feeds `:disconnect` — so they
 * are settled independently: a failure of one leaves the other populated. A
 * shared `Promise.all` used to couple them, so a transient `listServices`
 * rejection (e.g. the engine momentarily down at boot) silently emptied the
 * connectable catalog too, killing `:connect` completion for the whole session.
 *
 * A failed source is reported as `null`, never as an empty set: the cell keeps
 * that source's last-known completions, so a refresh against an
 * unreachable Worker degrades to stale completions instead of wiping them —
 * while a successful empty read (`[]`) is real data and overwrites.
 */
export async function loadServices(
  client: ApiClient,
  connectedOnce: Promise<ServicesResponse>,
): Promise<ServiceLoad> {
  const [catalog, connected] = await Promise.allSettled([
    client.getCatalog(),
    connectedOnce,
  ]);
  return {
    connectable:
      catalog.status === "fulfilled" ? catalog.value.services.map((s) => s.service) : null,
    connected:
      connected.status === "fulfilled" ? connected.value.services.map((s) => s.service) : null,
  };
}

function plainIO(): ReplIO {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  }) as unknown as NodeReadline;
  const out = process.stdout;
  return {
    onLine: (cb) => rl.on("line", cb),
    onClose: (cb) => rl.on("close", cb),
    onSigint: (cb) => rl.on("SIGINT", cb),
    setPrompt: (prompt) => rl.setPrompt(prompt),
    showPrompt: (preserveCursor) => rl.prompt(preserveCursor),
    currentLine: () => rl.line,
    eraseInputLine: () => {
      if (out.isTTY) {
        // The prompt + half-typed buffer can wrap across several visual rows on a
        // narrow terminal or with wide graphemes. Move to the top of that block
        // and clear everything below via ANSI (CR, cursor-up, clear-to-end), so no
        // stale row survives for the confirmation to interleave with (the
        // width-aware erase). ANSI rather than `readline.cursorTo`/`clearScreenDown`
        // because our minimal typings don't expose `node:readline`'s free functions.
        // Row count via the pure `wrappedRowCount` (unit-tested), which sanitizes
        // the prompt's zero-width input SGR out of the width so it can't overcount.
        const cols = out.columns && out.columns > 0 ? out.columns : 80;
        const rows = wrappedRowCount(rl.getPrompt(), rl.line, cols);
        out.write(rows > 1 ? `\r\x1b[${rows - 1}A\x1b[0J` : `\r\x1b[0J`);
      }
    },
    restoreInput: () => {
      // Re-show whatever prompt is currently set (the idle prompt, which carries
      // the trailing typed-input SGR) — the buffer was empty when erased.
      rl.prompt();
    },
    write: (text) => {
      out.write(`${text}\n`);
    },
    // Readline can't lift a live buffer aside, so the poll must defer while the
    // user is mid-typing (the constraint the editor lifts).
    deferPoll: () => rl.line !== "",
    // No status line on the plain reader — the opt-out trades fidelity for the
    // battle-tested readline path.
    setStatus: () => {},
    close: () => rl.close(),
  };
}

/**
 * Routes each entered line to the current consumer. A confirmation's choice
 * reader takes precedence over the idle dispatcher: while a prompt is open, the
 * next line is its answer, and the idle `nextLine()` awaiter stays pending until
 * the confirmation resolves. On close, both awaiters reject so their loops end.
 */
class ReplController {
  private idleWaiter: ((line: string) => void) | null = null;
  private idleReject: ((err: Error) => void) | null = null;
  private choiceWaiter: ((line: string) => void) | null = null;
  private choiceReject: ((err: Error) => void) | null = null;
  private closed = false;

  constructor(
    private readonly io: ReplIO,
    /** Restored after a choice read settles; `nextIdleLine` keeps it current. */
    private restingPrompt: string | null = null,
  ) {
    io.onLine((line) => this.route(line));
    io.onClose(() => {
      this.closed = true;
      // Reject BOTH pending reads so their awaiters unwind on EOF (Ctrl-D). The
      // idle read rejecting breaks the loop; an open confirmation's choice read
      // rejecting aborts that turn (the call stays parked, never granted) rather
      // than re-prompting forever on a dead stream. Delivering an empty answer
      // instead would loop `renderPrompt` on a `question` that can never arrive —
      // the confirmation never returns and the REPL hangs on exit.
      const idleReject = this.idleReject;
      const choiceReject = this.choiceReject;
      this.idleWaiter = null;
      this.idleReject = null;
      this.choiceWaiter = null;
      this.choiceReject = null;
      idleReject?.(new Error("closed"));
      choiceReject?.(new Error("closed"));
    });
  }

  private route(line: string): void {
    if (this.choiceWaiter) {
      const w = this.choiceWaiter;
      this.choiceWaiter = null;
      this.choiceReject = null;
      w(line);
      return;
    }
    if (this.idleWaiter) {
      const w = this.idleWaiter;
      this.idleWaiter = null;
      this.idleReject = null;
      w(line);
    }
    // No waiter (e.g. a stray line between turns) is dropped — harmless.
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Await the next idle input line; rejects on close (EOF). */
  nextIdleLine(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.restingPrompt = prompt;
    this.io.setPrompt(prompt);
    this.io.showPrompt();
    return new Promise((resolve, reject) => {
      this.idleWaiter = resolve;
      this.idleReject = reject;
    });
  }

  /**
   * Await the next line as a confirmation choice (takes precedence over idle).
   * Rejects on close (EOF), symmetric with `nextIdleLine`, so a Ctrl-D during an
   * open confirmation aborts the turn instead of hanging on a dead stream.
   */
  nextChoiceLine(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.io.setPrompt(prompt);
    this.io.showPrompt();
    return new Promise((resolve, reject) => {
      this.choiceWaiter = resolve;
      this.choiceReject = reject;
    });
  }

  /**
   * Await the next confirmation choice made in the arrow-key chooser:
   * drives `io.beginSelection`, which resolves this read (through the same
   * `onLine` route as `nextChoiceLine`) with the chosen choice's token on Enter.
   * Same precedence, cancel, and close semantics as `nextChoiceLine` — Ctrl-C
   * (`cancelChoice`) and EOF both reject it, leaving the call parked. The caller
   * only reaches here when `io.beginSelection` exists (TTY editor).
   */
  nextChoiceSelection(
    prompt: string,
    choices: readonly SelectionChoice[],
    defaultIndex: number,
  ): Promise<string> {
    if (this.closed) return Promise.reject(new Error("closed"));
    this.io.beginSelection!(prompt, choices, defaultIndex);
    return new Promise((resolve, reject) => {
      this.choiceWaiter = resolve;
      this.choiceReject = reject;
    });
  }

  /**
   * Dismiss an OPEN confirmation prompt (Ctrl-C) without closing the REPL:
   * reject the pending choice read so `renderPrompt` unwinds exactly as it does
   * on EOF — the held call stays parked (nothing granted), and control returns
   * to the idle prompt with the session intact. Leaves the idle waiter and the
   * `closed` flag untouched, so this is a per-prompt cancel, not a detach.
   * Returns whether a choice read was actually pending; the caller falls back to
   * detach (close) when nothing was.
   */
  cancelChoice(): boolean {
    const reject = this.choiceReject;
    if (!reject) return false;
    this.choiceWaiter = null;
    this.choiceReject = null;
    reject(new Error("cancelled"));
    // A dismissed prompt is a terminal settle: put the idle prompt string back
    // so the next repaint shows `> `, not the dead choice prompt.
    this.restoreRestingPrompt();
    return true;
  }

  /**
   * Reset the shared prompt string to the resting (idle) prompt after a choice
   * read settles — the single owner of the restore. A choice read mutates
   * the shared prompt; when it interrupted an OUTSTANDING idle read (the
   * proactive poll's case) no idle loop iteration follows to set it back, so
   * the settle must. String reset only, no repaint: the poll's
   * `restoreInputLine` repaints the input line, and the reactive path's next
   * idle read issues its own `showPrompt`. Callers fire this on terminal
   * settles only — the tell-me-more loop lives inside `renderPrompt`, and its
   * callers wrap the whole call, so a mid-confirmation re-read never sees the
   * idle prompt.
   *
   * Deliberately NOT gated on `closed`: EOF is a terminal settle too, and
   * `onClose` flips `closed` before the choice read rejects — a closed guard
   * here would skip the reset on exactly that path, letting the poll's exit
   * repaint show the dead choice prompt. Setting a prompt string on a closed
   * readline is a harmless field write.
   */
  restoreRestingPrompt(): void {
    if (this.restingPrompt === null) return;
    this.io.setPrompt(this.restingPrompt);
  }
}

/** Injectable REPL dependencies: test seams, plus the presence gate index.ts binds. */
export interface RunChatReplOptions {
  /**
   * Whether to run the proactive poll. Defaults to whether stdout is a TTY — a
   * piped/non-interactive session has no idle prompt to surface over, so it
   * doesn't poll. Tests set it explicitly (with `pollSleep`) to exercise wiring.
   */
  poll?: boolean;
  /** Override the poll's sleep so tests don't wait the real interval. */
  pollSleep?: (ms: number) => Promise<void>;
  /**
   * Human Touch presence gate, threaded to every
   * confirmation prompt this REPL renders (reactive turn and poll alike).
   * Defaults to always-true — index.ts constructs the real config-bound gate.
   */
  confirmPresence?: PresenceGate;
  /**
   * Override the connect wait's poll sleep so tests don't wait the real 2s
   * interval — the `pollSleep` precedent, for the `:connect` dispatch.
   */
  connectSleep?: (ms: number) => Promise<void>;
  /**
   * Override the `:connect` browser opener. Defaults to `runConnect`'s
   * platform opener, which spawns a real `open`/`xdg-open` — so a test that
   * drives `:connect` with a returned authorize URL must inject a no-op here,
   * or the CLI test run pops a browser window (the `connectSleep` precedent).
   */
  openBrowser?: (url: string) => void;
  /**
   * Override the `:kill` retry-window sleep so tests drive the retry loop and
   * its Ctrl-C give-up without waiting — the `connectSleep` precedent.
   */
  killSleep?: (ms: number) => Promise<void>;
  /**
   * Override the offline health-probe backoff sleep so
   * tests drive the recovery loop without waiting — the `pollSleep` precedent.
   */
  probeSleep?: (ms: number) => Promise<void>;
}

export async function runChatRepl(
  client: ApiClient,
  createIO?: () => ReplIO,
  opts: RunChatReplOptions = {},
): Promise<number> {
  const depth = detectColorDepth();
  // One boot `listServices` read, shared by the completion seed and the
  // first-run nudge (they used to fetch it independently). The no-op `.catch`
  // attaches a handler synchronously so a rejection is never unhandled before a
  // consumer awaits it; each consumer still sees the rejection via its own await.
  const connectedOnce = client.listServices();
  connectedOnce.catch(() => {});
  // Tests inject `createIO`; production builds the TTY-aware producer (raw-mode
  // editor or plain reader) from the client + resolved color depth.
  const rl = (createIO ?? (() => defaultIO(client, depth, connectedOnce)))();
  // The idle prompt carries a trailing SGR (no reset) so the user's typed
  // input echoes in the brand text color; empty at depth `none`, so a piped session
  // gets a plain `> `. The SGR is zero-width, and readline strips VT control
  // characters when it measures the prompt for its own cursor / wrapped-line
  // tracking, so it does not skew that math even when the typed line wraps
  // (reasoned from readline's ANSI-stripping width calc; worth a
  // real-terminal wrapping-input smoke check before merge).
  const idlePrompt = `> ${inputSgr(depth)}`;
  // Seeded as the controller's resting prompt, so a choice read that fires
  // before the first idle read (a commission surfacing during boot) still
  // restores to the real idle prompt.
  const ctrl = new ReplController(rl, idlePrompt);
  // Shared by the reactive path and the poll so the same held call never renders
  // twice; it clears on resolve completion.
  const latch = new PromptLatch();

  // Ctrl-C routing: SIGINT cancels whatever is pending and
  // returns to the idle prompt with the session intact — never grabbing stdin
  // or exiting the process. Precedence: a `:connect` wait aborts first; else an
  // open confirmation prompt is dismissed (the held call stays parked); else,
  // if a turn is mid-flight (an uncancelable chat turn or a quick meta-command),
  // Ctrl-C is a no-op with a hint rather than a detach — detaching mid-turn
  // would drop the user out of the session and could swallow a confirmation the
  // turn is about to raise. Only at the idle prompt, with nothing running, does
  // Ctrl-C behave as EOF — close and detach, like Ctrl-D.
  // One parked-abort slot: only ever one foreground dispatch runs at a time, so
  // a single slot serves every cancelable dispatch (`:connect`'s wait, `:kill`'s
  // retry). The SIGINT handler checks it first, ahead of the in-flight
  // no-op, so Ctrl-C reaches the cancel even though `dispatch.inFlight` is set.
  const pendingCancel: { abort: (() => void) | null } = { abort: null };
  const dispatch = { inFlight: false };
  rl.onSigint(() => {
    if (pendingCancel.abort) {
      pendingCancel.abort();
      return;
    }
    if (ctrl.cancelChoice()) {
      console.log("(cancelled — the call is still pending; run :status to review it)");
      return;
    }
    if (dispatch.inFlight) {
      console.log("(a turn is in progress — it can't be interrupted; Ctrl-C at the prompt detaches)");
      return;
    }
    rl.close();
  });

  printBanner(depth);
  console.log(
    colorize(
      "Interactive session. Type :help for commands, or ask me anything.",
      "habenula",
      depth,
    ),
  );

  let active = true;

  // First-run nudge, at most once per session: inline on a clean boot,
  // deferred to recovery when boot found the engine down (the tracker's
  // goOnline fires it; the guard makes repeated recoveries no-ops).
  let nudged = false;
  const onFirstRunNudge = async (): Promise<void> => {
    if (nudged) return;
    nudged = true;
    await maybePrintFirstRunNudge(client, depth);
  };

  // The engine-state tracker: every REPL surface routes
  // availability failures here; the loop and the poll gate on isOffline().
  // Its recovery handshake runs notice-suppressed — the reconnect is narrated
  // by the recovery line alone, never a replayed session-attach notice.
  const tracker = new EngineState({
    apiUrl: client.apiUrl,
    probeHealth: () => client.probeHealth(),
    runLaunchHandshake: () =>
      performLaunchHandshake(client, depth, { renderNotices: false }),
    onFirstRunNudge,
    write: (line) => console.log(line),
    // Muted stderr, like the poll's default sink: a swallowed recovery-handshake
    // bug is visible to anyone watching stderr without intruding on the REPL.
    diagnose: (message) => console.error(message),
    sleep: opts.probeSleep ?? unrefSleep,
    isActive: () => active,
  });

  try {
    await performLaunchHandshake(client, depth, { renderNotices: true });
    await onFirstRunNudge();
  } catch (err) {
    if (err instanceof EngineUnavailableError) {
      // Boot before the engine (the driving scenario): guidance once, the
      // nudge deferred to recovery, and the REPL opens offline and probes.
      tracker.noteFailure(err, "foreground");
    } else {
      // Reachable-engine failure or unrecognized payload — session state is
      // unverified, the REPL still opens (chat lazily establishes a session).
      console.log(colorize(SESSION_UNVERIFIED_NOTICE, "habenula", depth));
      await onFirstRunNudge();
    }
  }
  console.log(""); // set the boot block off from the first prompt

  // The proactive poll runs alongside the idle loop: it surfaces a held call
  // that arrived with no user turn (an inbound MCP commission), composing over
  // the input line rather than racing the pending read. Only in an interactive
  // TTY — a piped session has no idle prompt to surface over.
  const readChoice = (prompt: string): Promise<string> => ctrl.nextChoiceLine(prompt);
  // Arrow-key confirmation chooser: present only when the IO supports it
  // (the raw-mode TTY editor). Absent → `renderPrompt` falls back to typed `1-4`,
  // so the plain readline reader and scripted test IOs are unchanged.
  const readSelection = rl.beginSelection
    ? (
        prompt: string,
        choices: readonly SelectionChoice[],
        defaultIndex: number,
      ): Promise<string> => ctrl.nextChoiceSelection(prompt, choices, defaultIndex)
    : undefined;
  const confirmPresence = opts.confirmPresence ?? (async () => true);
  const pollEnabled = opts.poll ?? Boolean(process.stdout.isTTY);
  const pollDone = pollEnabled
    ? startPoll({
        // The request layer's control deadline bounds this read; the poll
        // threads no timeout of its own.
        getStatus: () => client.getStatus(),
        renderHeld: async (record) => {
          try {
            await renderPrompt({
              client,
              record,
              session: null,
              readChoice,
              readSelection,
              depth,
              now: new Date(),
              confirmPresence,
            });
          } finally {
            // Terminal settle of a poll-drawn confirmation (answered, thrown
            // resolve, dismissed, EOF): the idle read it drew over is still
            // outstanding, so nothing else resets the prompt string before
            // the poll's `restoreInputLine` repaints it.
            ctrl.restoreRestingPrompt();
          }
        },
        io: pollableIO(rl),
        latch,
        isActive: () => active,
        // Offline pause: the health probe is the only offline traffic; the
        // poll resumes on recovery with latch/cooldown state intact.
        isPaused: () => tracker.isOffline(),
        // Availability routes to the tracker (background source — a deadline
        // alone must not flap the state); everything else keeps the muted
        // stderr sink.
        onError: (err) => {
          if (err instanceof EngineUnavailableError) {
            tracker.noteFailure(err, "background");
          } else {
            defaultPollOnError(err);
          }
        },
        ...(opts.pollSleep ? { sleep: opts.pollSleep } : {}),
      })
    : Promise.resolve();

  try {
    for (;;) {
      let line: string;
      try {
        line = await ctrl.nextIdleLine(idlePrompt);
      } catch {
        break; // EOF (Ctrl-D) / stream close
      }
      // Reset the input tint once the line is submitted, so the no-reset input SGR
      // can't bleed into the turn's output, meta-command text, or the
      // blank rhythm gaps. No-op at depth none (prompt had no SGR).
      if (depth !== "none") process.stdout.write("\x1b[0m");

      const parsed = parseReplLine(line);
      if (parsed.kind === "exit") break; // detach — the session survives
      if (parsed.kind === "quit") {
        // Engine-touching, like the dispatch below: offline gets the one-line
        // notice and still exits the loop — the request is skipped, and the
        // session's own 90-minute timeout frees the slot.
        if (tracker.isOffline()) {
          console.log(tracker.offlineNotice());
          break;
        }
        try {
          await runQuit(client);
        } catch (err) {
          if (err instanceof EngineUnavailableError) {
            tracker.noteFailure(err, "foreground");
          } else {
            printError(err);
          }
        }
        break;
      }
      if (parsed.kind === "blank") continue;

      // Engine-touching input while offline gets the offline notice, never a
      // request — an explicit action is never met with silence. Local kinds
      // (help, error) run regardless of state. `:kill` is also exempt: it is the
      // emergency stop, and runKill is built to retry against an unavailable
      // engine until the kill lands (a mid-restart kill must still land). Gating
      // it here would silently swallow the one command that most needs to reach
      // the engine — so it drives its own offline/retry handling in dispatch.
      if (
        parsed.kind !== "help" &&
        parsed.kind !== "error" &&
        parsed.kind !== "kill" &&
        tracker.isOffline()
      ) {
        console.log(tracker.offlineNotice());
        continue;
      }

      dispatch.inFlight = true;
      try {
        await dispatchReplInput(client, parsed, readChoice, readSelection, latch, depth, confirmPresence, {
          pendingCancel,
          connectSleep: opts.connectSleep,
          openBrowser: opts.openBrowser,
          killSleep: opts.killSleep,
        });
      } catch (err) {
        // A foreground availability failure — the user's own in-flight
        // request — always transitions offline, deadline included.
        if (err instanceof EngineUnavailableError) {
          tracker.noteFailure(err, "foreground");
        } else {
          printError(err);
        }
      } finally {
        dispatch.inFlight = false;
        // A `:connect`/`:disconnect` may have changed the connected set, so
        // re-seed the editor's completion sources. Unconditional on the
        // outcome — a cancelled or failed dispatch may still have landed
        // server-side — and fire-and-forget, so the next prompt never waits.
        // Skipped only when the dispatch itself took the tracker offline: the
        // health probe is the only offline traffic (the poll's invariant), and
        // a refresh against the same dead engine would just fall back to the
        // sets it already has.
        if (
          (parsed.kind === "connect" || parsed.kind === "disconnect") &&
          !tracker.isOffline()
        ) {
          rl.refreshCompletions?.();
        }
      }
    }
  } finally {
    active = false;
    rl.close();
    await pollDone;
  }
  return 0;
}

/**
 * Adapt the REPL's readline surface to the poll's `PollableIO`.
 * `restoreInputLine` re-displays the input line after the confirmation drew
 * over it — the plain reader re-issues the prompt, the raw editor repaints and
 * puts back any buffer it stashed. The prompt STRING is already correct by the
 * time this runs: `ReplController.restoreRestingPrompt` resets it on every
 * terminal settle of a choice read (the poll's `renderHeld` wrapper, Ctrl-C's
 * `cancelChoice`), so ownership of "put the prompt back" lives with the
 * controller, not here. An earlier fix threaded the idle prompt through this
 * adapter; that threading is gone.
 */
function pollableIO(rl: ReplIO): PollableIO {
  return {
    deferPoll: () => rl.deferPoll(),
    eraseInputLine: () => rl.eraseInputLine(),
    restoreInputLine: () => rl.restoreInput(),
    setStatus: (status) => rl.setStatus(status),
  };
}

/**
 * The HABENULA boot banner (TTY-gated, suppressible via HABENULA_NO_BANNER).
 * Silent on a non-TTY, so piped/scripted runs emit no banner frames.
 */
function printBanner(depth: ColorDepth): void {
  if (!shouldShowBanner(process.env, Boolean(process.stdout.isTTY))) return;
  const width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  for (const line of renderBanner(depth, width)) console.log(line);
  console.log(""); // gap after the banner block (TTY-only, since the banner is gated)
}

type DispatchableInput = Exclude<
  ReplInput,
  { kind: "exit" } | { kind: "quit" } | { kind: "blank" }
>;

/** The arrow-key chooser reader, or undefined when the IO can't select. */
type ReadSelection = (
  prompt: string,
  choices: readonly SelectionChoice[],
  defaultIndex: number,
) => Promise<string>;

async function dispatchReplInput(
  client: ApiClient,
  input: DispatchableInput,
  readChoice: (prompt: string) => Promise<string>,
  readSelection: ReadSelection | undefined,
  latch: PromptLatch,
  depth: ColorDepth,
  confirmPresence: PresenceGate,
  cancel: {
    /** The Ctrl-C routing slot — parked abort while a cancelable dispatch (a
     * connect wait or a kill retry) is pending. */
    pendingCancel: { abort: (() => void) | null };
    connectSleep?: (ms: number) => Promise<void>;
    openBrowser?: (url: string) => void;
    killSleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  switch (input.kind) {
    case "help":
      console.log(REPL_HELP);
      return;
    case "error":
      console.error(input.message);
      return;
    case "status":
      await runStatus(client, depth);
      return;
    case "cap":
      await runCap(client);
      return;
    case "kill": {
      // Park an abort for the retry window's duration (the `:connect` precedent
      // below): Ctrl-C gives up on the retry and hands control back to the idle
      // prompt instead of freezing until the 30s window elapses. The give-up
      // rethrows the availability error, which the dispatch loop routes to the
      // engine tracker — the REPL transitions offline and probes.
      const controller = new AbortController();
      cancel.pendingCancel.abort = () => controller.abort();
      try {
        // `sleep` is undefined in production; runKill `??`-defaults it, so
        // passing it straight through is equivalent to omitting it.
        await runKill(client, {
          signal: controller.signal,
          sleep: cancel.killSleep,
        });
      } finally {
        cancel.pendingCancel.abort = null;
      }
      return;
    }
    case "clear":
      // Ctrl-L gesture: clear the screen + scrollback and home the cursor, then
      // repopulate the boot banner header so a cleared screen looks like a fresh
      // session (not a bare prompt), and let the loop redraw the prompt beneath
      // it. Touches no session or governance state. TTY-only — piping
      // clear-screen escapes into a redirected stream is noise. `printBanner` is
      // itself TTY- and `HABENULA_NO_BANNER`-gated, so a suppressed banner just
      // leaves a clean screen.
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        printBanner(depth);
      }
      return;
    case "connect": {
      // Park an abort in the SIGINT slot for the wait's duration: Ctrl-C
      // cancels this connect and hands control back to the idle prompt —
      // runConnect prints the outcome; the REPL deliberately ignores its
      // exit code (an in-session cancel is not a process exit).
      const controller = new AbortController();
      cancel.pendingCancel.abort = () => controller.abort();
      try {
        // `sleep`/`openBrowser` are undefined in production; runConnect
        // `??`-defaults each to its real implementation, so passing them
        // straight through is equivalent to omitting them (a test injects both).
        await runConnect(client, input.service, {
          cancelSignal: controller.signal,
          sleep: cancel.connectSleep,
          openBrowser: cancel.openBrowser,
        });
      } finally {
        cancel.pendingCancel.abort = null;
      }
      return;
    }
    case "disconnect":
      await runDisconnect(client, input.service);
      return;
    case "chat":
      await handleChatTurn(client, input.text, readChoice, readSelection, latch, depth, confirmPresence);
      return;
  }
}

/** The Habenula-attributed fallback when a held turn's record can't be fetched. */
export const HELD_FALLBACK_LINE =
  "A tool call is awaiting confirmation — run `:status` or send a message to review it.";

/**
 * One chat turn. When the turn parked a tool call (`held` set), do NOT print
 * `result.response` (a fresh hold returns `""`; the outstanding-held guard
 * returns an explanatory sentence, which would double-message alongside the
 * rendered prompt). Fetch the render-ready record via `getStatus()` and draw the
 * confirmation prompt under the shared latch (so a poll tick can't double-render
 * the same call); on a null record (a resolve/expiry raced the fetch), a thrown
 * `getStatus()`, or the latch already held by the poll, render a Habenula
 * fallback line rather than a blank turn. The engine stays authoritative, so the
 * fallback is a legibility floor, not a correctness fix. A normal turn renders
 * the agent response and tool narration through the attribution/forge guard.
 */
async function handleChatTurn(
  client: ApiClient,
  message: string,
  readChoice: (prompt: string) => Promise<string>,
  readSelection: ReadSelection | undefined,
  latch: PromptLatch,
  depth: ColorDepth,
  confirmPresence: PresenceGate,
): Promise<void> {
  const result = await withSpinner("working…", () => client.chat(message));

  if (result.held) {
    let record;
    let session = null;
    try {
      const status = await client.getStatus();
      // The turn's own parked call, by id — with several holds parked,
      // held[0] may be an older question from another task.
      const turnHeldId = result.held.heldCallId;
      record = status.held.find((h) => h.heldCallId === turnHeldId);
      session = status.session;
    } catch {
      record = undefined;
    }
    if (record && latch.tryAcquire(record.heldCallId)) {
      try {
        await renderPrompt({
          client,
          record,
          session,
          readChoice,
          readSelection,
          depth,
          now: new Date(),
          confirmPresence,
        });
      } finally {
        latch.release(record.heldCallId);
      }
      return;
    }
    for (const row of attribute("habenula", HELD_FALLBACK_LINE, { depth })) {
      console.log(row);
    }
    return;
  }

  for (const call of result.toolCalls) {
    // Marker, failure suffix, and failure reason all come from `toolCallLine`,
    // shared with the resumed-turn renderer so the two never drift. The
    // untrusted name and error are quoted and bounded there.
    for (const row of attribute("habenula", toolCallLine(call), { depth })) {
      console.log(row);
    }
  }
  if (result.response !== "") {
    // Gap between the tool-call markers and the agent's prose.
    if (result.toolCalls.length > 0) console.log("");
    for (const row of attribute("agent", result.response, { depth })) {
      console.log(row);
    }
  }
  // Post-turn hints stay a pure list from `postTurnHints`; the separating blank
  // is added here at the call site, not inside the pure function.
  const hints = postTurnHints(result.toolCalls);
  if (hints.length > 0) {
    console.log("");
    for (const hint of hints) console.log(hint);
  }
}

/**
 * Printed when the handshake cannot determine session state. Unlike the
 * first-run nudge (a convenience tip, silently skippable), the resume notice
 * is a governance-visibility surface — the spec's returning-user mitigation —
 * so its absence must be legible, not silent: a user who can't be shown
 * "Resuming active session" must at least know the state is unverified.
 */
export const SESSION_UNVERIFIED_NOTICE =
  "Couldn't verify session state — run :status to check for an active session.";

/**
 * The launch handshake: POST /api/session/start. On
 * `started`, enter the loop in the new session — silently; the banner is
 * enough. On `refused` (a session is already active), attach and enter the
 * loop anyway with a visibility notice — a refusal is informational, not an
 * error: the DO attaches every chat to the active session regardless of
 * client, so refusing to enter the loop would be a veneer a raw POST
 * /api/chat bypasses (the accepted shared-session model in this release). On an
 * unrecognized payload, print the session-unverified line and still open
 * the REPL — chat lazily establishes a session either way.
 *
 * Errors propagate to the caller: the boot path routes
 * availability to the tracker and renders the unverified notice for the
 * rest; the tracker's recovery re-run passes `renderNotices: false` — a
 * mid-session restart 409-refuses every recovery handshake, so replaying
 * the attach notice each time would be noise.
 */
async function performLaunchHandshake(
  client: ApiClient,
  depth: ColorDepth,
  opts: { renderNotices: boolean },
): Promise<void> {
  const result = await client.startSession();
  if (!opts.renderNotices) return;
  if (result.status === "refused") {
    console.log(colorize(resumeNotice(result.activeSession, new Date()), "habenula", depth));
  } else if (result.status !== "started") {
    console.log(colorize(SESSION_UNVERIFIED_NOTICE, "habenula", depth));
  }
}

/** Unref'd sleep for the offline probe backoff, so a pending probe interval
 * never keeps the process alive after the REPL closes (the poll's pattern). */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * On REPL boot, if no services are connected and the default policy is
 * still deny, print a one-line tip so the user has an obvious first move.
 * Silently skipped if the Worker is unreachable — the REPL itself should
 * still be usable so the user can type :status and see the real error.
 */
async function maybePrintFirstRunNudge(
  client: ApiClient,
  depth: ColorDepth,
): Promise<void> {
  try {
    // A FRESH services read, not the boot-time `connectedOnce`: this fires
    // inline on a clean boot but is also DEFERRED to recovery when boot found
    // the engine down. In that case `connectedOnce` rejected
    // at boot and stays rejected, so reusing it would silence the nudge for
    // exactly the offline-boot user it is meant to greet.
    const [{ services }, { effectiveDecision }] = await Promise.all([
      client.listServices(),
      client.getPolicy(),
    ]);
    if (services.length === 0 && effectiveDecision === "deny") {
      console.log(
        colorize(
          "Tip: try ':connect mock_email' to connect a mock email inbox, then ask the agent to do something — you'll be prompted to approve tool calls.",
          "habenula",
          depth,
        ),
      );
    }
  } catch {
    // Worker unreachable at boot — skip the nudge and let the user discover.
  }
}
