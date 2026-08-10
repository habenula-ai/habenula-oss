import { describe, it, expect } from "vitest";
import { lookupTool, listTools, toolName } from "../../src/tools";
import { SERVICES } from "../../src/services/catalog";

/**
 * The registry contract, iterated over the catalog so a new service re-runs
 * every invariant: the `${service}_${verb}` key is opaque — resolved by
 * lookup, never split — and every catalog tool round-trips through it.
 */
describe("Tool registry (service-keyed)", () => {
  it("resolves every catalog tool to its own (service, verb) by opaque lookup", () => {
    for (const service of SERVICES) {
      for (const tool of service.tools) {
        // Identity, not shape: splitting the key on "_" would mis-resolve an
        // underscore service name (e.g. mock_email → service "mock"), so the
        // lookup must return the declaring service's own tool object.
        const resolved = lookupTool(toolName(tool));
        expect(resolved).toBe(tool);
        expect(resolved!.service).toBe(service.service);
        expect(resolved!.verb).toBe(tool.verb);
      }
    }
  });

  it("derives the tool name as service_verb", () => {
    for (const tool of listTools()) {
      expect(toolName(tool)).toBe(`${tool.service}_${tool.verb}`);
    }
  });

  it("every tool extracts a non-empty default noun (mandatory noun binding)", () => {
    // No bare verb grants — a tool call always binds a noun, so the
    // extractor must produce one even for empty params.
    for (const tool of listTools()) {
      const noun = tool.nounExtractor({});
      expect(typeof noun).toBe("string");
      expect(noun.length).toBeGreaterThan(0);
      // And a list tool with a label-shaped vocabulary (the email services)
      // extracts an explicit label as the noun; google_calendar's list
      // governs the folded calendar name, pinned in its per-service suite.
      // Other verbs own their own noun shapes (read's sentinel, search's
      // resolved label), pinned in their per-tool
      // suites.
      if (tool.verb === "list" && "label" in tool.inputSchema.properties) {
        expect(tool.nounExtractor({ label: "SENT" })).toBe("SENT");
        // A blank label is "unspecified", not a bare-noun escape hatch: it must
        // still bind a non-empty noun (the default mailbox), never "".
        expect(tool.nounExtractor({ label: "" }).length).toBeGreaterThan(0);
        expect(tool.nounExtractor({ label: "   " }).length).toBeGreaterThan(0);
      }
    }
  });

  it("each tool carries an LLM-facing description and input schema", () => {
    for (const tool of listTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("returns null for unknown tool names", () => {
    expect(lookupTool("unknown_tool")).toBeNull();
    expect(lookupTool("")).toBeNull();
  });

  it("has no two tools that collide on the same derived tool name", () => {
    // The collision guard: two distinct (service, verb) pairs must never
    // produce the same opaque key (e.g. (mock_email, list) vs a hypothetical
    // (mock, email_list)), or lookupTool would mis-resolve one to the other.
    const names = listTools().map(toolName);
    expect(names).toEqual([...new Set(names)]);
  });
});
