import { describe, it, expect } from "vitest";
import { ApiError, EngineUnavailableError } from "../src/api-client";
import { formatError, recoveryLine, unavailableGuidance } from "../src/errors";

describe("unavailableGuidance", () => {
  it("the reject variant names the apiUrl and how to start an engine", () => {
    // The first link of the reader-with-no-clone chain: unreachable engine →
    // run `habenula up` → (pre-publish) the version gate's refusal, whose own
    // strings are pinned in resolve-engine-command.test.ts. A repository-only
    // recipe here would dead-end an npm-installed reader.
    const line = unavailableGuidance("http://localhost:8787", "reject");
    expect(line).toContain("not reachable");
    expect(line).toContain("http://localhost:8787");
    expect(line).toContain("habenula up");
    expect(line).toContain("HABENULA_API_URL");
    expect(line).not.toContain("just engine-dev");
  });

  it("the deadline variant says not responding and never claims the engine is down", () => {
    // A slow-but-alive engine trips its deadline too —
    // the message must not assert a state the CLI cannot know.
    const line = unavailableGuidance("http://localhost:8787", "deadline");
    expect(line).toContain("not responding");
    expect(line).toContain("http://localhost:8787");
    expect(line).not.toContain("not reachable");
    expect(line).not.toMatch(/not running|is down/);
  });
});

describe("recoveryLine", () => {
  it("is kind-aware: a deadline-driven offline never narrates a disconnect that did not happen", () => {
    expect(recoveryLine("reject")).toBe("Engine connected.");
    expect(recoveryLine("deadline")).toBe("Engine responding again.");
  });
});

describe("formatError", () => {
  it("renders EngineUnavailableError via unavailableGuidance (per kind)", () => {
    for (const kind of ["reject", "deadline"] as const) {
      const err = new EngineUnavailableError("http://api.test", kind);
      expect(formatError(err)).toBe(unavailableGuidance("http://api.test", kind));
    }
  });

  it("keeps the ApiError and generic Error renderings unchanged", () => {
    expect(formatError(new ApiError(404, "not found"))).toBe("error (404): not found");
    expect(formatError(new Error("boom"))).toBe("error: boom");
    expect(formatError("weird")).toBe("error: weird");
  });
});
