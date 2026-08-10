import { describe, it, expect } from "vitest";
import { habenula } from "../../src/services/habenula/habenula";
import { lookupTool, toolName } from "../../src/tools/registry";

/**
 * The habenula control-plane service. These assert
 * the governance-facing metadata the pipeline reads — (service, verb, noun) and
 * the connect type — not execution, which is DO-dispatched (the catalog
 * `execute` is an unreachable guard). Governance behavior (held-on-first-use,
 * dispatch routing) is covered in the engine governance suite.
 */
describe("habenula control-plane service", () => {
  it("is a credential-less `none` service (first non-OAuth service)", () => {
    expect(habenula.service).toBe("habenula");
    expect(habenula.connect).toEqual({ type: "none" });
  });

  it("declares exactly the five control-plane tools with the spec's verbs", () => {
    expect(habenula.tools.map((t) => t.verb).sort()).toEqual(
      ["disconnect", "kill", "quit", "read", "status"].sort(),
    );
    for (const tool of habenula.tools) {
      expect(tool.service).toBe("habenula");
    }
  });

  it("carries no requiredScopes (a `none` service has no granted-scope blob to gate)", () => {
    for (const tool of habenula.tools) {
      expect(tool.requiredScopes).toBeUndefined();
    }
  });

  it("extracts the spec's concrete-literal nouns (never a wildcard)", () => {
    const noun = (verb: string) =>
      habenula.tools.find((t) => t.verb === verb)!.nounExtractor({});
    expect(noun("status")).toBe("self");
    expect(noun("kill")).toBe("all");
    expect(noun("quit")).toBe("session");
    expect(noun("read")).toBe("standing");
    for (const tool of habenula.tools) {
      // A "*" noun would be rejected by assertScopedGrant; none may produce one.
      expect(tool.nounExtractor({})).not.toBe("*");
    }
  });

  it("disconnect governs on the verbatim target service name", () => {
    const disconnect = habenula.tools.find((t) => t.verb === "disconnect")!;
    expect(disconnect.nounExtractor({ service: "gmail" })).toBe("gmail");
    expect(disconnect.nounExtractor({ service: "slack" })).toBe("slack");
    // Missing param yields a concrete (if inert) noun, never a wildcard or throw.
    expect(disconnect.nounExtractor({})).toBe("undefined");
  });

  it("is resolvable through the registry under the ${service}_${verb} name", () => {
    for (const tool of habenula.tools) {
      expect(lookupTool(toolName(tool))).toBe(tool);
    }
    expect(lookupTool("habenula_status")?.verb).toBe("status");
    expect(lookupTool("habenula_kill")?.verb).toBe("kill");
    expect(lookupTool("habenula_disconnect")?.verb).toBe("disconnect");
    expect(lookupTool("habenula_quit")?.verb).toBe("quit");
    expect(lookupTool("habenula_read")?.verb).toBe("read");
  });

  it("every tool has an object input schema", () => {
    for (const tool of habenula.tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
    const disconnect = habenula.tools.find((t) => t.verb === "disconnect")!;
    expect(disconnect.inputSchema.required).toEqual(["service"]);
  });

  it("catalog execute is an unreachable guard that fails closed", async () => {
    // Control-plane tools dispatch via the DO, never through this executor. If
    // it ever runs, routing regressed — it must fail, not silently succeed.
    for (const tool of habenula.tools) {
      const result = await tool.execute({}, { userId: "u1" });
      expect(result.success).toBe(false);
    }
  });
});
