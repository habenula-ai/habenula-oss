// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LLMToolInputSchema } from "../../llm/types.js";
import type { Tool } from "../../tools/types.js";
import {
  DEFAULT_EMAIL_LIST_MAX_RESULTS,
  EMAIL_LIST_MAX_RESULTS_CEILING,
  isEmailListMaxResults,
} from "./email.js";

/**
 * The params a search-style email tool's `execute` body receives,
 * pre-validated and with the page-size default applied. The query string is
 * free-form (Gmail query syntax); the page-size contract is the shared one
 * every list-shaped fanout obeys (see EMAIL_LIST_MAX_RESULTS_CEILING).
 */
export interface EmailSearchParams {
  q: string;
  maxResults: number;
}

/**
 * The noun a search call is governed as: the mailbox/label the query resolves
 * to, or `anywhere` when unfiltered. The free-form
 * `q` is a poor grant key — every query differs — so it is audited as
 * parameter metadata, never the noun.
 *
 * Recognized system labels resolve to their Gmail label ID (Gmail's draft
 * label id is singular DRAFT — same quirk as the list vocabulary). Keyed by
 * the full `operator:name` token, so a status filter like `is:unread` (not a
 * mailbox) never becomes a noun.
 */
const SEARCH_SYSTEM_LABEL_IDS: Record<string, string> = {
  "in:inbox": "INBOX",
  "in:sent": "SENT",
  "in:drafts": "DRAFT",
  "in:spam": "SPAM",
  "in:trash": "TRASH",
  "label:inbox": "INBOX",
  "label:sent": "SENT",
  "label:drafts": "DRAFT",
  "label:spam": "SPAM",
  "label:trash": "TRASH",
  "label:starred": "STARRED",
  "label:important": "IMPORTANT",
  "is:starred": "STARRED",
  "is:important": "IMPORTANT",
};

/** The mailbox-filter tokens the noun resolver owns (in:/label:/is:). */
const MAILBOX_FILTER_TOKEN = /^(in|label|is):(.+)$/;

/**
 * A quoted or parenthesized mailbox-filter value (`in:"sent"`,
 * `label:"my label"`): Gmail resolves it after unquoting, which a
 * whitespace tokenizer cannot see, so the resolver must not guess.
 */
const UNTOKENIZABLE_FILTER_VALUE = /["()]/;

/**
 * A search query's mailbox filters, resolved for governance — and, for
 * executors that honor the noun (the mock), the searched-set contract.
 */
export interface EmailSearchQuery {
  /**
   * The resolved mailbox tokens: system label IDs, or `label:<name>` for
   * non-system (user) labels — which cannot resolve to their `Label_<n>` id
   * without a fetch, and can never collide with the `read` sentinel
   * (`mailbox`) or a system ID.
   */
  mailboxes: Set<string>;
  /**
   * True when the search is account-wide: an explicit `in:anywhere`, or
   * query syntax the tokenizer cannot soundly narrow — Gmail's disjunction
   * (`OR`) and `{}` grouping, or a quoted/parenthesized mailbox-filter
   * value. Under those, a mailbox filter no longer bounds the searched set
   * (`in:sent OR from:x` reads the whole account), so narrowing that cannot
   * be proven must over-claim to `anywhere`, never under-claim.
   */
  anywhere: boolean;
  /**
   * Every token that is not a mailbox filter, lowercased: bare terms plus
   * non-mailbox operators (`from:alice`, `is:unread`, `has:attachment`).
   * The noun ignores these; the mock's executor consumes them.
   */
  rest: string[];
}

/**
 * Parse a search query's mailbox filters, synchronously and with no network.
 * Shared by the noun resolver and the mock's
 * executor so the searched set can never exceed what the noun claims.
 */
export function parseEmailSearchQuery(q: unknown): EmailSearchQuery {
  const mailboxes = new Set<string>();
  let anywhere = false;
  const rest: string[] = [];
  if (typeof q !== "string") {
    return { mailboxes, anywhere, rest };
  }
  for (const token of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    // Disjunction and grouping syntax defeat mailbox narrowing wholesale.
    // Gmail documents OR as uppercase-only, but the resolver treats any case
    // as disjunctive — if Gmail were lenient where we were strict, a narrow
    // noun would cover an account-wide search. Syntax tokens never become
    // search terms; they are dropped, not pushed to rest.
    if (token === "or" || token.includes("{") || token.includes("}")) {
      anywhere = true;
      continue;
    }
    const match = MAILBOX_FILTER_TOKEN.exec(token);
    if (!match) {
      rest.push(token);
      continue;
    }
    const operator = match[1]!;
    const name = match[2]!;
    if (UNTOKENIZABLE_FILTER_VALUE.test(name)) {
      anywhere = true;
      continue;
    }
    if (operator === "in" && name === "anywhere") {
      anywhere = true;
      continue;
    }
    const systemId = SEARCH_SYSTEM_LABEL_IDS[`${operator}:${name}`];
    if (systemId) {
      mailboxes.add(systemId);
    } else if (operator === "is") {
      // `is:` values beyond starred/important are status filters (is:unread),
      // not mailboxes — they never contribute a noun; executors see them in
      // `rest`.
      rest.push(token);
    } else {
      mailboxes.add(`label:${name}`);
    }
  }
  return { mailboxes, anywhere, rest };
}

/**
 * Resolve a search query to its governable mailbox noun. Multiple filters
 * sort-join; no mailbox filter at all — or an explicit `in:anywhere`, which
 * subsumes any narrower filter — resolves to `anywhere`. So does any query
 * whose narrowing the parse cannot prove (OR / braces / quoted filter
 * values, see EmailSearchQuery.anywhere): the noun then demands the widest
 * consent instead of letting a narrow grant cover a wider search. Negation
 * (`-in:spam`) passes through untouched — it only ever narrows.
 */
export function emailSearchNoun(q: unknown): string {
  const { mailboxes, anywhere } = parseEmailSearchQuery(q);
  if (anywhere || mailboxes.size === 0) {
    return "anywhere";
  }
  return [...mailboxes].sort().join(",");
}

/** The default `q` description: Gmail query syntax (the builder's original
 * vocabulary; Gmail and the mock share it). */
const DEFAULT_Q_DESCRIPTION =
  "Search query in Gmail query syntax, e.g. `from:alice subject:invoice in:inbox`. Supports from:, to:, subject:, in:, label:, is:, and bare terms.";

function emailSearchInputSchema(qDescription: string): LLMToolInputSchema {
  return {
    type: "object",
    properties: {
      q: {
        type: "string",
        description: qDescription,
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: EMAIL_LIST_MAX_RESULTS_CEILING,
        description: `Maximum number of messages to return. Defaults to ${DEFAULT_EMAIL_LIST_MAX_RESULTS}, at most ${EMAIL_LIST_MAX_RESULTS_CEILING}.`,
      },
    },
    required: ["q"],
  };
}

/**
 * Build a search-style email `Tool` from its `execute` body, mirroring
 * emailListCapability: the builder owns the executor scaffolding every search
 * tool repeats — credential-presence check, param validation, and the
 * try/catch that wraps a thrown error into `{ success: false, error }` — so a
 * service supplies only its name, description, scope requirement, and the
 * call that produces the data (real API vs. canned). Gmail and the mock share
 * one schema and one noun resolver, so the governed shape cannot drift
 * between them (mock parity).
 *
 * The defaults speak Gmail: `q` is described as Gmail query syntax and the
 * noun resolves through emailSearchNoun's mailbox-filter parse. A provider
 * whose search language differs overrides both (`qDescription`,
 * `nounExtractor`) while keeping the scaffolding — Outlook's Graph `$search`
 * has no `in:`/`label:` to narrow on, so it supplies a constant-`anywhere`
 * extractor.
 */
export function emailSearchCapability(opts: {
  service: string;
  description: string;
  /** Threaded onto the returned Tool (see Tool.requiredScopes). */
  requiredScopes?: string[];
  /** Override the governed noun; default resolves emailSearchNoun over `q`. */
  nounExtractor?: Tool["nounExtractor"];
  /** Override the model-facing `q` description; default is Gmail syntax. */
  qDescription?: string;
  execute: (
    token: string,
    params: EmailSearchParams,
  ) => Promise<unknown> | unknown;
}): Tool {
  return {
    service: opts.service,
    verb: "search",
    description: opts.description,
    requiredScopes: opts.requiredScopes,
    inputSchema: emailSearchInputSchema(
      opts.qDescription ?? DEFAULT_Q_DESCRIPTION,
    ),
    nounExtractor:
      opts.nounExtractor ?? ((params) => emailSearchNoun(params.q)),
    execute: async (params, ctx) => {
      const token = ctx.credential?.access_token;
      if (!token) {
        return {
          success: false,
          error: `No credential found for service: ${opts.service}`,
        };
      }
      const q = params.q;
      if (typeof q !== "string" || q.trim().length === 0) {
        return {
          success: false,
          error: "Invalid parameter: q must be a non-empty string",
        };
      }
      const maxResults = params.maxResults ?? DEFAULT_EMAIL_LIST_MAX_RESULTS;
      if (!isEmailListMaxResults(maxResults)) {
        return {
          success: false,
          error: `Invalid parameter: maxResults must be an integer between 1 and ${EMAIL_LIST_MAX_RESULTS_CEILING}`,
        };
      }
      try {
        const data = await opts.execute(token, { q, maxResults });
        return { success: true, data };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tool execution failed";
        return { success: false, error: message };
      }
    },
  };
}
