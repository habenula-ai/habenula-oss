import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What a malformed config file does and does not stop, driven through the REAL
 * entry — a child process running src/bin.ts — because the whole question is
 * about ordering that a direct `loadConfig` call cannot see: the load happens
 * before Commander parses.
 *
 * A command that talks to the engine refuses, naming the file and the line. A
 * command that reads nothing from the config does not: `--help` is how a user
 * finds out where the file lives, and `log verify --file` is an offline
 * recomputation over a dump. Refusing those would mean a text file could stand
 * between the user and the CLI's own help.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const tempRoots: string[] = [];

function withMalformedConfig(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), "hbn-main-"));
  tempRoots.push(root);
  const configPath = join(root, "config");
  writeFileSync(configPath, "INTERNAL_MCP_TOKEN\n");
  return { root, configPath };
}

function run(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("a malformed config file and the commands that read it", () => {
  it("refuses a command that talks to the engine, naming the file and line", () => {
    const { root, configPath } = withMalformedConfig();

    const result = run(["src/bin.ts", "status"], {
      HABENULA_PERSIST_ROOT: root,
      HABENULA_CONFIG: configPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).toContain("line 1");
    // The escape hatch is in the message: a file the user cannot fix from memory
    // must not be able to stand between them and `habenula kill`.
    expect(result.stderr).toContain("HABENULA_INTERNAL_MCP_TOKEN");
    // A refusal, not a crash: no stack frames on the way out.
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  it("still prints --help, which is where the config file is documented", () => {
    const { root, configPath } = withMalformedConfig();

    const result = run(["src/bin.ts", "--help"], {
      HABENULA_PERSIST_ROOT: root,
      HABENULA_CONFIG: configPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).not.toContain(configPath);
  });

  it("does not fail the offline log verify over a dump file", () => {
    const { root, configPath } = withMalformedConfig();
    const dumpPath = join(root, "dump.jsonl");
    writeFileSync(dumpPath, "");

    const result = run(["src/bin.ts", "log", "verify", "--file", dumpPath], {
      HABENULA_PERSIST_ROOT: root,
      HABENULA_CONFIG: configPath,
    });

    // Whatever it concludes about an empty chain, it must not be the config's
    // fault: this path never reads a value from the file.
    expect(result.stderr).not.toContain(configPath);
    expect(result.stderr).not.toContain("line 1");
  });

  it("does not run the CLI when the module is imported", () => {
    const { root, configPath } = withMalformedConfig();
    // The guard for the defect this split exists to prevent: two test files
    // import src/index.ts, and a module-scope main() would refuse the config and
    // exit the importing process — a dead vitest worker rather than a failed
    // assertion, on a developer's machine only.
    const probePath = join(root, "probe.mts");
    writeFileSync(
      probePath,
      `await import(${JSON.stringify(join(packageRoot, "src/index.ts"))});\n` +
        `process.stdout.write("imported\\n");\n`,
    );

    const result = run([probePath], {
      HABENULA_PERSIST_ROOT: root,
      HABENULA_CONFIG: configPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("imported");
    expect(result.stderr).not.toContain(configPath);
  });
});
