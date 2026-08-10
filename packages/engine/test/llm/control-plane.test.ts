// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { listTools, toolName } from "@habenula-ai/tools";
import {
  CONTROL_PLANE_REFUSAL,
  CONTROL_PLANE_SERVICE,
  controlPlaneAllowed,
  isControlPlaneTool,
} from "../../src/llm/control-plane";
import type { RunOrigin } from "../../src/llm/conversation";

/**
 * The boundary predicate both halves consult — the offered tool surface and the
 * dispatch gate. Kept as a unit test because the predicate's whole value is that
 * exactly one origin passes it: a second one slipping in is the shape of the
 * defect it exists to prevent.
 */

const ALL_ORIGINS: RunOrigin[] = ["internal", "human", "commission"];

describe("controlPlaneAllowed", () => {
  it("admits `internal` and nothing else", () => {
    expect(ALL_ORIGINS.filter(controlPlaneAllowed)).toEqual(["internal"]);
  });

  it("refuses the locality-gated local surface — network locality is not authorization", () => {
    expect(controlPlaneAllowed("human")).toBe(false);
  });

  it("refuses the inbound commission surface", () => {
    expect(controlPlaneAllowed("commission")).toBe(false);
  });
});

describe("isControlPlaneTool", () => {
  it("is true for every registered habenula tool, and only those", () => {
    const registered = listTools();
    const control = registered
      .filter((t) => t.service === CONTROL_PLANE_SERVICE)
      .map(toolName);
    // The catalog has some — otherwise the assertion below proves nothing.
    expect(control.length).toBeGreaterThan(0);
    for (const name of control) expect(isControlPlaneTool(name)).toBe(true);
    for (const tool of registered) {
      if (tool.service === CONTROL_PLANE_SERVICE) continue;
      expect(isControlPlaneTool(toolName(tool))).toBe(false);
    }
  });

  it("is false for a name the registry does not hold", () => {
    // An unregistered name is not a control-plane tool: it keeps travelling the
    // ordinary unknown-tool path rather than being refused with the wrong reason.
    expect(isControlPlaneTool("habenula_wat")).toBe(false);
    expect(isControlPlaneTool("")).toBe(false);
  });
});

describe("CONTROL_PLANE_REFUSAL", () => {
  it("is fixed engine vocabulary a log reader can key on", () => {
    expect(CONTROL_PLANE_REFUSAL).toContain("trusted internal surface");
  });
});
