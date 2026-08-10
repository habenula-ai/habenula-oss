// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { SERVICES } from "../services/catalog.js";
import type { Tool } from "./types.js";

/**
 * Every registered tool, derived by flattening the service catalog's `tools`
 * in catalog order. The catalog is the single source of truth; there is no
 * separate flat list. `toolName` uniqueness across the result is asserted by
 * the test suite, not at module load.
 *
 * Recomputed per call rather than memoized into a module `const`. This was
 * considered in review and deliberately left as-is: every `lookupTool`
 * call is gated behind an LLM round-trip plus an MCP network call, so even at
 * hundreds of tools the flatMap allocation is microseconds against a baseline
 * of hundreds of ms — unmeasurable. If lookup ever becomes hot, the right fix
 * is an O(1) `Map<toolName, Tool>` built once, not memoizing this O(n) scan.
 */
function allTools(): Tool[] {
  return SERVICES.flatMap((service) => service.tools);
}

/**
 * The tool's opaque public name, by convention `${service}_${verb}`. This is
 * the name the LLM sees and the key dispatch resolves. Generation in this
 * direction is unambiguous; the name is never parsed back by splitting on `_`.
 */
export function toolName(tool: Tool): string {
  return `${tool.service}_${tool.verb}`;
}

/** Resolve a tool name to its tool by scanning the registry — no parsing. */
export function lookupTool(name: string): Tool | null {
  return allTools().find((tool) => toolName(tool) === name) ?? null;
}

/** All registered tools, in catalog order. */
export function listTools(): Tool[] {
  return allTools();
}

/**
 * The published data-slot vocabulary — every `dataSlots` key across the
 * registry, with its description. Shared by the MCP
 * boundary (which rejects unknown keys naming this vocabulary) and
 * `commissionGoal`'s own fail-closed validation, so the DO never trusts the
 * boundary alone (0028B review F4).
 */
export function publishedDataSlots(): Map<string, string> {
  const slots = new Map<string, string>();
  for (const tool of allTools()) {
    for (const slot of tool.dataSlots ?? []) {
      // {{data.<key>}} binding only recognizes this shape; a key outside it
      // would pass the known-key check yet never substitute — fail loudly at
      // first use instead of silently at bind time.
      if (!/^[A-Za-z0-9_-]+$/.test(slot.key)) {
        throw new Error(`unbindable dataSlot key: ${slot.key}`);
      }
      slots.set(slot.key, slot.description);
    }
  }
  return slots;
}

