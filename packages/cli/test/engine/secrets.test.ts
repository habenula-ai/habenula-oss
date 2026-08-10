import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCredentialKey } from "../../../engine/src/credential-guard";
import { resolveEnginePaths } from "../../src/engine/paths";
import { claimRunSlot, type SlotClaim } from "../../src/engine/run-record";
import {
  checkGenerationGuards,
  generateCredentialKey,
  generateDriveToken,
  type GenerationInputs,
} from "../../src/engine/secrets";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hbn-secrets-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A real claim: SlotClaim is deliberately unconstructable outside
 * run-record.ts, so even the test suite obtains one the only legal way —
 * which is itself an assertion that guard 0's type mechanism holds.
 */
function realClaim(root: string): SlotClaim {
  const paths = resolveEnginePaths({ HABENULA_PERSIST_ROOT: root });
  const result = claimRunSlot(paths, {
    port: 8788,
    logPath: paths.logPath,
    now: () => 1,
  });
  if (!result.won) throw new Error("claim unexpectedly lost");
  return result.claim;
}

function inputs(root: string, overrides?: Partial<GenerationInputs>): GenerationInputs {
  return {
    env: {},
    fileVars: null,
    root,
    configPath: join(root, "config"),
    cwdEnvVars: null,
    ...overrides,
  };
}

describe("generation", () => {
  it("generates a key the engine's own guard accepts — no second regex", () => {
    // Asserted against validateCredentialKey (the engine's fail-closed gate),
    // so the accepted format is written down exactly once.
    expect(validateCredentialKey(generateCredentialKey())).toBeNull();
  });

  it("generates distinct values per call (CSPRNG, not a constant)", () => {
    expect(generateCredentialKey()).not.toBe(generateCredentialKey());
    expect(generateDriveToken()).not.toBe(generateDriveToken());
    expect(generateDriveToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("checkGenerationGuards", () => {
  it("a clean first run generates both secrets", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(realClaim(root), inputs(root));
    if ("refusal" in result) throw new Error(result.refusal);
    expect(validateCredentialKey(result.values.credentialKey)).toBeNull();
    expect(result.values.driveToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("guard 1: a key in the environment is never re-generated and never persisted", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, { env: { CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64) } }),
    );
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.values.credentialKey).toBeUndefined();
    expect(result.values.driveToken).toBeDefined();
  });

  it("guard 2: a key in the config file is never re-generated", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, {
        fileVars: {
          CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64),
          INTERNAL_MCP_TOKEN: "tok",
        },
      }),
    );
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.values).toEqual({});
  });

  it("guard 3: a persist root holding a store with no recorded key refuses, naming the remedy", () => {
    const root = tempRoot();
    mkdirSync(join(root, "do"), { recursive: true });
    const result = checkGenerationGuards(realClaim(root), inputs(root));
    if (!("refusal" in result)) throw new Error("expected guard 3 to refuse");
    expect(result.refusal).toContain(root);
    expect(result.refusal).toContain("CREDENTIAL_ENCRYPTION_KEY");
    expect(result.refusal).toContain("holds engine state");
  });

  it("guard 4: a working-directory .env declaring the key refuses rather than minting a second one", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, { cwdEnvVars: { CREDENTIAL_ENCRYPTION_KEY: "c".repeat(64) } }),
    );
    if (!("refusal" in result)) throw new Error("expected guard 4 to refuse");
    expect(result.refusal).toContain("./.env");
    expect(result.refusal).toContain("second key");
    expect(result.refusal).toContain(join(root, "config"));
  });

  it("guard 4 covers the credential key only: a .env token does not block token generation", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, {
        env: { CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64) },
        cwdEnvVars: { INTERNAL_MCP_TOKEN: "container-token" },
      }),
    );
    if ("refusal" in result) throw new Error(result.refusal);
    expect(result.values.driveToken).toBeDefined();
  });

  it("the drive token generates only when absent from both sources", () => {
    const root = tempRoot();
    const viaEnv = checkGenerationGuards(
      realClaim(tempRoot()),
      inputs(root, {
        env: { CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64), INTERNAL_MCP_TOKEN: "t" },
      }),
    );
    if ("refusal" in viaEnv) throw new Error(viaEnv.refusal);
    expect(viaEnv.values).toEqual({});
  });

  it("a blank key is not a source: it generates rather than forwarding the empty string", () => {
    // The failure this rules out is silent and permanent: a blank export read
    // as "already have one" skips generation, the daemon boots under an empty
    // key, and every credential it stores is written under a key nothing
    // records. Both layers, because a bare `KEY=` line parses to "" as well.
    const root = tempRoot();
    const viaEnv = checkGenerationGuards(
      realClaim(root),
      inputs(root, { env: { CREDENTIAL_ENCRYPTION_KEY: "", INTERNAL_MCP_TOKEN: "  " } }),
    );
    if ("refusal" in viaEnv) throw new Error(viaEnv.refusal);
    expect(validateCredentialKey(viaEnv.values.credentialKey)).toBeNull();
    expect(viaEnv.values.driveToken).toMatch(/^[0-9a-f]{32}$/);

    const otherRoot = tempRoot();
    const viaFile = checkGenerationGuards(
      realClaim(otherRoot),
      inputs(otherRoot, {
        fileVars: { CREDENTIAL_ENCRYPTION_KEY: "", INTERNAL_MCP_TOKEN: "" },
      }),
    );
    if ("refusal" in viaFile) throw new Error(viaFile.refusal);
    expect(validateCredentialKey(viaFile.values.credentialKey)).toBeNull();
    expect(viaFile.values.driveToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it("guard 4 ignores a blank .env key: nothing is declared, so nothing is shadowed", () => {
    const root = tempRoot();
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, { cwdEnvVars: { CREDENTIAL_ENCRYPTION_KEY: "" } }),
    );
    if ("refusal" in result) throw new Error(result.refusal);
    expect(validateCredentialKey(result.values.credentialKey)).toBeNull();
  });

  it("no refusal or generated value ever echoes a secret it was given", () => {
    const root = tempRoot();
    mkdirSync(join(root, "do"), { recursive: true });
    const envKey = "d".repeat(64);
    const result = checkGenerationGuards(
      realClaim(root),
      inputs(root, { cwdEnvVars: { CREDENTIAL_ENCRYPTION_KEY: envKey } }),
    );
    // Guard 3 fires first here; either way the refusal must not carry the value.
    if ("refusal" in result) {
      expect(result.refusal).not.toContain(envKey);
    }
  });
});
