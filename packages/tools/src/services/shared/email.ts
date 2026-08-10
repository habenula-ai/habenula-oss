// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LLMToolInputSchema } from "../../llm/types.js";
import type { Tool } from "../../tools/types.js";

/**
 * Upper bound on maxResults, shared by every list tool so identical governed
 * params behave identically across services. The value is sized to the Gmail
 * executor's N+1 fanout — one metadata subrequest per listed message inside a
 * single Worker invocation — so raising it spends the Worker subrequest
 * budget, not just Gmail quota.
 */
export const EMAIL_LIST_MAX_RESULTS_CEILING = 20;

/** Default page size when maxResults is omitted or null. Shared: the size
 * contract does not vary by service (only the label vocabulary does). */
export const DEFAULT_EMAIL_LIST_MAX_RESULTS = 5;

/**
 * The one definition of a valid maxResults — an integer between 1 and the
 * shared ceiling. The builder and assertEmailListParams both delegate here,
 * so the range rule cannot drift between the input-error path and the
 * direct-caller guard. Unlike the label vocabulary, this contract is shared
 * across every service.
 */
export function isEmailListMaxResults(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= EMAIL_LIST_MAX_RESULTS_CEILING
  );
}

/**
 * The params a list-style email tool's `execute` body receives, pre-validated
 * and with defaults applied — both fields are always present. `L` is the
 * calling service's own label vocabulary (a `const` tuple's union): Gmail's
 * system mailboxes are wider than the mock's onboarding set, so the label
 * vocabulary is per-service, not a single shared enum. A label added to a
 * service's vocabulary is a tsc error at that service's provider map until it
 * is handled. maxResults stays a plain number governed by the shared ceiling.
 * Provider clients stay provider-native (see services/google).
 */
export interface EmailListParams<L extends string = string> {
  label: L;
  maxResults: number;
}

/**
 * Direct-caller defense for executor input: a JS or cast caller can pass
 * anything despite the EmailListParams types, so executors re-assert what the
 * builder already validated against the *same* per-service vocabulary — a
 * label the service accepts (an includes-based check, so prototype keys like
 * "constructor" stay out of the executors' map lookups) and an integer
 * maxResults between 1 and the shared ceiling (which NaN math, slice(), or a
 * provider-side cap would otherwise turn into a wrong request or a silent
 * over- or under-return).
 */
export function assertEmailListParams<L extends string>(
  params: EmailListParams<L>,
  labels: readonly L[],
): void {
  if (!(labels as readonly unknown[]).includes(params.label)) {
    throw new Error(`Unknown mailbox label: ${String(params.label)}`);
  }
  if (!isEmailListMaxResults(params.maxResults)) {
    throw new Error(`Invalid maxResults: ${String(params.maxResults)}`);
  }
}

/**
 * The single site where the defaulting rule lives: null and omitted map to
 * the service default label / shared page size; everything else passes
 * through verbatim. Both readers of raw params — the noun extractor (what is
 * audited) and the builder's execute (what runs) — normalize here first with
 * the same defaultLabel, so they cannot disagree on what an omitted param
 * means. Deliberately defaults-only, never validating: an invalid explicit
 * label must flow through so the noun audits what the caller actually sent
 * (the noun contract).
 */
function normalizeEmailListParams(
  params: Record<string, unknown>,
  defaultLabel: string,
): {
  label: unknown;
  maxResults: unknown;
} {
  // `??` alone would let an explicit empty- or whitespace-only string through as
  // the label. The nounExtractor then emits String("") = "" — an EMPTY governance
  // noun, which mandatory noun binding forbids, and which breaks the
  // "noun == executed value" contract the executor relies on (an empty label is
  // not in any service's enum, so it would also fail execution). Treat a blank
  // label as unspecified → default, so an omitted, null, or blank label all bind
  // and execute as the same default mailbox.
  const rawLabel = params.label;
  const label =
    typeof rawLabel === "string" && rawLabel.trim() === ""
      ? defaultLabel
      : (rawLabel ?? defaultLabel);
  return {
    label,
    maxResults: params.maxResults ?? DEFAULT_EMAIL_LIST_MAX_RESULTS,
  };
}

/**
 * Build the model-facing input schema from a service's own vocabulary. The
 * enum and the default in the description are derived from the same `labels`
 * and `defaultLabel` the builder validates against, so what the model is told
 * and what the builder enforces cannot disagree.
 */
function emailListInputSchema(
  labels: readonly string[],
  defaultLabel: string,
): LLMToolInputSchema {
  return {
    type: "object",
    properties: {
      label: {
        type: "string",
        enum: [...labels],
        description: `Mailbox label to list. Defaults to ${defaultLabel} if not specified.`,
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: EMAIL_LIST_MAX_RESULTS_CEILING,
        description: `Maximum number of messages to return. Defaults to ${DEFAULT_EMAIL_LIST_MAX_RESULTS}, at most ${EMAIL_LIST_MAX_RESULTS_CEILING}.`,
      },
    },
  };
}

/**
 * Build a list-style email `Tool` from its per-service vocabulary and
 * `execute` body. The builder owns the executor scaffolding every list tool
 * repeats — the credential-presence check, the param validation, and the
 * try/catch that wraps a thrown error into the standard
 * `{ success: false, error }` — so a service supplies only what genuinely
 * varies: its name, the mailbox labels it accepts (`labels`) and which one it
 * defaults to (`defaultLabel`), its LLM-facing description, and the call that
 * produces the data (real API vs. canned). The label vocabulary is validated,
 * schema-declared, and audited from the one `labels`/`defaultLabel` pair, so a
 * service that accepts more mailboxes than another cannot have them drift out
 * of sync.
 */
export function emailListCapability<L extends string>(opts: {
  service: string;
  labels: readonly L[];
  defaultLabel: L;
  description: string;
  /** Threaded onto the returned Tool (see Tool.requiredScopes). Omitted = no
   * scope gate — existing callers are unaffected until they opt in. */
  requiredScopes?: string[];
  execute: (
    token: string,
    params: EmailListParams<L>,
  ) => Promise<unknown> | unknown;
}): Tool {
  const { labels, defaultLabel } = opts;
  return {
    service: opts.service,
    verb: "list",
    description: opts.description,
    requiredScopes: opts.requiredScopes,
    // The one live data slot: ships the
    // {{data.<key>}} mechanism exercised; write-shaped tools grow the set.
    dataSlots: [
      { key: "mailbox", description: "A mailbox label to list, e.g. INBOX." },
    ],
    inputSchema: emailListInputSchema(labels, defaultLabel),
    // Bound to this service's default so the audited noun matches the mailbox
    // this service actually lists for an omitted label.
    nounExtractor: (params) =>
      String(normalizeEmailListParams(params, defaultLabel).label),
    execute: async (params, ctx) => {
      const token = ctx.credential?.access_token;
      if (!token) {
        return {
          success: false,
          error: `No credential found for service: ${opts.service}`,
        };
      }
      // The input schema is advisory to the LLM, not enforced upstream —
      // dispatch passes the model's params through as-is. Validate here so a
      // schema-violating value fails as an input error instead of leaking NaN
      // semantics into the executor (Gmail 400; mock slice(0, NaN) → []).
      // Defaults come from normalizeEmailListParams, the same site the noun
      // extractor reads, so an omitted or null param is governed, audited,
      // and executed as the same value.
      const { label, maxResults } = normalizeEmailListParams(
        params,
        defaultLabel,
      );
      if (!(labels as readonly unknown[]).includes(label)) {
        return {
          success: false,
          error: `Invalid parameter: label must be one of ${labels.join(", ")}`,
        };
      }
      if (!isEmailListMaxResults(maxResults)) {
        return {
          success: false,
          error: `Invalid parameter: maxResults must be an integer between 1 and ${EMAIL_LIST_MAX_RESULTS_CEILING}`,
        };
      }
      try {
        const data = await opts.execute(token, {
          label,
          maxResults,
        } as EmailListParams<L>);
        return { success: true, data };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tool execution failed";
        return { success: false, error: message };
      }
    },
  };
}
