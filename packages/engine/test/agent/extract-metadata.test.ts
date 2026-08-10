import { describe, it, expect } from "vitest";
import { extractMetadata } from "../../src/agent/user-agent";

describe("extractMetadata", () => {
  it("extracts types and lengths for standard param types", () => {
    const meta = extractMetadata({
      name: "hello",
      count: 42,
      active: true,
      tags: [1, 2, 3],
      nothing: null,
      nested: { a: 1, b: 2 },
    });

    expect(meta).toEqual({
      name: { type: "string", length: 5 },
      count: { type: "number" },
      active: { type: "boolean" },
      tags: { type: "array", length: 3 },
      nothing: { type: "null" },
      nested: { type: "object", keys: ["a", "b"] },
    });
  });

  it("truncates object keys beyond 100", () => {
    const bigObj: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      bigObj[`key_${i}`] = i;
    }

    const meta = extractMetadata({ data: bigObj });
    const entry = meta.data as {
      type: string;
      keyCount: number;
      keys: string[];
      truncated: boolean;
    };

    expect(entry.type).toBe("object");
    expect(entry.truncated).toBe(true);
    expect(entry.keyCount).toBe(200);
    expect(entry.keys).toHaveLength(100);
  });

  it("returns truncation sentinel when output exceeds 10KB", () => {
    // Build params that produce a large metadata output
    const params: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      params[`field_${i}_${"x".repeat(20)}`] = "a".repeat(100);
    }

    const meta = extractMetadata(params);

    expect(meta).toEqual({
      truncated: true,
      originalKeyCount: 500,
    });
  });

  it("returns normal output for small params", () => {
    const meta = extractMetadata({ q: "search" });

    expect(meta).toEqual({
      q: { type: "string", length: 6 },
    });
  });

  it("handles empty params", () => {
    expect(extractMetadata({})).toEqual({});
  });
});
