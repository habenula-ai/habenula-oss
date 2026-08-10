import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApiClient } from "../../src/api-client";
import { runPolicyList } from "../../src/commands/policy";

/**
 * `habenula policy` list output: the effective decision plus one line per
 * entry — 8-char id prefix, `service:verb:noun` scope, decision, source,
 * priority — straight from `GET /api/policy`. The command has no flags and no
 * write path (POST /api/policy was removed), so rendering is the
 * whole surface.
 */
function makeClient(policy: unknown): ApiClient {
  return { getPolicy: vi.fn(async () => policy) } as unknown as ApiClient;
}

const ENTRY = {
  id: "0123456789abcdef",
  source: "default",
  service: "*",
  verb: "*",
  noun: "*",
  decision: "deny" as const,
  priority: 0,
  createdAt: "2026-07-03T11:48:00.000Z",
  expiresAt: null,
};

describe("runPolicyList", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the effective decision and one line per entry", async () => {
    const client = makeClient({
      effectiveDecision: "deny",
      entries: [
        ENTRY,
        {
          ...ENTRY,
          id: "fedcba9876543210",
          source: "session",
          service: "mock_email",
          verb: "list",
          noun: "INBOX",
          decision: "allow" as const,
          priority: 10,
        },
      ],
    });

    const code = await runPolicyList(client);

    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Effective policy: deny");
    expect(out).toContain("Policy entries:");
    // The full entry line shape: truncated id, scope triple, decision, provenance.
    expect(out).toContain("01234567  *:*:*  →  deny  (default, priority 0)");
    expect(out).toContain("fedcba98  mock_email:list:INBOX  →  allow  (session, priority 10)");
    expect(out).not.toContain("No policy entries.");
  });

  it("says so when only the effective decision exists (the deny floor pre-grant shape)", async () => {
    const client = makeClient({ effectiveDecision: "deny", entries: [] });

    const code = await runPolicyList(client);

    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Effective policy: deny");
    expect(out).toContain("No policy entries.");
    expect(out).not.toContain("Policy entries:");
  });

  it("propagates a failed policy read (the CLI entry point renders the error)", async () => {
    const client = {
      getPolicy: vi.fn(async () => {
        throw new Error("engine unreachable");
      }),
    } as unknown as ApiClient;

    await expect(runPolicyList(client)).rejects.toThrow("engine unreachable");
  });
});
