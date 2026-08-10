import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnginePaths, type EnginePaths } from "../../src/engine/paths";
import {
  claimRunSlot,
  localDaemonHoldsPort,
  pidIsOurs,
  proveOwnership,
  readRunRecord,
  removeRunRecordIfUnchanged,
  removeUnparseableRunRecord,
  writeRunRecord,
  type RunRecord,
} from "../../src/engine/run-record";

const tempRoots: string[] = [];

function makePaths(): EnginePaths {
  const root = mkdtempSync(join(tmpdir(), "hbn-record-"));
  tempRoots.push(root);
  return resolveEnginePaths({ HABENULA_PERSIST_ROOT: root });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const NOW = 1_700_000_000_000;

function fullRecord(paths: EnginePaths, extra?: Partial<RunRecord>): RunRecord {
  return {
    port: 8788,
    url: "http://localhost:8788",
    startedAt: NOW,
    logPath: paths.logPath,
    ...extra,
  };
}

/** A kill(pid, 0) stub: throws the coded error for pids in the map. */
function killStub(pids: Record<number, string | null>) {
  return (pid: number, _signal: number | string): void => {
    const code = pids[pid];
    if (code === undefined || code !== null) {
      const err = new Error(code ?? "ESRCH") as Error & { code: string };
      err.code = code ?? "ESRCH";
      throw err;
    }
  };
}

describe("claimRunSlot", () => {
  it("claims exclusively at 0600 and hands the loser the record it collided with", () => {
    const paths = makePaths();
    const first = claimRunSlot(paths, { port: 8788, logPath: paths.logPath, now: () => NOW });
    expect(first.won).toBe(true);
    expect(statSync(paths.recordPath).mode & 0o777).toBe(0o600);

    const second = claimRunSlot(paths, { port: 8788, logPath: paths.logPath, now: () => NOW + 5 });
    expect(second.won).toBe(false);
    if (!second.won) {
      expect(second.record?.startedAt).toBe(NOW);
      expect(second.record?.url).toBe("http://localhost:8788");
    }
  });

  it("hands the loser null for an unparseable record", () => {
    const paths = makePaths();
    writeFileSync(paths.recordPath, "not json at all");
    const result = claimRunSlot(paths, { port: 8788, logPath: paths.logPath, now: () => NOW });
    expect(result.won).toBe(false);
    if (!result.won) expect(result.record).toBeNull();
  });
});

describe("readRunRecord", () => {
  it("returns null for an absent file", () => {
    expect(readRunRecord(makePaths())).toBeNull();
  });

  it.each([
    ["zero-byte", ""],
    ["truncated JSON", '{"port": 87'],
    ["wrong shape", JSON.stringify({ some: "later version" })],
    ["non-numeric pid", JSON.stringify({ port: 1, url: "u", startedAt: 2, logPath: "l", pid: "x" })],
  ])("reads a %s record as stale (null), never an error", (_name, text) => {
    const paths = makePaths();
    writeFileSync(paths.recordPath, text);
    expect(readRunRecord(paths)).toBeNull();
  });

  it("round-trips through writeRunRecord, which rewrites via temp-and-rename", () => {
    const paths = makePaths();
    const record = fullRecord(paths, { pid: 41823, pgid: 41823, servedAt: NOW + 900 });
    writeRunRecord(paths, record);
    expect(readRunRecord(paths)).toEqual(record);
    expect(statSync(paths.recordPath).mode & 0o777).toBe(0o600);
  });
});

describe("removeRunRecordIfUnchanged", () => {
  it("removes only a record whose startedAt matches the one that was read", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths));
    expect(removeRunRecordIfUnchanged(paths, NOW + 1)).toBe(false);
    expect(readRunRecord(paths)).not.toBeNull();
    expect(removeRunRecordIfUnchanged(paths, NOW)).toBe(true);
    expect(readRunRecord(paths)).toBeNull();
  });

  it("never unlinks a claim another run made in the meantime", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { startedAt: NOW + 999 }));
    expect(removeRunRecordIfUnchanged(paths, NOW)).toBe(false);
    expect(readRunRecord(paths)?.startedAt).toBe(NOW + 999);
  });
});

describe("removeUnparseableRunRecord", () => {
  it("removes a file only while it is still not a parseable record", () => {
    const paths = makePaths();
    writeFileSync(paths.recordPath, "garbage");
    expect(removeUnparseableRunRecord(paths)).toBe(true);
    expect(removeUnparseableRunRecord(paths)).toBe(false);
    writeRunRecord(paths, fullRecord(paths));
    expect(removeUnparseableRunRecord(paths)).toBe(false);
    expect(readRunRecord(paths)).not.toBeNull();
  });
});

describe("pidIsOurs", () => {
  it("only a clean kill(pid, 0) return proves a pid; EPERM and ESRCH are both not-ours", () => {
    const kill = killStub({ 100: null, 200: "EPERM", 300: "ESRCH" });
    expect(pidIsOurs(100, kill)).toBe(true);
    // EPERM is a LIVE process the caller may not signal — a signal to it
    // would fail anyway, so it is by definition not the daemon we spawned.
    expect(pidIsOurs(200, kill)).toBe(false);
    expect(pidIsOurs(300, kill)).toBe(false);
  });
});

describe("proveOwnership", () => {
  const classifyAs =
    (answer: "engine" | "listener" | "refused") => async (_port: number) =>
      answer;

  it("no record → no-record", async () => {
    const paths = makePaths();
    const proof = await proveOwnership(paths, {
      kill: killStub({}),
      classify: classifyAs("refused"),
      now: () => NOW,
    });
    expect(proof.kind).toBe("no-record");
  });

  it("unparseable record → stale with a null record", async () => {
    const paths = makePaths();
    writeFileSync(paths.recordPath, "{{{");
    const proof = await proveOwnership(paths, {
      kill: killStub({}),
      classify: classifyAs("refused"),
      now: () => NOW,
    });
    expect(proof).toEqual({ kind: "stale", record: null });
  });

  it("live pid + engine on the port → ours", async () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { pid: 100, pgid: 100 }));
    const proof = await proveOwnership(paths, {
      kill: killStub({ 100: null }),
      classify: classifyAs("engine"),
      now: () => NOW,
    });
    expect(proof.kind).toBe("ours");
  });

  it("EPERM pid + engine on the port → foreign, never ours", async () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { pid: 200 }));
    const proof = await proveOwnership(paths, {
      kill: killStub({ 200: "EPERM" }),
      classify: classifyAs("engine"),
      now: () => NOW,
    });
    expect(proof.kind).toBe("foreign");
  });

  it("live pid + silent port → pid-alive-port-silent, carrying whether it ever served", async () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { pid: 100, servedAt: NOW + 1 }));
    const served = await proveOwnership(paths, {
      kill: killStub({ 100: null }),
      classify: classifyAs("refused"),
      now: () => NOW + 10,
    });
    expect(served).toMatchObject({ kind: "pid-alive-port-silent", served: true });

    writeRunRecord(paths, fullRecord(paths, { pid: 100 }));
    const neverServed = await proveOwnership(paths, {
      kill: killStub({ 100: null }),
      classify: classifyAs("refused"),
      now: () => NOW + 10,
    });
    expect(neverServed).toMatchObject({ kind: "pid-alive-port-silent", served: false });
  });

  it("dead pid + silent port → stale", async () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { pid: 300 }));
    const proof = await proveOwnership(paths, {
      kill: killStub({ 300: "ESRCH" }),
      classify: classifyAs("refused"),
      now: () => NOW,
    });
    expect(proof).toMatchObject({ kind: "stale" });
  });

  it("no pid yet: younger than the bound → claim-pending; older → stale", async () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths));
    const pending = await proveOwnership(paths, {
      kill: killStub({}),
      classify: classifyAs("refused"),
      now: () => NOW + 1_000,
      staleMs: 5_000,
    });
    expect(pending.kind).toBe("claim-pending");

    const stale = await proveOwnership(paths, {
      kill: killStub({}),
      classify: classifyAs("refused"),
      now: () => NOW + 6_000,
      staleMs: 5_000,
    });
    expect(stale.kind).toBe("stale");
  });

  it("keeps the record readable text on disk (no torn write) after a rewrite", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths));
    writeRunRecord(paths, fullRecord(paths, { pid: 1, pgid: 1 }));
    expect(() => JSON.parse(readFileSync(paths.recordPath, "utf8"))).not.toThrow();
  });
});

describe("localDaemonHoldsPort", () => {
  it("is true for a record on that port whose pid is alive", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { port: 8788, pid: 100 }));
    expect(localDaemonHoldsPort(paths, 8788, killStub({ 100: null }))).toBe(true);
  });

  it("is false when the recorded pid is dead", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { port: 8788, pid: 300 }));
    expect(localDaemonHoldsPort(paths, 8788, killStub({ 300: "ESRCH" }))).toBe(
      false,
    );
  });

  it("is false for a record on a different port", () => {
    // The port is the whole question: a live daemon on 8788 says nothing about
    // who holds 9999, and an ssh -L forward there would otherwise pass.
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { port: 8788, pid: 100 }));
    expect(localDaemonHoldsPort(paths, 9999, killStub({ 100: null }))).toBe(
      false,
    );
  });

  it("is false with no record at all", () => {
    // The state a hand-written config is in before any engine has been started.
    expect(localDaemonHoldsPort(makePaths(), 8788, killStub({}))).toBe(false);
  });

  it("is false for a claim that has no pid yet", () => {
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { port: 8788 }));
    expect(localDaemonHoldsPort(paths, 8788, killStub({}))).toBe(false);
  });

  it("is false for an unparseable record", () => {
    const paths = makePaths();
    writeFileSync(paths.recordPath, "not json");
    expect(localDaemonHoldsPort(paths, 8788, killStub({}))).toBe(false);
  });

  it("asks the process table only after the record clears the port check", () => {
    // Ordering matters for cost: this runs on every command, and a record for
    // another port needs no signal probe.
    const paths = makePaths();
    writeRunRecord(paths, fullRecord(paths, { port: 8788, pid: 100 }));
    let probes = 0;
    localDaemonHoldsPort(paths, 9999, () => {
      probes++;
    });
    expect(probes).toBe(0);
  });
});
