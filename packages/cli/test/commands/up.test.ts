import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "../../src/api-client";
import { runUp, type UpDeps } from "../../src/commands/up";
import { readConfigFile } from "../../src/engine/config-file";
import { resolveEnginePaths, type EnginePaths } from "../../src/engine/paths";
import { readRunRecord, writeRunRecord } from "../../src/engine/run-record";
import { validateCredentialKey } from "../../../engine/src/credential-guard";

/**
 * Command-level tier: runUp end to end against the stub engine, on the real
 * filesystem in mkdtempSync roots, with a real (counted) spawn. The injected
 * env is load-bearing for safety — HABENULA_PERSIST_ROOT is always a temp
 * root, so no test can rotate a developer's live engine state.
 */
const testDir = dirname(fileURLToPath(import.meta.url));
const STUB = join(testDir, "..", "fixtures", "stub-engine.mjs");

// Each test takes fresh high ports so parallel test files and a developer's
// real engine on 8787 can never collide with the suite.
let nextPort = 42_431;
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
const strayServers: { close(): void }[] = [];

afterEach(async () => {
  for (const child of strayChildren.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const server of strayServers.splice(0)) server.close();
  // Sweep any daemon a test left recorded (the exit-2 cases). Never the test
  // process itself, in case a future test records process.pid as "ours".
  for (const root of tempRoots) {
    const record = safeRecord(root);
    if (record?.pid !== undefined && record.pid !== process.pid) {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function safeRecord(root: string) {
  try {
    return readRunRecord(resolveEnginePaths({ HABENULA_PERSIST_ROOT: root }));
  } catch {
    return null;
  }
}

interface Harness {
  root: string;
  paths: EnginePaths;
  deps: UpDeps;
  out: string[];
  err: string[];
  spawnCount: () => number;
  allOutput: () => string;
}

function makeHarness(opts?: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  scanPorts?: number[];
  root?: string;
}): Harness {
  const root = opts?.root ?? tempDir("hbn-up-");
  const paths = resolveEnginePaths({ HABENULA_PERSIST_ROOT: root });
  const out: string[] = [];
  const err: string[] = [];
  let spawns = 0;
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HABENULA_PERSIST_ROOT: root,
    HABENULA_ENGINE_CMD: `${process.execPath} ${STUB}`,
    ...opts?.env,
  };
  const deps: UpDeps = {
    env,
    cwd: () => opts?.cwd ?? tempDir("hbn-cwd-"),
    nodePath: process.execPath,
    spawn: (cmd, args, options) => {
      spawns += 1;
      const child = spawn(cmd, args, options);
      strayChildren.push(child);
      return child;
    },
    kill: (pid, signal) => process.kill(pid, signal),
    fetchFn: fetch as unknown as FetchFn,
    now: () => Date.now(),
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    bounds: {
      readyBoundNpxMs: 10_000,
      readyBoundLocalMs: 10_000,
      pollMs: 40,
      probeTimeoutMs: 500,
      progressAfterMs: 60_000,
      progressEveryMs: 60_000,
      staleRecordMs: 10_000,
    },
    ...(opts?.scanPorts !== undefined ? { scanPorts: opts.scanPorts } : {}),
  };
  return {
    root,
    paths,
    deps,
    out,
    err,
    spawnCount: () => spawns,
    allOutput: () => [...out, ...err].join("\n"),
  };
}

/** A listener that is not an engine: answers 200 with a non-matching body. */
function junkServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not an engine</html>");
    });
    strayServers.push(server);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

/** Start a foreign stub engine the test owns (not spawned through runUp). */
function foreignStub(port: number, extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STUB], {
      stdio: "ignore",
      env: {
        ...process.env,
        HABENULA_PORT: String(port),
        ...extraEnv,
      },
      detached: false,
      shell: false,
    });
    strayChildren.push(child);
    // Poll the port rather than parsing stdout.
    const started = Date.now();
    const tryProbe = async (): Promise<void> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - started > 10_000) return reject(new Error("stub never served"));
      setTimeout(() => void tryProbe(), 40);
    };
    void tryProbe();
  });
}

describe("runUp — first run on a clean root", () => {
  it("generates, starts, records, and reports — with both pinned notices", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });

    const code = await runUp(h.deps);

    expect(h.err).toEqual([]);
    expect(code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(`No config found. Generated your engine secrets → ${h.paths.configPath}`);
    expect(text).toContain("Back this file up");
    expect(text).toContain(`Engine ready at http://localhost:${port}`);
    // The origin notice: a non-default port names the origin to register.
    expect(text).toContain(`This engine's OAuth origin is http://localhost:${port}`);
    expect(text).toContain("Register callback URLs against the origin above.");
    // The model-key notice names the variable and the file, and stays exit 0.
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain(h.paths.configPath);
    expect(text).toContain(`Logs: ${h.paths.logPath}`);

    const config = readConfigFile(h.paths.configPath);
    expect(config).not.toBeNull();
    expect(validateCredentialKey(config!.CREDENTIAL_ENCRYPTION_KEY)).toBeNull();
    expect(config!.INTERNAL_MCP_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(config!.HABENULA_PORT).toBe(String(port));
    // The recorded origin reads localhost even though every probe dialled 127.0.0.1.
    expect(config!.OAUTH_REDIRECT_BASE_URL).toBe(`http://localhost:${port}`);
    expect(statSync(h.paths.configPath).mode & 0o777).toBe(0o600);

    const record = readRunRecord(h.paths);
    expect(record?.pid).toBeDefined();
    expect(record?.pgid).toBe(record?.pid);
    expect(record?.servedAt).toBeDefined();
    expect(record?.url).toBe(`http://localhost:${port}`);
    expect(statSync(h.paths.logPath).mode & 0o777).toBe(0o600);

    // No secret is printed: the generated key's characters appear in no line
    // either stream carried.
    expect(h.allOutput()).not.toContain(config!.CREDENTIAL_ENCRYPTION_KEY!);
    expect(h.allOutput()).not.toContain(config!.INTERNAL_MCP_TOKEN!);
  });

  it("a second up is idempotent: reports already running, spawns nothing, rotates nothing", async () => {
    const port = freshPort();
    const first = makeHarness({ scanPorts: [port] });
    expect(await runUp(first.deps)).toBe(0);
    const configBefore = readFileSync(first.paths.configPath, "utf8");

    const second = makeHarness({ root: first.root, scanPorts: [port] });
    const code = await runUp(second.deps);

    expect(code).toBe(0);
    expect(second.spawnCount()).toBe(0);
    const record = readRunRecord(first.paths);
    expect(second.out.join("\n")).toContain(
      `Engine already running at http://localhost:${port} (pid ${record?.pid})`,
    );
    // A run that starts nothing leaves every log generation untouched.
    expect(existsSync(first.paths.rotatedLogPaths[0])).toBe(false);
    expect(readFileSync(first.paths.configPath, "utf8")).toBe(configBefore);
  });

  it("two racing runs end with one daemon and one key", async () => {
    const port = freshPort();
    const root = tempDir("hbn-race-");
    const a = makeHarness({ root, scanPorts: [port] });
    const b = makeHarness({ root, scanPorts: [port] });

    const [codeA, codeB] = await Promise.all([runUp(a.deps), runUp(b.deps)]);

    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    // One spawned daemon out of two racing runs — the loser took the
    // already-running branch on a claim it did not win.
    expect(a.spawnCount() + b.spawnCount()).toBe(1);
    // And one generated key.
    const config = readConfigFile(a.paths.configPath);
    expect(validateCredentialKey(config!.CREDENTIAL_ENCRYPTION_KEY)).toBeNull();
  });
});

describe("runUp — a blank assignment is not a decision", () => {
  it("blank secrets and a blank API URL fall through to the file and the local engine", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({
      scanPorts: [port],
      env: {
        STUB_ENV_FILE: dump,
        // Every one of these would be read as a stated value under a plain
        // `?? ` / `!== undefined` test: the URL would reach new URL("") and
        // refuse, the key would skip generation and boot the daemon under "",
        // and the file's model key would be shadowed by nothing at all.
        HABENULA_API_URL: "",
        CREDENTIAL_ENCRYPTION_KEY: "",
        INTERNAL_MCP_TOKEN: "  ",
        ANTHROPIC_API_KEY: "",
        OAUTH_REDIRECT_BASE_URL: "",
      },
    });
    writeFileSync(h.paths.configPath, "ANTHROPIC_API_KEY=sk-from-file\n");

    const code = await runUp(h.deps);

    expect(h.err).toEqual([]);
    expect(code).toBe(0);

    // Generation ran: the file holds a real key and token, not empty strings.
    const config = readConfigFile(h.paths.configPath);
    expect(validateCredentialKey(config!.CREDENTIAL_ENCRYPTION_KEY)).toBeNull();
    expect(config!.INTERNAL_MCP_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    // A blank redirect base is unset, so the derived one is recorded.
    expect(config!.OAUTH_REDIRECT_BASE_URL).toBe(`http://localhost:${port}`);

    // The child got the generated values, and the file's model key survived a
    // blank export of the same name.
    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(childEnv.CREDENTIAL_ENCRYPTION_KEY).toBe(config!.CREDENTIAL_ENCRYPTION_KEY);
    expect(childEnv.INTERNAL_MCP_TOKEN).toBe(config!.INTERNAL_MCP_TOKEN);
    expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-from-file");
    // And the notice reads the file, not the blank export.
    expect(h.out.join("\n")).not.toContain("No model key");
  });

  it("a blank drive token in the environment does not shadow the file's on a found engine", async () => {
    const port = freshPort();
    const token = "f".repeat(32);
    await foreignStub(port, { INTERNAL_MCP_TOKEN: token });

    const h = makeHarness({
      scanPorts: [port],
      env: { HABENULA_INTERNAL_MCP_TOKEN: "" },
    });
    writeFileSync(h.paths.configPath, `INTERNAL_MCP_TOKEN=${token}\n`);

    const code = await runUp(h.deps);

    expect(code).toBe(0);
    expect(h.out.join("\n")).toContain("did not start it");
  });
});

describe("runUp — found engines", () => {
  it("a scan that meets an engine classifies it instead of starting a second one", async () => {
    const port = freshPort();
    const token = "f".repeat(32);
    await foreignStub(port, { INTERNAL_MCP_TOKEN: token });

    const h = makeHarness({ scanPorts: [port, freshPort()] });
    writeFileSync(h.paths.configPath, `INTERNAL_MCP_TOKEN=${token}\n`);

    const code = await runUp(h.deps);

    expect(code).toBe(0);
    expect(h.spawnCount()).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(`An engine is already serving http://localhost:${port}`);
    expect(text).toContain("did not start it");
    // A foreign engine that answers the drive token records its port, and
    // only its port — the redirect base belongs to whoever runs it.
    const config = readConfigFile(h.paths.configPath);
    expect(config!.HABENULA_PORT).toBe(String(port));
    expect(config!.OAUTH_REDIRECT_BASE_URL).toBeUndefined();
  });

  it("a foreign engine that rejects the drive token exits 1 and records nothing", async () => {
    const port = freshPort();
    await foreignStub(port, { INTERNAL_MCP_TOKEN: "a".repeat(32) });

    const h = makeHarness({ scanPorts: [port] });
    writeFileSync(h.paths.configPath, `INTERNAL_MCP_TOKEN=${"b".repeat(32)}\n`);
    const configBefore = readFileSync(h.paths.configPath, "utf8");

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.spawnCount()).toBe(0);
    const text = h.err.join("\n");
    expect(text).toContain("did not start it");
    expect(text).toContain("rejected");
    expect(text).toContain("HABENULA_INTERNAL_MCP_TOKEN");
    // Nothing recorded: no port line appears, no run record exists.
    expect(readFileSync(h.paths.configPath, "utf8")).toBe(configBefore);
    expect(readRunRecord(h.paths)).toBeNull();
  });

  it("an owned engine whose token drifted exits 1 on the owned row too", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    expect(await runUp(h.deps)).toBe(0);

    // Edit the token under the running engine: every part of the ownership
    // proof still passes while nothing the CLI sends is accepted.
    const config = readFileSync(h.paths.configPath, "utf8").replace(
      /INTERNAL_MCP_TOKEN=.*/,
      `INTERNAL_MCP_TOKEN=${"0".repeat(32)}`,
    );
    writeFileSync(h.paths.configPath, config);

    const again = makeHarness({ root: h.root, scanPorts: [port] });
    const code = await runUp(again.deps);

    expect(code).toBe(1);
    const text = again.err.join("\n");
    expect(text).toContain("this CLI started");
    expect(text).toContain("habenula down");
  });
});

describe("runUp — refusals that leave the disk untouched", () => {
  it("refuses an unrelated listener on a told port and touches nothing", async () => {
    const port = freshPort();
    await junkServer(port);
    const h = makeHarness({ env: { HABENULA_PORT: String(port) } });

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain(`not a habenula engine is listening on port ${port}`);
    expect(readdirSync(h.root)).toEqual([]);
  });

  it("never relocates off a busy recorded port", async () => {
    const port = freshPort();
    await junkServer(port);
    const h = makeHarness({ scanPorts: [freshPort()] });
    writeFileSync(h.paths.configPath, `HABENULA_PORT=${port}\n`);

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.spawnCount()).toBe(0);
    expect(h.err.join("\n")).toContain(h.paths.configPath);
  });

  it("refuses a non-loopback HABENULA_API_URL before any probe, on a clean root", async () => {
    const h = makeHarness({ env: { HABENULA_API_URL: "https://engine.example.com" } });
    const code = await runUp(h.deps);
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("somewhere else");
    expect(readdirSync(h.root)).toEqual([]);
  });

  it("refuses a loopback HABENULA_API_URL whose port differs from the RESOLVED one, on a clean root", async () => {
    // First failure of the design's §1, reproduced by the check that prevents
    // it: nothing recorded, HABENULA_API_URL=9000, scan would land elsewhere.
    const port = freshPort();
    const h = makeHarness({
      env: { HABENULA_API_URL: "http://localhost:9000" },
      scanPorts: [port],
    });
    const code = await runUp(h.deps);
    expect(code).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("http://localhost:9000");
    expect(text).toContain(String(port));
    expect(text).toContain(`http://localhost:${port}`);
    expect(readdirSync(h.root)).toEqual([]);
  });

  it("a matching loopback HABENULA_API_URL is no conflict at all", async () => {
    const port = freshPort();
    const h = makeHarness({
      env: { HABENULA_API_URL: `http://localhost:${port}` },
      scanPorts: [port],
    });
    expect(await runUp(h.deps)).toBe(0);
  });

  it("guard 3: a store with no recorded key refuses after the claim and removes the slot", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    mkdirSync(join(h.root, "do"), { recursive: true });
    writeFileSync(h.paths.configPath, `HABENULA_PORT=${port}\n`);
    const configBefore = readFileSync(h.paths.configPath, "utf8");

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("holds engine state, and no encryption key");
    expect(readFileSync(h.paths.configPath, "utf8")).toBe(configBefore);
    expect(readRunRecord(h.paths)).toBeNull();
    expect(h.spawnCount()).toBe(0);
  });

  it("a store with state and no recorded port refuses selection outright", async () => {
    const h = makeHarness({ scanPorts: [freshPort()] });
    mkdirSync(join(h.root, "do"), { recursive: true });

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("no port is recorded");
    expect(existsSync(h.paths.configPath)).toBe(false);
  });

  it("guard 4: a working-directory .env declaring the key refuses and writes no key", async () => {
    const port = freshPort();
    const cwd = tempDir("hbn-clone-");
    writeFileSync(join(cwd, ".env"), `CREDENTIAL_ENCRYPTION_KEY=${"e".repeat(64)}\n`);
    const h = makeHarness({ scanPorts: [port], cwd });

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("./.env declares CREDENTIAL_ENCRYPTION_KEY");
    expect(existsSync(h.paths.configPath)).toBe(false);
    expect(readRunRecord(h.paths)).toBeNull();
  });
});

describe("runUp — the spawn's failure modes", () => {
  it("a child that refuses prints its line verbatim, names the code, removes the record, records no port", async () => {
    const port = freshPort();
    const refusalLine =
      "CREDENTIAL_ENCRYPTION_KEY is the publicly known dev placeholder. The engine refuses to encrypt real credentials under it.";
    const h = makeHarness({
      scanPorts: [port],
      env: { STUB_MODE: "refuse", STUB_REFUSAL_LINE: refusalLine },
    });

    const code = await runUp(h.deps);

    expect(code).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain(refusalLine);
    expect(text).toContain("exited with code 1");
    expect(readRunRecord(h.paths)).toBeNull();
    // A spawn that fails records no port — the config holds only the secrets
    // (the normal intermediate state a failed spawn leaves).
    const config = readConfigFile(h.paths.configPath);
    expect(config!.HABENULA_PORT).toBeUndefined();
    expect(config!.CREDENTIAL_ENCRYPTION_KEY).toBeDefined();
  });

  it("the readiness bound elapsing exits 2 and leaves the record and daemon alone", async () => {
    const port = freshPort();
    const h = makeHarness({
      scanPorts: [port],
      env: { STUB_MODE: "never-bind" },
    });
    h.deps.bounds = { ...h.deps.bounds, readyBoundLocalMs: 800, readyBoundNpxMs: 800 };

    const code = await runUp(h.deps);

    expect(code).toBe(2);
    const text = h.err.join("\n");
    expect(text).toContain("not answering yet");
    expect(text).toContain("habenula down");
    expect(text).toContain(h.paths.logPath);
    expect(readRunRecord(h.paths)?.pid).toBeDefined();
  });
});

describe("runUp — the child's environment", () => {
  it("forwards the whole config file, keeps env-over-file precedence, and sets the resolved values", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({
      scanPorts: [port],
      env: { STUB_ENV_FILE: dump, SHARED_NAME: "from-env" },
    });
    writeFileSync(
      h.paths.configPath,
      [
        "MY_CONFIG_VALUE=reaches-the-child",
        "SHARED_NAME=from-file",
        "ANTHROPIC_API_KEY=sk-from-file",
        `INTERNAL_MCP_TOKEN=${"a".repeat(32)}`,
        `CREDENTIAL_ENCRYPTION_KEY=${"c".repeat(64)}`,
      ].join("\n") + "\n",
    );

    const code = await runUp(h.deps);
    expect(code).toBe(0);

    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    // A variable the user added to the config reaches the child.
    expect(childEnv.MY_CONFIG_VALUE).toBe("reaches-the-child");
    // An export wins over the file.
    expect(childEnv.SHARED_NAME).toBe("from-env");
    // The resolved values land last.
    expect(childEnv.HABENULA_PORT).toBe(String(port));
    expect(childEnv.HABENULA_PERSIST_ROOT).toBe(h.root);
    expect(childEnv.OAUTH_REDIRECT_BASE_URL).toBe(`http://localhost:${port}`);
    expect(childEnv.CREDENTIAL_ENCRYPTION_KEY).toBe("c".repeat(64));
    // With a model key in the file, the notice does not fire.
    expect(h.out.join("\n")).not.toContain("No model key");
  });

  it("honours an environment redirect base for the run and never records it", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({
      scanPorts: [port],
      env: { STUB_ENV_FILE: dump, OAUTH_REDIRECT_BASE_URL: "https://tunnel.example" },
    });

    expect(await runUp(h.deps)).toBe(0);

    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(childEnv.OAUTH_REDIRECT_BASE_URL).toBe("https://tunnel.example");
    const config = readConfigFile(h.paths.configPath);
    expect(config!.OAUTH_REDIRECT_BASE_URL).toBeUndefined();
    expect(config!.HABENULA_PORT).toBe(String(port));
  });
});

describe("runUp — stale and malformed records", () => {
  it("an unparseable record reads as stale: up removes it and proceeds", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    mkdirSync(h.root, { recursive: true });
    writeFileSync(h.paths.recordPath, '{"port": 87');

    expect(await runUp(h.deps)).toBe(0);
    expect(readRunRecord(h.paths)?.servedAt).toBeDefined();
  });

  it("losing the retry to a live claim waits on it instead of calling it corruption", async () => {
    // Two `up` runs starting together over one stale record both read it
    // stale, both remove it, and both retry — so the loser of the retry is
    // colliding with a claim that is fresh and live. The window is the one
    // between our removal and our create, and `now` is the last thing called
    // inside it, so the interloper is written from there rather than raced for.
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    h.deps.bounds = { ...h.deps.bounds, readyBoundNpxMs: 600, readyBoundLocalMs: 600 };
    mkdirSync(h.root, { recursive: true });
    writeRunRecord(h.paths, {
      port,
      url: `http://localhost:${port}`,
      startedAt: Date.now() - 1_000_000,
      logPath: h.paths.logPath,
      pid: 99_999_999,
    });
    h.deps.kill = (pid, signal) => {
      if (pid === 99_999_999) {
        const err = new Error("ESRCH") as Error & { code: string };
        err.code = "ESRCH";
        throw err;
      }
      process.kill(pid, signal);
    };
    let nowCalls = 0;
    h.deps.now = () => {
      nowCalls += 1;
      // Call 1 is the first claim's startedAt; call 2 is the retry's, written
      // just before its exclusive create.
      if (nowCalls === 2) {
        writeRunRecord(h.paths, {
          port,
          url: `http://localhost:${port}`,
          startedAt: Date.now(),
          logPath: h.paths.logPath,
        });
      }
      return Date.now();
    };

    const code = await runUp(h.deps);

    // The other run's daemon never answered, so this is the ordinary
    // not-answering-yet outcome — not a corruption refusal, and not exit 1.
    expect(code).toBe(2);
    expect(h.spawnCount()).toBe(0);
    expect(h.err.join("\n")).toContain("not answering yet");
    expect(h.allOutput()).not.toContain("keeps recreating");
  });

  it("a record with a dead pid is reclaimed exactly once and the start proceeds", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    mkdirSync(h.root, { recursive: true });
    writeRunRecord(h.paths, {
      port,
      url: `http://localhost:${port}`,
      startedAt: Date.now() - 1_000_000,
      logPath: h.paths.logPath,
      pid: 99_999_999,
    });
    h.deps.kill = (pid, signal) => {
      if (pid === 99_999_999) {
        const err = new Error("ESRCH") as Error & { code: string };
        err.code = "ESRCH";
        throw err;
      }
      process.kill(pid, signal);
    };

    expect(await runUp(h.deps)).toBe(0);
    expect(h.spawnCount()).toBe(1);
  });
});

describe("runUp — --visual-model", () => {
  it("sets the gate on the spawned engine, reports the page, and records nothing", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({ scanPorts: [port], env: { STUB_ENV_FILE: dump } });

    const code = await runUp(h.deps, { visualModel: true });

    expect(h.err).toEqual([]);
    expect(code).toBe(0);
    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(childEnv.VISUAL_MODEL).toBe("true");

    const text = h.out.join("\n");
    expect(text).toContain(
      `Visual model at http://localhost:${port}/dev/model?userId=cli-user`,
    );
    // The invitation carries its own caveat rather than deferring to a doc.
    expect(text).toContain("Read-only");
    expect(text).toContain("unauthenticated on loopback");

    // The flag is a property of this run, not of the persist root: the port is
    // recorded, the gate is not.
    const config = readConfigFile(h.paths.configPath);
    expect(config!.HABENULA_PORT).toBe(String(port));
    expect(config!.VISUAL_MODEL).toBeUndefined();
  });

  it("a bare up neither sets the gate nor mentions the page", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({ scanPorts: [port], env: { STUB_ENV_FILE: dump } });

    expect(await runUp(h.deps)).toBe(0);

    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(childEnv.VISUAL_MODEL).toBeUndefined();
    expect(h.out.join("\n")).not.toContain("Visual model");
  });

  it("the typed flag wins over a VISUAL_MODEL line in the config file", async () => {
    const port = freshPort();
    const dump = join(tempDir("hbn-dump-"), "env.json");
    const h = makeHarness({ scanPorts: [port], env: { STUB_ENV_FILE: dump } });
    writeFileSync(h.paths.configPath, "VISUAL_MODEL=false\n");

    expect(await runUp(h.deps, { visualModel: true })).toBe(0);

    const childEnv = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(childEnv.VISUAL_MODEL).toBe("true");
  });

  it("names the page's own userId when one is configured", async () => {
    const port = freshPort();
    const h = makeHarness({
      scanPorts: [port],
      env: { HABENULA_USER_ID: "someone else" },
    });

    expect(await runUp(h.deps, { visualModel: true })).toBe(0);
    expect(h.out.join("\n")).toContain("/dev/model?userId=someone%20else");
  });

  it("a found engine that already serves the page is reported, not restarted", async () => {
    const port = freshPort();
    const token = "f".repeat(32);
    await foreignStub(port, { INTERNAL_MCP_TOKEN: token, VISUAL_MODEL: "true" });

    const h = makeHarness({ scanPorts: [port] });
    writeFileSync(h.paths.configPath, `INTERNAL_MCP_TOKEN=${token}\n`);

    expect(await runUp(h.deps, { visualModel: true })).toBe(0);
    expect(h.spawnCount()).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(`Visual model at http://localhost:${port}/dev/model`);
    expect(text).not.toContain("started without the visual model");
  });

  it("a found foreign engine without the page is named, and this CLI does not offer to restart it", async () => {
    const port = freshPort();
    const token = "f".repeat(32);
    await foreignStub(port, { INTERNAL_MCP_TOKEN: token });

    const h = makeHarness({ scanPorts: [port] });
    writeFileSync(h.paths.configPath, `INTERNAL_MCP_TOKEN=${token}\n`);

    expect(await runUp(h.deps, { visualModel: true })).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("started without the visual model");
    expect(text).toContain("VISUAL_MODEL=true");
    // An engine this CLI did not start is not one it can cycle.
    expect(text).not.toContain("habenula down");
    expect(text).not.toContain("Visual model at");
  });

  it("an owned engine without the page gets the down/up instruction", async () => {
    const port = freshPort();
    const h = makeHarness({ scanPorts: [port] });
    expect(await runUp(h.deps)).toBe(0);
    h.out.length = 0;

    expect(await runUp(h.deps, { visualModel: true })).toBe(0);
    expect(h.spawnCount()).toBe(1);
    const text = h.out.join("\n");
    expect(text).toContain("Engine already running");
    expect(text).toContain("started without the visual model");
    expect(text).toContain("habenula down, then habenula up --visual-model");
  });
});
