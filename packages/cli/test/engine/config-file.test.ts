import { describe, it, expect, afterEach } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfigFile,
  mergeAbsentKeys,
  readConfigFile,
} from "../../src/engine/config-file";
import { ConfigFileError } from "../../src/engine/env-file";

/**
 * Behavioral tier: the real filesystem in a mkdtempSync root, never a fake and
 * never a developer's real ~/.habenula (the path is always explicit).
 */
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hbn-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("readConfigFile", () => {
  it("returns null for a file that does not exist", () => {
    expect(readConfigFile(join(tempRoot(), "config"))).toBeNull();
  });

  it("returns the parsed record for a file that does", () => {
    const path = join(tempRoot(), "config");
    writeFileSync(path, "A=1\n");
    expect(readConfigFile(path)).toEqual({ A: "1" });
  });

  it("propagates a malformed line as ConfigFileError naming the path", () => {
    const path = join(tempRoot(), "config");
    writeFileSync(path, "not a line\n");
    let thrown: unknown;
    try {
      readConfigFile(path);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigFileError);
    expect((thrown as ConfigFileError).message).toContain(path);
  });

  it("propagates a non-ENOENT read error rather than reading it as absent", () => {
    // A directory where the file should be: unreadable, not absent. An
    // unreadable config may hold the only copy of a credential key, so
    // guessing "absent" is the dangerous direction.
    const path = tempRoot();
    expect(() => readConfigFile(path)).toThrow();
  });
});

describe("createConfigFile", () => {
  it("creates the file at 0600 and reports the win", () => {
    const path = join(tempRoot(), "config");
    expect(createConfigFile(path, { A: "1" })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readConfigFile(path)).toEqual({ A: "1" });
  });

  it("is exclusive: the second caller loses and the first write survives", () => {
    const path = join(tempRoot(), "config");
    expect(createConfigFile(path, { A: "first" })).toBe(true);
    expect(createConfigFile(path, { A: "second" })).toBe(false);
    expect(readConfigFile(path)).toEqual({ A: "first" });
  });

  it("carries the file's own 0600 even in a wide-open directory", () => {
    // No file leans on the directory's mode: a root the daemon created first
    // is at whatever mode it got.
    const root = tempRoot();
    const path = join(root, "config");
    createConfigFile(path, { A: "1" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("mergeAbsentKeys", () => {
  it("adds only the keys still absent and never overwrites a present one", () => {
    const path = join(tempRoot(), "config");
    createConfigFile(path, { HABENULA_PORT: "9000" });
    mergeAbsentKeys(path, {
      HABENULA_PORT: "8788",
      OAUTH_REDIRECT_BASE_URL: "http://localhost:8788",
    });
    expect(readConfigFile(path)).toEqual({
      HABENULA_PORT: "9000",
      OAUTH_REDIRECT_BASE_URL: "http://localhost:8788",
    });
  });

  it("preserves the existing text verbatim, comments included", () => {
    const path = join(tempRoot(), "config");
    writeFileSync(path, "# my note\nA=1\n");
    mergeAbsentKeys(path, { B: "2" });
    expect(readFileSync(path, "utf8")).toBe("# my note\nA=1\nB=2\n");
  });

  it("appends cleanly to a file missing its trailing newline", () => {
    const path = join(tempRoot(), "config");
    writeFileSync(path, "A=1");
    mergeAbsentKeys(path, { B: "2" });
    expect(readConfigFile(path)).toEqual({ A: "1", B: "2" });
  });

  it("a no-op merge writes nothing", () => {
    const path = join(tempRoot(), "config");
    writeFileSync(path, "# untouched\nA=1\n");
    mergeAbsentKeys(path, { A: "other" });
    expect(readFileSync(path, "utf8")).toBe("# untouched\nA=1\n");
  });

  it("rewrites through a temp name and leaves no temp file behind", () => {
    const root = tempRoot();
    const path = join(root, "config");
    createConfigFile(path, { A: "1" });
    mergeAbsentKeys(path, { B: "2" });
    expect(readdirSync(root)).toEqual(["config"]);
  });

  it("keeps the rewritten file at 0600", () => {
    const path = join(tempRoot(), "config");
    createConfigFile(path, { A: "1" });
    mergeAbsentKeys(path, { B: "2" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlink instead of replacing it", () => {
    // A user may link this path at the .env their container already reads — the
    // shared-config story. A rename replaces an inode, so writing over the link
    // would split one file into two that drift apart with no error at either end.
    const root = tempRoot();
    const real = join(root, "shared.env");
    const link = join(root, "config");
    writeFileSync(real, "A=1\n", { mode: 0o600 });
    symlinkSync(real, link);

    mergeAbsentKeys(link, { B: "2" });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("A=1\nB=2\n");
    expect(readdirSync(root).sort()).toEqual(["config", "shared.env"]);
  });

  it("keeps a widened mode the operator set rather than resetting to 0600", () => {
    // ensureRoot refuses to change an existing directory's mode on the grounds
    // that it is not this command's business; the same reasoning applies to a
    // file an operator widened for a docker group.
    const path = join(tempRoot(), "config");
    writeFileSync(path, "A=1\n", { mode: 0o640 });
    mergeAbsentKeys(path, { B: "2" });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("merges a key whose name is an inherited Object.prototype name", () => {
    // `key in present` reads `constructor` and `toString` as already present, so
    // the merge reported success having written nothing.
    const path = join(tempRoot(), "config");
    createConfigFile(path, { A: "1" });
    mergeAbsentKeys(path, { constructor: "2", toString: "3" });
    expect(readConfigFile(path)).toEqual({
      A: "1",
      constructor: "2",
      toString: "3",
    });
  });
});
