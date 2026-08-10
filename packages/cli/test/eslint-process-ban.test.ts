import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The guard that guards the guard. The `process` ban over src/engine/** is the
 * whole answer to the persist-root risk — a module that read process.env could
 * fall back to the developer's real ~/.habenula in a test run — so this test
 * asserts the eslint block actually reports, rather than assuming the rule
 * form fires. It runs eslint's own lintText over a virtual path under
 * src/engine/, so there is no fixture file on disk and no dependence on which
 * globals list resolves the reference. If the rule form ever proves fragile,
 * the direct fallback is no-restricted-syntax on Identifier[name='process'].
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const BANNED_RULES = ["no-restricted-globals", "no-restricted-syntax"];

async function lintAt(virtualPath: string): Promise<(string | null)[]> {
  const eslint = new ESLint({ cwd: packageRoot });
  const results = await eslint.lintText(
    "export const leaked = process.env.HABENULA_PERSIST_ROOT;\n",
    { filePath: join(packageRoot, virtualPath) },
  );
  return results.flatMap((r) => r.messages.map((m) => m.ruleId));
}

describe("the process ban over src/engine/ and the up/down commands", () => {
  it("reports a process read in a src/engine/ module", async () => {
    const ruleIds = await lintAt("src/engine/ban-probe.ts");
    expect(ruleIds.some((id) => id !== null && BANNED_RULES.includes(id))).toBe(
      true,
    );
  });

  it.each(["src/commands/up.ts", "src/commands/down.ts"])(
    "reports a process read in %s",
    async (path) => {
      const ruleIds = await lintAt(path);
      expect(
        ruleIds.some((id) => id !== null && BANNED_RULES.includes(id)),
      ).toBe(true);
    },
  );

  it("does not fire outside the banned set", async () => {
    const ruleIds = await lintAt("src/ban-probe.ts");
    expect(ruleIds.some((id) => id !== null && BANNED_RULES.includes(id))).toBe(
      false,
    );
  });
});
