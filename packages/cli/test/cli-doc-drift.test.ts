import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProgram, type CliRunners } from "../src/index";

// Guard: the public CLI reference must not drift from what the
// `habenula` binary actually registers. An earlier fix corrected a doc that had grown to
// document ~10 commands the binary never implemented; this locks it shut.
//
// The reference is the source of truth for users; Commander in src/index.ts is
// the source of truth for the binary. This test asserts the two agree on the
// *current* command surface, and that the surface fails the way the doc claims
// it does — see the error-behavior block for why names alone are not enough.

// NOTE: cross-package path. The CLI reference currently lives under
// engine/docs/, but per CLAUDE.md packages/cli/docs/ is a stub that "will split
// out of engine/docs." When that migration happens, move this path with it —
// otherwise the guard silently guards a stale copy or fails to find the doc.
const DOC_PATH = fileURLToPath(
  new URL(
    "../../engine/docs/public/guides/cli-reference.md",
    import.meta.url,
  ),
);

function readDoc(): string {
  try {
    return readFileSync(DOC_PATH, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new Error(
        `CLI reference not found at ${DOC_PATH} — did the doc move? ` +
          "See the DOC_PATH note (packages/cli/docs split).",
      );
    }
    throw err;
  }
}

function makeRunners(): CliRunners {
  const noop = async () => 0;
  return {
    chat: noop,
    up: noop,
    down: noop,
    connect: async () => 0,
    disconnect: async () => 0,
    status: noop,
    kill: noop,
    quit: noop,
    policyList: noop,
    cap: noop,
    taskList: noop,
    taskShow: async () => 0,
    taskCancel: async () => 0,
    taskWatch: noop,
    log: noop,
    logDump: async () => 0,
    logVerify: async () => 0,
  };
}

// Command groups that carry a runnable action of their own (a bare
// `habenula log` shows the newest page). The walk below never emits a group
// node, so without this set a documented `habenula log` row would read as a
// phantom; with it, an entry here that LOSES its action goes stale loudly via
// the routing test below rather than silently.
const ACTIONABLE_GROUPS = new Set(["log"]);

// Runnable leaf commands Commander registers, e.g. "policy list". Group nodes
// that carry no action of their own (like the `policy` parent) are not runnable
// and are not documented as their own row, so they are excluded. The bare
// `habenula` default action lives on the program itself, not in `.commands`, and
// is asserted separately below.
function registeredLeafCommands(): string[] {
  const program = createProgram(makeRunners());
  const leaves: string[] = [];
  const walk = (cmd: import("commander").Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const name = prefix ? `${prefix} ${sub.name()}` : sub.name();
      if (sub.commands.length === 0) {
        leaves.push(name);
      } else {
        // An actionable group is runnable bare AND has subcommands, so it is
        // documented as its own row and still recursed into.
        if (ACTIONABLE_GROUPS.has(name)) leaves.push(name);
        walk(sub, name);
      }
    }
  };
  walk(program, "");
  return leaves.sort();
}

// Command names documented in the current "## Commands" table only — the
// "## Planned (later)" section is intentionally allowed to name
// unregistered commands, so parsing stops at it. The `habenula ` prefix and
// argument tokens (`<service>`, `[service]`) are stripped; a bare `habenula`
// row maps to the default action.
function documentedCurrentCommands(): { bare: boolean; leaves: string[] } {
  const md = readDoc();
  const start = md.indexOf("## Commands");
  if (start === -1) throw new Error("cli-reference.md: '## Commands' not found");
  const planned = md.indexOf("## Planned", start);
  const section = md.slice(start, planned === -1 ? undefined : planned);

  let bare = false;
  const leaves: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`/);
    if (!m?.[1]) continue;
    const cmd = m[1]
      .replace(/^habenula\b/, "")
      .replace(/<[^>]+>|\[[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cmd === "") bare = true;
    else leaves.push(cmd);
  }
  return { bare, leaves: leaves.sort() };
}

async function runExpectingError(
  argv: string[],
): Promise<{ code?: string; exitCode?: number; stderr: string }> {
  const program = createProgram(makeRunners());
  let stderr = "";
  // exitOverride() and configureOutput() are per-command — set on the root they
  // do NOT reach subcommand instances, so an error raised inside a subcommand
  // (e.g. `policy edit`) would otherwise escape to the real stderr and call
  // process.exit. Apply both to every command in the tree.
  const configure = (cmd: import("commander").Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: (s) => (stderr += s) });
    for (const sub of cmd.commands) configure(sub);
  };
  configure(program);
  try {
    await program.parseAsync(argv, { from: "user" });
    return { stderr };
  } catch (err) {
    const e = err as { code?: string; exitCode?: number };
    return { code: e.code, exitCode: e.exitCode, stderr };
  }
}

describe("CLI reference drift guard", () => {
  it("documents exactly the commands Commander registers — no phantoms, no gaps", () => {
    // Fails in both directions: a documented-but-unregistered command (drift
    // back to phantoms) or a registered-but-undocumented command (a real
    // command missing from the reference).
    expect(documentedCurrentCommands().leaves).toEqual(registeredLeafCommands());
  });

  it("documents the bare `habenula` default command", () => {
    expect(documentedCurrentCommands().bare).toBe(true);
  });

  it("routes a bare invocation to the default (chat) action", async () => {
    const calls: string[] = [];
    const runners = { ...makeRunners(), chat: async () => (calls.push("chat"), 0) };
    const program = createProgram(runners);
    await program.parseAsync([], { from: "user" });
    expect(calls).toEqual(["chat"]);
  });

  // Error-behavior guard — the load-bearing half a name-only check misses.
  // The doc tells users an unimplemented command "fails with an error". That is
  // only true because Commander v13+ errors on excess arguments by default;
  // combined with the program-level default action, a bare planned command
  // (`log`, `digest`, …) is an excess argument to the default action. On any
  // downgrade below v13 those would SILENTLY start the chat REPL instead. Assert
  // the real exit code + message so that regression cannot land quietly.
  // The `commander.excessArguments` / `commander.unknownCommand` codes and the
  // literal message substrings below are load-bearing: a Commander major could
  // rename a code or reword a message and turn this suite red with zero real doc
  // drift. That is acceptable because deps are pinned exactly, so a
  // Commander bump is a deliberate, reviewed event — the upgrader owns updating
  // these strings.
  it("errors (not silent REPL) on a bare planned command", async () => {
    // `digest`, not `log`: `log` is registered now, so it would pass this
    // test for the wrong reason (routing to a real command, not erroring).
    const r = await runExpectingError(["digest"]);
    expect(r.code).toBe("commander.excessArguments");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/too many arguments/);
  });

  it("routes a bare `log` to the log runner — the actionable-group set's other half", async () => {
    const calls: string[] = [];
    const runners = { ...makeRunners(), log: async () => (calls.push("log"), 0) };
    const program = createProgram(runners);
    await program.parseAsync(["log"], { from: "user" });
    expect(calls).toEqual(["log"]);
  });

  it("errors with 'unknown command' on an unregistered subcommand", async () => {
    const r = await runExpectingError(["policy", "edit"]);
    expect(r.code).toBe("commander.unknownCommand");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown command/);
  });
});
