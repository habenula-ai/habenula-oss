import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRoot, resolveEnginePaths } from "../../src/engine/paths";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hbn-paths-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveEnginePaths", () => {
  it("defaults the root to ~/.habenula, matching the daemon's own fallback", () => {
    const paths = resolveEnginePaths({});
    expect(paths.root).toBe(join(homedir(), ".habenula"));
    expect(paths.configPath).toBe(join(paths.root, "config"));
    expect(paths.recordPath).toBe(join(paths.root, "engine.json"));
    expect(paths.logPath).toBe(join(paths.root, "engine.log"));
  });

  it("HABENULA_PERSIST_ROOT moves the root, and the config follows it", () => {
    const paths = resolveEnginePaths({ HABENULA_PERSIST_ROOT: "/tmp/elsewhere" });
    expect(paths.root).toBe("/tmp/elsewhere");
    expect(paths.configPath).toBe(join("/tmp/elsewhere", "config"));
    expect(paths.recordPath).toBe(join("/tmp/elsewhere", "engine.json"));
    expect(paths.logPath).toBe(join("/tmp/elsewhere", "engine.log"));
  });

  it("HABENULA_CONFIG names the config outright without moving the rest", () => {
    const paths = resolveEnginePaths({
      HABENULA_PERSIST_ROOT: "/tmp/elsewhere",
      HABENULA_CONFIG: "/tmp/named-config",
    });
    expect(paths.configPath).toBe("/tmp/named-config");
    expect(paths.root).toBe("/tmp/elsewhere");
  });

  it("names the three rotated log generations, newest first", () => {
    const paths = resolveEnginePaths({ HABENULA_PERSIST_ROOT: "/r" });
    expect(paths.rotatedLogPaths).toEqual([
      join("/r", "engine.log.1"),
      join("/r", "engine.log.2"),
      join("/r", "engine.log.3"),
    ]);
  });

  describe("a blank or relative root", () => {
    it("treats a blank HABENULA_PERSIST_ROOT as unset", () => {
      // `HABENULA_PERSIST_ROOT=` from a script or a Docker env_file used to make
      // join("", "config") collapse to the relative `config`, so the CLI read
      // whatever ./config happened to be in the current directory.
      for (const blank of ["", "   "]) {
        const paths = resolveEnginePaths({ HABENULA_PERSIST_ROOT: blank });
        expect(paths.root).toBe(join(homedir(), ".habenula"));
        expect(paths.configPath).toBe(join(homedir(), ".habenula", "config"));
      }
    });

    it("refuses a relative root rather than resolving it against the cwd", () => {
      // There is no cwd to resolve against here — this module may not read
      // `process` — and silently writing engine state into whatever directory
      // the command ran from is the outcome being refused.
      expect(() =>
        resolveEnginePaths({ HABENULA_PERSIST_ROOT: "state" }),
      ).toThrowError(/must be an absolute path/);
      expect(() =>
        resolveEnginePaths({ HABENULA_PERSIST_ROOT: "./state" }),
      ).toThrowError(/must be an absolute path/);
    });

    it("treats a blank HABENULA_CONFIG as unset", () => {
      // Otherwise the path is "", whose ENOENT reads as "no config file" — the
      // silent-absence answer this layer must never give.
      const paths = resolveEnginePaths({
        HABENULA_PERSIST_ROOT: "/tmp/elsewhere",
        HABENULA_CONFIG: "  ",
      });
      expect(paths.configPath).toBe(join("/tmp/elsewhere", "config"));
    });
  });
});

describe("ensureRoot", () => {
  it("creates a missing root at 0700", () => {
    const parent = tempRoot();
    const paths = resolveEnginePaths({
      HABENULA_PERSIST_ROOT: join(parent, "fresh"),
    });
    ensureRoot(paths);
    expect(statSync(paths.root).mode & 0o777).toBe(0o700);
  });

  it("leaves an existing directory's mode alone", () => {
    const parent = tempRoot();
    const root = join(parent, "existing");
    mkdirSync(root, { recursive: true, mode: 0o755 });
    ensureRoot(resolveEnginePaths({ HABENULA_PERSIST_ROOT: root }));
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });
});
