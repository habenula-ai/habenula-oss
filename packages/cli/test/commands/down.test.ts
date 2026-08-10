import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../../src/api-client";
import { runDown, type DownDeps } from "../../src/commands/down";
import { runUp, type UpDeps } from "../../src/commands/up";
import { resolveEnginePaths, type EnginePaths } from "../../src/engine/paths";
import { readRunRecord, writeRunRecord, type RunRecord } from "../../src/engine/run-record";

/**
 * runDown end to end: all six ownership-proof kinds. The proof-holds path
 * stops a real stub engine started through the real runUp; the refusal rows
 * use injected kill/fetch so no test ever signals a process it should not.
 */
const testDir = dirname(fileURLToPath(import.meta.url));
const STUB = join(testDir, "..", "fixtures", "stub-engine.mjs");

let nextPort = 43_331;
function freshPort(): number {
  return nextPort++;
}

const tempRoots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const strayChildren: ChildProcess[] = [];

// Cleanup sweeps only the children this suite spawned — never a recorded pid,
// because several tests deliberately record process.pid (the vitest worker)
// as an alive-and-ours pid, and a record-based sweep would SIGKILL the worker.
afterEach(() => {
  for (const child of strayChildren.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeDeps(root: string, overrides?: Partial<DownDeps>) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DownDeps = {
    env: { HABENULA_PERSIST_ROOT: root },
    kill: (pid, signal) => process.kill(pid, signal),
    fetchFn: fetch as unknown as FetchFn,
    now: () => Date.now(),
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    bounds: {
      termWaitMs: 5_000,
      postKillProbeMs: 2_000,
      pollMs: 40,
      probeTimeoutMs: 500,
      staleRecordMs: 10_000,
    },
    ...overrides,
  };
  return { deps, out, err };
}

function paths(root: string): EnginePaths {
  return resolveEnginePaths({ HABENULA_PERSIST_ROOT: root });
}

function record(root: string, extra?: Partial<RunRecord>): RunRecord {
  const p = paths(root);
  return {
    port: freshPort(),
    url: "http://localhost:0",
    startedAt: Date.now(),
    logPath: p.logPath,
    ...extra,
  };
}

/** A kill stub that records calls and answers by pid. */
function recordingKill(alive: Set<number>) {
  const calls: [number, number | string][] = [];
  const kill = (pid: number, signal: number | string): void => {
    calls.push([pid, signal]);
    if (signal === 0 && !alive.has(pid)) {
      const err = new Error("ESRCH") as Error & { code: string };
      err.code = "ESRCH";
      throw err;
    }
  };
  return { kill, calls };
}

/** A fetch that always answers as a healthy engine (the port never refuses). */
const engineForeverFetch: FetchFn = async () =>
  new Response(JSON.stringify({ status: "ok", engine: "habenula-engine" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

async function startRealEngine(root: string, port: number): Promise<void> {
  const upDeps: UpDeps = {
    env: {
      PATH: process.env.PATH,
      HABENULA_PERSIST_ROOT: root,
      HABENULA_ENGINE_CMD: `${process.execPath} ${STUB}`,
    },
    cwd: () => tempDir("hbn-down-cwd-"),
    nodePath: process.execPath,
    spawn: (cmd, args, options) => {
      const child = spawn(cmd, args, options);
      strayChildren.push(child);
      return child;
    },
    kill: (pid, signal) => process.kill(pid, signal),
    fetchFn: fetch as unknown as FetchFn,
    now: () => Date.now(),
    write: () => {},
    writeErr: (line) => {
      throw new Error(`up refused during down-test setup: ${line}`);
    },
    bounds: {
      readyBoundNpxMs: 10_000,
      readyBoundLocalMs: 10_000,
      pollMs: 40,
      probeTimeoutMs: 500,
      progressAfterMs: 60_000,
      progressEveryMs: 60_000,
      staleRecordMs: 10_000,
    },
    scanPorts: [port],
  };
  const code = await runUp(upDeps);
  if (code !== 0) throw new Error(`up exited ${code} during down-test setup`);
}

describe("runDown — the proof holds", () => {
  it("SIGTERMs the engine it started, removes the record, and states what stopping is not", async () => {
    const port = freshPort();
    const root = tempDir("hbn-down-");
    await startRealEngine(root, port);
    const p = paths(root);
    expect(readRunRecord(p)?.pid).toBeDefined();

    const { deps, out } = makeDeps(root);
    const code = await runDown(deps);

    expect(code).toBe(0);
    expect(out).toEqual([
      `Engine stopped. Your state is kept in ${root}.`,
      "This did not end your session or clear grants.",
    ]);
    expect(readRunRecord(p)).toBeNull();
    // Nothing left answering on the port.
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it("stopping twice is idempotent: the second down reports nothing to stop and exits 0", async () => {
    const port = freshPort();
    const root = tempDir("hbn-down-");
    await startRealEngine(root, port);
    expect(await runDown(makeDeps(root).deps)).toBe(0);

    const { deps, out } = makeDeps(root);
    expect(await runDown(deps)).toBe(0);
    expect(out.join("\n")).toContain("No engine to stop");
  });
});

describe("runDown — records that are not a running engine", () => {
  it("no record: exit 0, nothing was running", async () => {
    const root = tempDir("hbn-down-");
    const { deps, out } = makeDeps(root);
    expect(await runDown(deps)).toBe(0);
    expect(out.join("\n")).toContain("No engine to stop");
  });

  it("a stale record (dead pid) is removed and reads as nothing running", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    writeRunRecord(p, record(root, { pid: 99_999_991, pgid: 99_999_991 }));
    const { kill, calls } = recordingKill(new Set());
    const { deps, out } = makeDeps(root, { kill });

    expect(await runDown(deps)).toBe(0);
    expect(out.join("\n")).toContain("No engine to stop");
    expect(readRunRecord(p)).toBeNull();
    // The only signal sent was the pid-0 probe.
    expect(calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("an unparseable record is removed and reads as nothing running", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    writeFileSync(p.recordPath, '{"port": 87');
    const { deps, out } = makeDeps(root);

    expect(await runDown(deps)).toBe(0);
    expect(out.join("\n")).toContain("No engine to stop");
    expect(existsSync(p.recordPath)).toBe(false);
  });

  it("claim-pending: refuses, keeps the record, and signals nothing", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    writeRunRecord(p, record(root)); // no pid, fresh startedAt
    const { kill, calls } = recordingKill(new Set());
    const { deps, err } = makeDeps(root, { kill });

    expect(await runDown(deps)).toBe(1);
    expect(err.join("\n")).toContain("another habenula up is starting the engine");
    expect(err.join("\n")).toContain("habenula down again once it finishes");
    expect(existsSync(p.recordPath)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("runDown — the proof fails", () => {
  it("pid alive, port silent, engine had served: names the daemon's own exit clock", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    // Our own test process: alive and ours, provably not answering the port.
    const rec = record(root, { pid: process.pid, pgid: process.pid, servedAt: Date.now() });
    writeRunRecord(p, rec);
    const { deps, err } = makeDeps(root);

    expect(await runDown(deps)).toBe(1);
    const text = err.join("\n");
    expect(text).toContain(`pid ${process.pid} is alive but nothing is answering on port ${rec.port}`);
    expect(text).toContain("will not signal it");
    expect(text).toContain("exits on its own within about a minute");
    expect(existsSync(p.recordPath)).toBe(true);
  });

  it("pid alive, port silent, never served: points at the log instead of inventing a clock", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    const rec = record(root, { pid: process.pid, pgid: process.pid });
    writeRunRecord(p, rec);
    const { deps, err } = makeDeps(root);

    expect(await runDown(deps)).toBe(1);
    const text = err.join("\n");
    expect(text).toContain(`never answered on port ${rec.port}`);
    expect(text).toContain(rec.logPath);
    expect(text).not.toContain("about a minute");
  });

  it("foreign: an engine on the recorded port that is not ours is never signalled", async () => {
    const port = freshPort();
    const root = tempDir("hbn-down-");
    const p = paths(root);
    writeRunRecord(p, record(root, { port, pid: 99_999_992 }));
    // A live engine on the port, a dead recorded pid: proof fails as foreign.
    const child = spawn(process.execPath, [STUB], {
      stdio: "ignore",
      env: { ...process.env, HABENULA_PORT: String(port) },
      detached: false,
      shell: false,
    });
    strayChildren.push(child);
    for (let i = 0; i < 200; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) break;
      } catch {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    const { kill, calls } = recordingKill(new Set());
    const { deps, err } = makeDeps(root, { kill });

    expect(await runDown(deps)).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("not one this CLI started");
    expect(text).toContain("docker compose down");
    expect(existsSync(p.recordPath)).toBe(true);
    // No signal beyond the pid-0 probe, and the engine is still serving.
    expect(calls.filter(([, s]) => s !== 0)).toEqual([]);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("runDown — escalation", () => {
  it("escalates to the NEGATED group id after the SIGTERM wait, and reports still-answering honestly", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    const rec = record(root, { pid: 5_001, pgid: 5_001, servedAt: Date.now() });
    writeRunRecord(p, rec);
    const { kill, calls } = recordingKill(new Set([5_001]));
    const { deps, err } = makeDeps(root, {
      kill,
      // The port answers as an engine forever: SIGTERM appears to do nothing,
      // and the post-kill probe still answers.
      fetchFn: engineForeverFetch,
      bounds: {
        termWaitMs: 150,
        postKillProbeMs: 150,
        pollMs: 20,
        probeTimeoutMs: 100,
        staleRecordMs: 10_000,
      },
    });

    expect(await runDown(deps)).toBe(1);
    expect(calls).toContainEqual([5_001, "SIGTERM"]);
    // The escalation targets the process group, not the pid.
    expect(calls).toContainEqual([-5_001, "SIGKILL"]);
    // Still answering: reported as such, record kept — the one thing worse
    // than a stuck engine is being told it is gone.
    expect(err.join("\n")).toContain("still answering");
    expect(existsSync(p.recordPath)).toBe(true);
  });

  it("a record with no pgid refuses to escalate rather than falling back to the pid", async () => {
    const root = tempDir("hbn-down-");
    const p = paths(root);
    writeRunRecord(p, record(root, { pid: 5_002, servedAt: Date.now() }));
    const { kill, calls } = recordingKill(new Set([5_002]));
    const { deps, err } = makeDeps(root, {
      kill,
      fetchFn: engineForeverFetch,
      bounds: {
        termWaitMs: 150,
        postKillProbeMs: 150,
        pollMs: 20,
        probeTimeoutMs: 100,
        staleRecordMs: 10_000,
      },
    });

    expect(await runDown(deps)).toBe(1);
    expect(calls).toContainEqual([5_002, "SIGTERM"]);
    // No SIGKILL was sent to anything — not the pid, and no negated group.
    expect(calls.some(([, signal]) => signal === "SIGKILL")).toBe(false);
    expect(err.join("\n")).toContain("no process group");
  });
});
