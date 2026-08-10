import { describe, it, expect } from "vitest";
import { buildToolDefinitions } from "../../src/llm/tool-definitions";
import { listTools, lookupTool, toolName } from "@habenula-ai/tools";

const ALL_SERVICES = ["gmail", "mock_email", "slack", "google_calendar", "github", "outlook_mail"];

// The catalog now carries the `habenula` control-plane service, which is gated
// on `allowControlPlane`. The default surface (no options,
// or allowControlPlane:false) is external-only; control-plane tools appear only
// when explicitly allowed. Split the expectations accordingly.
const CONTROL_PLANE_TOOL_NAMES = listTools()
  .filter((t) => t.service === "habenula")
  .map(toolName);
const EXTERNAL_TOOL_NAMES = listTools()
  .filter((t) => t.service !== "habenula")
  .map(toolName);
const ALL_TOOL_NAMES = listTools().map(toolName);

describe("buildToolDefinitions (full catalog, tagged by connection)", () => {
  it("surfaces every external tool regardless of what is connected", () => {
    // "notion" is the unknown-service sentinel: a name with no catalog entry
    // (slack graduated to a registered service and can no longer play it).
    for (const connected of [[], ["gmail"], ["notion"], ALL_SERVICES]) {
      const names = buildToolDefinitions(connected).map((t) => t.name).sort();
      expect(names).toEqual([...EXTERNAL_TOOL_NAMES].sort());
    }
  });

  it("tags connected services [CONNECTED] and the rest [NOT CONNECTED]", () => {
    const byName = new Map(
      buildToolDefinitions(["gmail"]).map((t) => [t.name, t.description]),
    );
    expect(byName.get("gmail_list")).toMatch(/^\[CONNECTED\] /);
    expect(byName.get("mock_email_list")).toMatch(/^\[NOT CONNECTED\] /);
  });

  it("tags every external tool [NOT CONNECTED] for a fresh user with nothing connected", () => {
    const tools = buildToolDefinitions([]);
    expect(tools.map((t) => t.name).sort()).toEqual([...EXTERNAL_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description).toMatch(/^\[NOT CONNECTED\] /);
    }
  });

  it("an unknown connected service marks nothing connected", () => {
    for (const tool of buildToolDefinitions(["notion"])) {
      expect(tool.description).toMatch(/^\[NOT CONNECTED\] /);
    }
  });

  it("each emitted tool resolves back to a registry entry", () => {
    for (const tool of buildToolDefinitions(ALL_SERVICES, { allowControlPlane: true })) {
      expect(lookupTool(tool.name)).not.toBeNull();
    }
  });
});

describe("buildToolDefinitions control-plane gate", () => {
  it("has control-plane tools to gate (guards the split above)", () => {
    // If the habenula service were ever unregistered, the gate assertions would
    // vacuously pass — anchor them on the service actually existing.
    expect(CONTROL_PLANE_TOOL_NAMES.length).toBe(5);
    expect([...CONTROL_PLANE_TOOL_NAMES].sort()).toEqual(
      ["habenula_disconnect", "habenula_kill", "habenula_quit", "habenula_read", "habenula_status"],
    );
  });

  it("omits control-plane tools by default (fail-closed — no options)", () => {
    const names = buildToolDefinitions(ALL_SERVICES).map((t) => t.name);
    for (const cp of CONTROL_PLANE_TOOL_NAMES) {
      expect(names).not.toContain(cp);
    }
  });

  it("omits control-plane tools when allowControlPlane is explicitly false", () => {
    const names = buildToolDefinitions(ALL_SERVICES, { allowControlPlane: false }).map(
      (t) => t.name,
    );
    for (const cp of CONTROL_PLANE_TOOL_NAMES) {
      expect(names).not.toContain(cp);
    }
  });

  it("includes control-plane tools when allowControlPlane is true", () => {
    const names = buildToolDefinitions(ALL_SERVICES, { allowControlPlane: true })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("tags control-plane tools [CONNECTED] even when nothing is connected (no OAuth credential)", () => {
    // habenula holds no credential, so it must never read as [NOT CONNECTED].
    const byName = new Map(
      buildToolDefinitions([], { allowControlPlane: true }).map((t) => [
        t.name,
        t.description,
      ]),
    );
    for (const cp of CONTROL_PLANE_TOOL_NAMES) {
      expect(byName.get(cp)).toMatch(/^\[CONNECTED\] /);
    }
  });
});

describe("Tool Definitions (derived surface shape)", () => {
  it("has no duplicate tool names", () => {
    const names = buildToolDefinitions(ALL_SERVICES, { allowControlPlane: true }).map(
      (t) => t.name,
    );
    expect(names).toEqual([...new Set(names)]);
  });

  it("every definition carries a status tag plus a non-empty description", () => {
    for (const tool of buildToolDefinitions(ALL_SERVICES, { allowControlPlane: true })) {
      expect(tool.description).toMatch(/^\[(CONNECTED|NOT CONNECTED)\] \S/);
    }
  });

  it("every definition has an object input_schema", () => {
    for (const tool of buildToolDefinitions(ALL_SERVICES, { allowControlPlane: true })) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.properties).toBeDefined();
    }
  });
});
