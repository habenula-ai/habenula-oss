// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * At launch, the engine runs a single hardcoded agent. Every boundary that reaches the DO —
 * the REST handlers and the /mcp commission surface — passes this one
 * identity so agent attribution is uniform within a session.
 */
export const PHASE0_AGENT_ID = "onboarding";
