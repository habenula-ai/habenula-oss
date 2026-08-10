// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  assertEmailListParams,
  emailListCapability,
  type EmailListParams,
} from "../shared/email.js";
import { emailSearchCapability } from "../shared/email-search.js";
import { emailSendCapability } from "../shared/email-send.js";
import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
import type { GraphDeps } from "./graph.js";
import {
  executeOutlookMailGet,
  executeOutlookMailList,
  executeOutlookMailSearch,
  executeOutlookMailSend,
  type OutlookMailListResult,
} from "./outlook-mail-client.js";

export * from "./outlook-mail-client.js";

/**
 * Outlook's list-tool vocabulary: Graph well-known folder names, usable
 * verbatim in the URL path — no Gmail-style DRAFTS → DRAFT translation
 * table. Gmail's STARRED / IMPORTANT have no folder analogue (they are
 * flags, not folders) and are omitted.
 */
export const OUTLOOK_MAIL_FOLDERS = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "junkemail",
  "archive",
] as const;

export type OutlookMailFolder = (typeof OUTLOOK_MAIL_FOLDERS)[number];

/**
 * Capability → the delegated Graph scopes ANY ONE of which grants it, in the
 * canonical form normalizeGraphScope stores (the scope gate matches exact
 * strings, so both sides of the comparison declare the same form).
 * `mail.readwrite` is forward-compat: nothing currently
 * requests it, but a later Microsoft service consenting ReadWrite must
 * satisfy read with no map edit (broader covers narrower).
 */
export const OUTLOOK_MAIL_CAPABILITY_SCOPES: Record<
  "read" | "send",
  string[]
> = {
  read: ["mail.read", "mail.readwrite"],
  send: ["mail.send"],
};

/**
 * The wire-form scopes sent to the authorize endpoint — least privilege
 * (no User.Read: nothing here reads account
 * identity). `offline_access` is provider-level, not a service choice:
 * without it Entra issues no refresh token and every Microsoft service
 * silently becomes re-connect-on-expiry; every future Microsoft service's
 * scope list carries it too.
 */
export const OUTLOOK_MAIL_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
];

/**
 * Adapt the shared tool contract to the Graph-native client: re-assert the
 * params (direct-caller defense) against Outlook's own vocabulary, then pass
 * the folder verbatim — it IS the Graph path segment. Async so the assert's
 * throw surfaces as a rejection, matching the client's own contract.
 */
export async function outlookMailListExecute(
  token: string,
  params: EmailListParams<OutlookMailFolder>,
  deps?: GraphDeps,
): Promise<OutlookMailListResult> {
  assertEmailListParams(params, OUTLOOK_MAIL_FOLDERS);
  return executeOutlookMailList(
    token,
    { folder: params.label, maxResults: params.maxResults },
    deps,
  );
}

/** Outlook Mail list tool — authenticates with the injected credential. */
export const OUTLOOK_MAIL_LIST: Tool = emailListCapability({
  service: "outlook_mail",
  labels: OUTLOOK_MAIL_FOLDERS,
  defaultLabel: "inbox",
  description:
    "List email messages from the user's Outlook mailbox. Returns message metadata (subject, sender, date).",
  requiredScopes: OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
  execute: outlookMailListExecute,
});

/**
 * Map a thrown executor error to the tool's failure result — the identical
 * tail every executor shares. A `GraphApiError` carries the Graph status in
 * its message; anything else degrades to a generic string.
 */
function outlookMailToolError(err: unknown): ToolExecutionResult {
  return {
    success: false,
    error: err instanceof Error ? err.message : "Tool execution failed",
  };
}

/**
 * Outlook Mail read tool — full message content by id. Governed as the
 * constant account-level sentinel noun `mailbox`, the same shape Gmail uses:
 * read is consented per account/session, not per message, and the message id
 * is audited as parameter metadata. The sentinel cannot collide with a list
 * noun: no Graph well-known folder is named `mailbox` — re-derived for
 * Outlook's lowercase vocabulary (asserted in outlook-mail.test.ts), not
 * inherited from Gmail's uppercase convention.
 */
export const OUTLOOK_MAIL_READ: Tool = {
  service: "outlook_mail",
  verb: "read",
  description:
    "Read the full content (body and headers) of one email message from the user's Outlook mailbox, by message id — e.g. an id returned by outlook_mail_search.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: {
        type: "string",
        description: "The Outlook message id to read.",
      },
    },
    required: ["messageId"],
  },
  nounExtractor: () => "mailbox",
  requiredScopes: OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return {
        success: false,
        error: "No credential found for service: outlook_mail",
      };
    }
    const messageId = params.messageId;
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      return {
        success: false,
        error: "Invalid parameter: messageId must be a non-empty string",
      };
    }
    try {
      const data = await executeOutlookMailGet(token, { messageId });
      return { success: true, data };
    } catch (err) {
      return outlookMailToolError(err);
    }
  },
};

/**
 * Outlook Mail search tool — Graph `$search` over the account. Governed as
 * the constant `anywhere`: Graph $search is whole-mailbox with no `in:` /
 * `label:` operators for the shared resolver to narrow on, so every search
 * is a whole-mailbox read even when the query looks narrowing — a deliberate
 * reduction in policy expressiveness versus Gmail (a user cannot grant
 * "search only folder X"); folder-scoped search is deferred future work.
 * The raw `q` is audited as parameter metadata.
 */
export const OUTLOOK_MAIL_SEARCH: Tool = emailSearchCapability({
  service: "outlook_mail",
  description:
    "Search email messages across the user's whole Outlook mailbox. Returns message metadata (id, subject, sender, date); use outlook_mail_read with a returned id for full content.",
  requiredScopes: OUTLOOK_MAIL_CAPABILITY_SCOPES.read,
  nounExtractor: () => "anywhere",
  qDescription:
    "Search query in Microsoft Graph $search (KQL) syntax, e.g. `from:alice subject:invoice` or free text. Supports from:, to:, subject:, and bare terms; always searches the whole mailbox (no folder filter).",
  execute: (token, params) => executeOutlookMailSearch(token, params),
});

/**
 * Outlook Mail send tool — a consequential verb, governed as the exact
 * recipient-address set across to+cc+bcc via the shared factory: the
 * cross-provider noun contract, reused verbatim (the
 * same grant semantics Gmail shows, on a non-Google provider).
 */
export const OUTLOOK_MAIL_SEND: Tool = emailSendCapability({
  service: "outlook_mail",
  description:
    "Send a new email message from the user's Outlook account. Requires the user's confirmation unless a matching grant exists for the exact recipient addresses. Outlook accepts the message for delivery asynchronously — the result reports acceptance, not delivery.",
  requiredScopes: OUTLOOK_MAIL_CAPABILITY_SCOPES.send,
  execute: (token, params) => executeOutlookMailSend(token, params),
});

/**
 * The outlook_mail service: declarative data only. Its OAuth machinery lives
 * on the `microsoft` provider strategy; outlook_mail contributes just its
 * scopes and tools (the harness-generalization property — the next
 * Microsoft service adds a sibling entry, no provider work).
 */
export const outlookMail: ServiceDefinition = {
  service: "outlook_mail",
  connect: {
    type: "oauth",
    provider: "microsoft",
    scopes: OUTLOOK_MAIL_SCOPES,
  },
  tools: [
    OUTLOOK_MAIL_LIST,
    OUTLOOK_MAIL_READ,
    OUTLOOK_MAIL_SEARCH,
    OUTLOOK_MAIL_SEND,
  ],
};
