// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { LLMToolInputSchema } from "../llm/types.js";

/**
 * Context handed to a tool's execute function. Carries the one credential the
 * tool's `service` declared — resolved and injected by the caller
 * (dispatchTool), never resolved by the executor itself. No resolve capability
 * and no refresh secret reach the executor, so an executor can only ever see
 * its own service's credential (type-level isolation).
 */
export interface ExecuteContext {
  userId: string;
  /** Resolved by the caller for the tool's service. */
  credential?: StoredCredential;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The money-verb descriptor. Its PRESENCE on a `Tool` is the verb-class
 * marker the spending cap keys off (no verb enum exists, so
 * the field is the classification mechanism, and every later paid service
 * inherits the cap by declaring it).
 *
 * Two obligations on whoever declares it:
 *
 * - `quotedAmountCents` decodes the bound quote's total from the call's
 *   params. SYNCHRONOUS by contract — the governance pipeline is synchronous,
 *   so no I/O and no crypto (signature VERIFICATION is the service's job at
 *   commit). `null` means the amount could not be decoded and the engine holds
 *   the call `unpriced`. The decoded value must be an UPPER BOUND on what
 *   `execute` can charge: the cap is enforced against this number, so a
 *   service that can charge more than it decodes defeats the cap.
 * - `commitKeys` names the identity the ledger dedupes on, so the engine never
 *   hardcodes one service's parameter spelling. The pair must be stable for a
 *   retry of the same commit and distinct for a genuinely new one — the ledger
 *   is unique on it, and two different spends sharing a pair means the second
 *   is silently uncounted, which is a cap bypass.
 */
export interface ToolSpend {
  quotedAmountCents: (params: Record<string, unknown>) => number | null;
  /**
   * A short human-readable description of what the call buys, for the
   * confirmation surface — a user must never be asked to authorize a charge
   * they cannot inspect. Derived from the service's OWN bound quote, never
   * from raw model text, so the engine may render it as trusted chrome.
   * Sync, like the amount decode. Omit if the service has nothing to show.
   */
  describe?: (params: Record<string, unknown>) => string | null;
  commitKeys: (params: Record<string, unknown>) => {
    quoteId: string;
    idempotencyKey: string;
  };
}

/**
 * One concrete tool: a (service, verb) pair plus everything the tool surface,
 * governance, and dispatch need. The tool's opaque public name is derived from
 * (service, verb) by `toolName()` — never re-derived by splitting on `_`,
 * which would mis-resolve `mock_email_list` to service `mock`.
 */
export interface Tool {
  service: string;
  verb: string;
  /** LLM-facing description; names the concrete service. */
  description: string;
  /**
   * The published data-slot vocabulary for this verb class:
   * Habenula-authored informational slots a commissioning client may
   * supply verbatim values under (`{{data.<key>}}` binding). Curated copy —
   * never derived from the input schema; surfaced in the capability manifest.
   */
  dataSlots?: { key: string; description: string; required?: boolean }[];
  /**
   * The OAuth scopes any ONE of which satisfies this tool's capability.
   * Capability coverage, not exact-string
   * membership — a broader scope (gmail.modify) satisfies a narrower
   * capability (read). Absent = no scope gate; the pre-policy scope
   * precondition in executeTool runs only when this is set.
   */
  requiredScopes?: string[];
  /** Present on the money verb — see {@link ToolSpend}. */
  spend?: ToolSpend;
  inputSchema: LLMToolInputSchema;
  nounExtractor: (params: Record<string, unknown>) => string;
  execute: (
    params: Record<string, unknown>,
    ctx: ExecuteContext,
  ) => Promise<ToolExecutionResult>;
}
