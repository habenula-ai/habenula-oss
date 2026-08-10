import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ENGINE_VERSION,
  resolveEngineCommand,
} from "../../src/engine/resolve-engine-command";

// The injected Node binary: the composition root passes process.execPath.
const NODE = process.execPath;

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hbn-cmd-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveEngineCommand", () => {
  it("step 1: HABENULA_ENGINE_CMD wins and is split on whitespace into an argv", () => {
    const result = resolveEngineCommand({
      HABENULA_ENGINE_CMD: "node  /some/build/daemon.mjs --flag",
      PATH: "/nonexistent",
    }, NODE);
    expect(result).toEqual({ argv: ["node", "/some/build/daemon.mjs", "--flag"] });
  });

  it("a metacharacter in the command stays an argument, never shell syntax", () => {
    const result = resolveEngineCommand({
      HABENULA_ENGINE_CMD: "/opt/weird&name/engine",
    }, NODE);
    expect(result).toEqual({ argv: ["/opt/weird&name/engine"] });
  });

  it("step 2: HABENULA_ENGINE_BIN is run with this Node, as one path", () => {
    const dir = tempDir();
    // A space in the path is the case a command line cannot carry: the umbrella
    // sets this from wherever npm put the install, which the user chose.
    const nested = join(dir, "Application Support");
    mkdirSync(nested);
    const entry = join(nested, "daemon.js");
    writeFileSync(entry, "// engine\n");
    const result = resolveEngineCommand({ HABENULA_ENGINE_BIN: entry, PATH: "/nonexistent" }, NODE);
    expect(result).toEqual({ argv: [NODE, entry] });
  });

  it("HABENULA_ENGINE_CMD outranks HABENULA_ENGINE_BIN: an explicit choice wins", () => {
    const dir = tempDir();
    const entry = join(dir, "daemon.js");
    writeFileSync(entry, "// engine\n");
    const result = resolveEngineCommand({
      HABENULA_ENGINE_CMD: "node /my/own/daemon.mjs",
      HABENULA_ENGINE_BIN: entry,
    }, NODE);
    expect(result).toEqual({ argv: ["node", "/my/own/daemon.mjs"] });
  });

  it("HABENULA_ENGINE_BIN outranks PATH: the carried engine beats a global one", () => {
    const carried = tempDir();
    const entry = join(carried, "daemon.js");
    writeFileSync(entry, "// engine\n");
    const onPath = tempDir();
    const bin = join(onPath, "habenula-engine");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const result = resolveEngineCommand({ HABENULA_ENGINE_BIN: entry, PATH: onPath }, NODE);
    expect(result).toEqual({ argv: [NODE, entry] });
  });

  it("a HABENULA_ENGINE_BIN naming no file moves the walk on rather than refusing", () => {
    const dir = tempDir();
    const bin = join(dir, "habenula-engine");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const result = resolveEngineCommand({
      HABENULA_ENGINE_BIN: join(dir, "gone.js"),
      PATH: dir,
    }, NODE);
    expect(result).toEqual({ argv: [bin] });
  });

  it("a directory in HABENULA_ENGINE_BIN is not a file, so it does not end the walk", () => {
    const dir = tempDir();
    const asDir = join(dir, "daemon.js");
    mkdirSync(asDir);
    const result = resolveEngineCommand({ HABENULA_ENGINE_BIN: asDir, PATH: "/nonexistent" }, NODE);
    expect("refusal" in result).toBe(true);
  });

  it("step 3: an executable habenula-engine on PATH is used", () => {
    const dir = tempDir();
    const bin = join(dir, "habenula-engine");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const result = resolveEngineCommand({ PATH: `/nonexistent${delimiter}${dir}` }, NODE);
    expect(result).toEqual({ argv: [bin] });
  });

  it("a non-executable habenula-engine loses to an executable one further along PATH", () => {
    const first = tempDir();
    const second = tempDir();
    writeFileSync(join(first, "habenula-engine"), "just a note\n");
    chmodSync(join(first, "habenula-engine"), 0o644);
    const real = join(second, "habenula-engine");
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    const result = resolveEngineCommand({ PATH: `${first}${delimiter}${second}` }, NODE);
    expect(result).toEqual({ argv: [real] });
  });

  it("a directory named habenula-engine does not end the walk", () => {
    const first = tempDir();
    mkdirSync(join(first, "habenula-engine"));
    const second = tempDir();
    const real = join(second, "habenula-engine");
    writeFileSync(real, "#!/bin/sh\n");
    chmodSync(real, 0o755);
    const result = resolveEngineCommand({ PATH: `${first}${delimiter}${second}` }, NODE);
    expect(result).toEqual({ argv: [real] });
  });

  it("step 4 under vitest is the source-run fallback, and the version gate refuses it", () => {
    // Every source run (tsx, vitest, tsc) sees the build-time define as
    // undefined, so the fallback version must trip the same refusal a
    // placeholder release does.
    expect(ENGINE_VERSION).toBe("0.0.0-source");
    const result = resolveEngineCommand({ PATH: "/nonexistent" }, NODE);
    expect("refusal" in result).toBe(true);
  });

  it("the gate's refusal names both remedies and never a repository recipe", () => {
    // One link of the guidance chain: unreachable engine → run `habenula up`
    // → this refusal. A reader with no clone must be able to follow it.
    const result = resolveEngineCommand({ PATH: "/nonexistent" }, NODE);
    if (!("refusal" in result)) throw new Error("expected the version gate to refuse");
    expect(result.refusal).toContain("habenula-engine");
    expect(result.refusal).toContain("PATH");
    expect(result.refusal).toContain("HABENULA_ENGINE_CMD");
    expect(result.refusal).toContain(ENGINE_VERSION);
    expect(result.refusal).not.toContain("just ");
    expect(result.refusal).not.toContain("Justfile");
  });

  it("an empty or whitespace HABENULA_ENGINE_CMD falls through to the walk", () => {
    const result = resolveEngineCommand({ HABENULA_ENGINE_CMD: "   ", PATH: "/nonexistent" }, NODE);
    expect("refusal" in result).toBe(true);
  });
});
