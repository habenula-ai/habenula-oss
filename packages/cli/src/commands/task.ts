// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ApiClient,
  ApiError,
  type StatusResponse,
  type TaskActionDetail,
  type TaskCancelResponse,
  type TaskDetailResponse,
  type TaskStatus,
  type TaskSummary,
} from "../api-client";
import {
  clampSanitized,
  displayWidth,
  layoutField,
  renderUntrusted,
  terminalWidth,
} from "../render/attribution";
import { colorize, detectColorDepth, type ColorDepth, type ColorRole } from "../render/color";
import { POLL_INTERVAL_MS } from "../poll";

/**
 * The `habenula task` command surface:
 * `list` / `show <id>` / `cancel <id>` / `watch`. The queue is metadata only
 * — origin, status, a derived label, the per-action breakdown, and (for a
 * needs_input task) the slot it awaits. Every external-agent-authored field
 * (label, goal, noun) is untrusted read-path data, so it
 * is byte-sanitized and forge-guarded through the shared `render/attribution`
 * primitives before display — a prompt-injected commission can never author the
 * queue view. There is no `task amend`: amend re-supplies client-held data and is
 * MCP-only (a human amends by chatting).
 */

const MAX_LABEL = 100;
const MAX_GOAL = 400;
const MAX_NOUN = 64;

/** The state glyph + hue for a task status. The glyph carries the state at every
 * color depth (it survives NO_COLOR), the hue is the reinforcing signal — the
 * same convention as the confirmation/status renderers. */
function statusGlyph(status: TaskStatus): { glyph: string; role: ColorRole } {
  switch (status) {
    case "running":
      return { glyph: "▸", role: "pending" };
    case "awaiting_confirmation":
      return { glyph: "●", role: "pending" };
    case "needs_input":
      return { glyph: "●", role: "incoming" };
    case "completed":
      return { glyph: "✓", role: "granted" };
    case "failed":
    case "denied":
      return { glyph: "✗", role: "denied" };
    case "cancelled":
    case "expired":
      return { glyph: "–", role: "muted" };
  }
}

/** A short relative age from an ISO timestamp; empty for an unparseable/future one. */
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
 * One task as a queue row: the state glyph + brand-text `status` chrome + the task
 * id (the handle for `show`/`cancel`) + the untrusted label, with origin and age
 * as the trailing suffix. Routed through `layoutField` so a wide/bidi/long label
 * hard-wraps instead of forging a flush-left line; the label is quoted+flagged
 * when sanitization altered its bytes.
 */
function renderTaskRow(
  task: TaskSummary,
  now: Date,
  depth: ColorDepth,
  width: number,
): string[] {
  const { glyph, role } = statusGlyph(task.status);
  const chromePlain = `${glyph} ${task.status}`;
  // The id is Habenula-minted (not agent-authored), so it is trusted chrome.
  const prefixPlain = `  ${chromePlain}  ${task.taskId} · `;
  const prefixColored = `  ${colorize(chromePlain, role, depth)}  ${task.taskId} · `;
  const label = renderUntrusted(task.label, MAX_LABEL);
  const age = formatAge(task.createdAt, now);
  const suffixPlain = [task.origin, age].filter((p) => p !== "").join(" · ");
  return layoutField({
    prefixColored,
    prefixWidth: displayWidth(prefixPlain),
    value: label.text,
    width,
    continuationIndent: 4,
    ...(suffixPlain !== ""
      ? {
          suffixColored: colorize(suffixPlain, "muted", depth),
          suffixWidth: displayWidth(suffixPlain),
        }
      : {}),
  });
}

/** The queue as a list — a header and one row per task, or an empty-state nudge.
 * `nextCursor` is surfaced as a footer so a truncated list never reads as the
 * whole queue (silent-truncation guard). */
export function renderTaskList(
  tasks: TaskSummary[],
  nextCursor: string | null,
  opts: { now: Date; depth: ColorDepth; width: number },
): string[] {
  const { now, depth, width } = opts;
  if (tasks.length === 0) {
    return ["No tasks. Commission one from a connected agent, or start chatting."];
  }
  const rows: string[] = [colorize("Tasks:", "habenula", depth)];
  for (const task of tasks) rows.push(...renderTaskRow(task, now, depth, width));
  if (nextCursor !== null) {
    rows.push(
      colorize(
        `  … more tasks not shown (showing the ${tasks.length} most recent)`,
        "muted",
        depth,
      ),
    );
  }
  return rows;
}

/** One governed action within a task: `service · verb · <noun>` → outcome. The
 * noun is untrusted read-path data, quoted+flagged through `renderUntrusted`. */
function renderActionDetail(
  detail: TaskActionDetail,
  depth: ColorDepth,
  width: number,
): string[] {
  const outcomeRole: ColorRole =
    detail.outcome === "executed"
      ? "granted"
      : detail.outcome === "denied"
        ? "denied"
        : "pending";
  const chromePlain = `${detail.service} · ${detail.verb} · `;
  const prefixPlain = `    ${chromePlain}`;
  const prefixColored = `    ${colorize(chromePlain, "habenula", depth)}`;
  const noun = renderUntrusted(detail.noun, MAX_NOUN);
  const suffix = `→ ${detail.outcome}`;
  return layoutField({
    prefixColored,
    prefixWidth: displayWidth(prefixPlain),
    value: noun.text,
    width,
    continuationIndent: 6,
    suffixColored: colorize(suffix, outcomeRole, depth),
    suffixWidth: displayWidth(suffix),
  });
}

/** One task's full record: summary, goal, per-action breakdown, and — for a
 * needs_input task — the published slot key(s) it awaits. */
export function renderTaskDetail(
  detail: TaskDetailResponse,
  opts: { now: Date; depth: ColorDepth; width: number },
): string[] {
  const { now, depth, width } = opts;
  const { task, statusDetail, awaitedSlotKeys } = detail;
  const { glyph, role } = statusGlyph(task.status);
  const header = (label: string): string => colorize(label, "habenula", depth);
  const rows: string[] = [];
  rows.push(`${header("Task:")} ${task.taskId}`);
  // formatAge is "" for an unparseable/future timestamp — drop empty parts so the
  // line never ends in a dangling separator (renderTaskRow filters the same way).
  const meta = [task.origin, formatAge(task.createdAt, now)].filter((p) => p !== "");
  rows.push(
    `${header("Status:")} ${colorize(`${glyph} ${task.status}`, role, depth)} · ${meta.join(" · ")}`,
  );
  // Goal is external-agent-authored — sanitized untrusted data, flagged on tamper.
  const goal = renderUntrusted(task.goal, MAX_GOAL);
  const goalPrefix = `${header("Goal:")} `;
  rows.push(
    ...layoutField({
      prefixColored: goalPrefix,
      prefixWidth: displayWidth("Goal: "),
      value: goal.text,
      width,
      continuationIndent: 2,
    }),
  );
  if (awaitedSlotKeys !== null && awaitedSlotKeys.length > 0) {
    // Published slot keys are a closed, charset-constrained vocabulary
    // (/^[A-Za-z0-9_-]+$/) — trusted chrome, but clamped defensively.
    const keys = awaitedSlotKeys.map((k) => clampSanitized(k, MAX_NOUN).text).join(", ");
    rows.push(`${header("Awaiting input:")} ${keys}`);
    rows.push(
      colorize(
        "  The commissioning agent supplies these via habenula_provide.",
        "muted",
        depth,
      ),
    );
  }
  if (statusDetail !== null && statusDetail.length > 0) {
    rows.push(header("Actions:"));
    for (const d of statusDetail) rows.push(...renderActionDetail(d, depth, width));
  }
  return rows;
}

/** Hard ceiling on `--all` page-following, so a corrupt or non-advancing cursor
 * can never spin forever. 200 pages × the 200-row server cap is far past any
 * realistic queue history. */
const MAX_PAGES = 200;

/**
 * `habenula task list` — the queue, newest first. Paginated: `--limit` sizes one
 * page (server-clamped), `--all` follows `nextCursor` to the end. Without `--all`
 * a truncated list says so rather than reading as the whole queue. Paging matters
 * for more than completeness: `task cancel <id>` needs an id from this list, so a
 * task outside page 1 would otherwise be uncancellable from the CLI.
 */
export async function runTaskList(
  client: ApiClient,
  options: { limit?: number; all?: boolean } = {},
  depth: ColorDepth = detectColorDepth(),
): Promise<number> {
  const first = await client.listTasks(
    options.limit !== undefined ? { limit: options.limit } : undefined,
  );
  const tasks = [...first.tasks];
  let nextCursor = first.nextCursor;
  if (options.all) {
    let pages = 1;
    const seen = new Set(tasks.map((t) => t.taskId));
    while (nextCursor !== null && pages < MAX_PAGES) {
      const page = await client.listTasks({
        cursor: nextCursor,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      // A cursor the server declines to advance past (or one that restarts at page
      // 1) would otherwise re-report the same rows forever — stop on no progress.
      const fresh = page.tasks.filter((t) => !seen.has(t.taskId));
      if (fresh.length === 0) break;
      for (const t of fresh) seen.add(t.taskId);
      tasks.push(...fresh);
      nextCursor = page.nextCursor;
      pages += 1;
    }
  }
  const lines = renderTaskList(tasks, options.all ? null : nextCursor, {
    now: new Date(),
    depth,
    width: terminalWidth(),
  });
  for (const line of lines) console.log(line);
  return 0;
}

/** `habenula task show <id>` — one task's full record. A 404 is a clean
 * "unknown task" message + exit 1, not a stack trace. */
export async function runTaskShow(
  client: ApiClient,
  taskId: string,
  depth: ColorDepth = detectColorDepth(),
): Promise<number> {
  let detail: TaskDetailResponse;
  try {
    detail = await client.getTask(taskId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.log(`No such task: ${clampSanitized(taskId, MAX_NOUN).text}`);
      return 1;
    }
    throw err;
  }
  const lines = renderTaskDetail(detail, {
    now: new Date(),
    depth,
    width: terminalWidth(),
  });
  for (const line of lines) console.log(line);
  return 0;
}

/**
 * `habenula task cancel <id>` — the human cancel surface, authoritative over
 * every origin. Branches on the informative outcomes (`cancelled` / `running` /
 * `not_cancellable`) and on the `ApiError` refusals: a 404 is an unknown task, a
 * 409 (`TURN_IN_PROGRESS`) is a live turn in flight (retry).
 */
export async function runTaskCancel(
  client: ApiClient,
  taskId: string,
): Promise<number> {
  const safeId = clampSanitized(taskId, MAX_NOUN).text;
  // Annotated, not inferred: an un-annotated `let` is an evolving `any`, which
  // suppresses the switch's exhaustiveness check. Without it an unmodelled status
  // (respond() only LOGS a contract violation, it never rejects) falls off the
  // switch, returns undefined, and `wrap` exits 0 — a silent success on failure.
  let result: TaskCancelResponse;
  try {
    result = await client.cancelTask(taskId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      console.log(`No such task: ${safeId}`);
      return 1;
    }
    if (err instanceof ApiError && err.status === 409) {
      console.log(
        `Task ${safeId} has a turn in progress — it stays queued. Try again in a moment.`,
      );
      return 1;
    }
    throw err;
  }
  switch (result.status) {
    case "cancelled":
      console.log(`Cancelled task ${safeId} (was ${result.previousStatus}).`);
      return 0;
    case "running":
      console.log(
        `Task ${safeId} is running and can't be cancelled mid-flight. Wait for it to pause, or use \`habenula kill\` to stop everything.`,
      );
      return 1;
    case "resolving":
      console.log(
        `Task ${safeId} has a confirmation being resolved right now — its outcome is still being recorded. Try again in a moment.`,
      );
      return 1;
    case "not_cancellable":
      console.log(`Task ${safeId} is already ${result.currentStatus} — nothing to cancel.`);
      return 1;
    default: {
      // Unreachable while the client and the wire contract agree. Reached only on
      // contract drift, which must fail loudly rather than exit 0.
      const unexpected: never = result;
      console.log(`Unexpected cancel outcome: ${JSON.stringify(unexpected)}`);
      return 1;
    }
  }
}

/** One `watch` frame: the queue plus a one-line "waiting on you" nudge when a
 * confirmation is parked in the live slot. Pure over its inputs for testing. */
export function renderWatchFrame(
  status: StatusResponse,
  tasks: TaskSummary[],
  nextCursor: string | null,
  opts: { now: Date; depth: ColorDepth; width: number },
): string[] {
  const { now, depth, width } = opts;
  const stamp = now.toISOString().slice(11, 19);
  const rows: string[] = [colorize(`── tasks @ ${stamp} ──`, "muted", depth)];
  rows.push(...renderTaskList(tasks, nextCursor, { now, depth, width }));
  // One nudge line per parked confirmation, oldest first — every question
  // waiting on the user is visible in the frame, never just the first.
  for (const held of status.held) {
    const chrome = `${held.service} · ${held.verb}`;
    rows.push(
      `${colorize("▲ waiting for your approval:", "pending", depth)} ${colorize(chrome, "habenula", depth)} — send a message or start a chat to review it.`,
    );
  }
  return rows;
}

/** Injectable seams for `runTaskWatch`, so a test can drive ticks without a real
 * clock, signal, or sleep. The reads reuse the same poll seam the REPL uses
 * (`getStatus`) plus the task list — no new streaming surface. */
export interface TaskWatchOptions {
  depth?: ColorDepth;
  width?: number;
  intervalMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test bound: stop after this many frames (default: run until aborted). */
  maxTicks?: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // `{ once: true }` alone removes the listener only if `abort` FIRES. On the
    // normal timer path it would stay attached to the long-lived watch signal, so
    // one listener accumulated per tick — Node then prints
    // MaxListenersExceededWarning into the middle of the live view after ~11
    // ticks, and the set grows for the life of the watch. Remove it explicitly on
    // whichever path wins.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `habenula task watch` — a poll-based live view of the queue,
 * reusing the `GET /api/status` poll seam plus `GET /api/tasks`. No new
 * streaming infrastructure, consistent with this release's no-push constraint: it
 * re-renders every `intervalMs` until Ctrl-C (SIGINT). A test drives it with an
 * injected signal, sleep, and `maxTicks` instead of a real clock.
 */
export async function runTaskWatch(
  client: ApiClient,
  options: TaskWatchOptions = {},
): Promise<number> {
  const depth = options.depth ?? detectColorDepth();
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;

  // Standalone SIGINT ownership when no signal is injected: Ctrl-C aborts the
  // loop and hands the shell back cleanly (mirrors runConnectStandalone).
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const onSigint = (): void => controller?.abort();
  if (controller) process.on("SIGINT", onSigint);

  try {
    let ticks = 0;
    while (!signal.aborted) {
      const [status, list] = await Promise.all([client.getStatus(), client.listTasks()]);
      const lines = renderWatchFrame(status, list.tasks, list.nextCursor, {
        now: now(),
        depth,
        width: options.width ?? terminalWidth(),
      });
      for (const line of lines) console.log(line);
      ticks += 1;
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) break;
      if (signal.aborted) break;
      await sleep(intervalMs, signal);
    }
    return 0;
  } finally {
    if (controller) process.removeListener("SIGINT", onSigint);
  }
}
