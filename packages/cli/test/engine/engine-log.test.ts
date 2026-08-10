import { describe, it, expect, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineLog, rotateEngineLog } from "../../src/engine/engine-log";
import { resolveEnginePaths, type EnginePaths } from "../../src/engine/paths";

const tempRoots: string[] = [];

function makePaths(): EnginePaths {
  const root = mkdtempSync(join(tmpdir(), "hbn-log-"));
  tempRoots.push(root);
  return resolveEnginePaths({ HABENULA_PERSIST_ROOT: root });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rotateEngineLog", () => {
  it("shifts three generations, newest first, and discards what falls off the end", () => {
    const paths = makePaths();
    const [gen1, gen2, gen3] = paths.rotatedLogPaths;
    writeFileSync(paths.logPath, "current\n");
    writeFileSync(gen1, "one back\n");
    writeFileSync(gen2, "two back\n");
    writeFileSync(gen3, "three back — discarded\n");

    rotateEngineLog(paths);

    expect(existsSync(paths.logPath)).toBe(false);
    expect(readFileSync(gen1, "utf8")).toBe("current\n");
    expect(readFileSync(gen2, "utf8")).toBe("one back\n");
    expect(readFileSync(gen3, "utf8")).toBe("two back\n");
  });

  it("tolerates missing generations at every step (a first run rotates nothing)", () => {
    const paths = makePaths();
    expect(() => rotateEngineLog(paths)).not.toThrow();
    writeFileSync(paths.logPath, "only current\n");
    rotateEngineLog(paths);
    expect(readFileSync(paths.rotatedLogPaths[0], "utf8")).toBe("only current\n");
    expect(existsSync(paths.rotatedLogPaths[1])).toBe(false);
  });
});

describe("openEngineLog", () => {
  it("opens a fresh 0600 log the spawn's stdio can take", () => {
    const paths = makePaths();
    const fd = openEngineLog(paths);
    closeSync(fd);
    expect(statSync(paths.logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.logPath, "utf8")).toBe("");
  });

  it("truncates a leftover current log rather than appending to it", () => {
    const paths = makePaths();
    writeFileSync(paths.logPath, "stale content\n");
    const fd = openEngineLog(paths);
    closeSync(fd);
    expect(readFileSync(paths.logPath, "utf8")).toBe("");
  });
});
