// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  assertEmailListParams,
  emailListCapability,
  type EmailListParams,
} from "../shared/email.js";
import { emailSearchCapability } from "../shared/email-search.js";
import {
  emailSendCapability,
  normalizeEmailEnvelope,
} from "../shared/email-send.js";
import { recipientAddressesNoun } from "../shared/recipients.js";
import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
import {
  executeGmailDraft,
  executeGmailGet,
  executeGmailList,
  executeGmailModify,
  executeGmailReply,
  executeGmailSearch,
  executeGmailSend,
  executeGmailTrash,
  type GmailListResult,
  type GmailModifyResult,
} from "./gmail-client.js";

export * from "./gmail-client.js";

/**
 * The capability classes Gmail tools declare. A
 * capability names what a tool needs from the credential; the map below says
 * which granted scopes cover it.
 */
export type GmailCapability =
  | "read"
  | "send"
  | "draft"
  | "modify-labels"
  | "trash";

/**
 * Gmail's umbrella scope — full mailbox access, including permanent delete.
 * Habenula never requests it, but a credential can only be judged by what it
 * actually holds: the broadest scope must satisfy every capability, or
 * "broader covers narrower" fails exactly at the top.
 */
const GMAIL_FULL_ACCESS = "https://mail.google.com/";

/**
 * Capability → the Gmail OAuth scopes ANY ONE of which grants it.
 * Gmail's scopes are overlapping supersets —
 * `gmail.modify` authorizes read, draft, send, label, and trash;
 * `gmail.compose` authorizes draft and send — so the scope precondition
 * checks capability coverage, never exact-string membership. Each Gmail tool
 * sets `requiredScopes` from this map; the check that consumes it is generic
 * (executeTool), the mapping Gmail-specific. `gmail.compose` and the full
 * `mail.google.com` scope are covered but never requested — `gmail.modify`
 * already authorizes drafts, and full access is a superset of
 * everything here.
 */
export const GMAIL_CAPABILITY_SCOPES: Record<GmailCapability, string[]> = {
  read: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    GMAIL_FULL_ACCESS,
  ],
  send: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    GMAIL_FULL_ACCESS,
  ],
  draft: [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    GMAIL_FULL_ACCESS,
  ],
  "modify-labels": [
    "https://www.googleapis.com/auth/gmail.modify",
    GMAIL_FULL_ACCESS,
  ],
  trash: ["https://www.googleapis.com/auth/gmail.modify", GMAIL_FULL_ACCESS],
};

/**
 * Gmail's list-tool vocabulary: the readable system mailboxes. Broader than
 * the mock's onboarding set (INBOX/SENT/DRAFTS) — a service owns its own
 * vocabulary, and Gmail exposes more mailboxes than the sandbox does. This is
 * a closed set of system labels; arbitrary user-created label IDs are not
 * reachable through the list tool.
 */
export const GMAIL_LABELS = [
  "INBOX",
  "SENT",
  "DRAFTS",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "TRASH",
] as const;

export type GmailLabel = (typeof GMAIL_LABELS)[number];

/**
 * Gmail vocabulary label → Gmail system labelId. Gmail's draft label is
 * singular DRAFT; the rest map to themselves. Keyed by GmailLabel so a new
 * vocabulary entry is a tsc error here until its labelId is supplied.
 */
const GMAIL_LABEL_IDS: Record<GmailLabel, string> = {
  INBOX: "INBOX",
  SENT: "SENT",
  DRAFTS: "DRAFT",
  STARRED: "STARRED",
  IMPORTANT: "IMPORTANT",
  SPAM: "SPAM",
  TRASH: "TRASH",
};

/**
 * Adapt the shared tool contract to the gmail-native client: re-assert the
 * params (direct-caller defense — also keeps prototype keys out of the
 * labelId lookup) and translate the vocabulary label to Gmail's labelId.
 * The client stays provider-native; see executeGmailList. Async so the
 * assert's throw surfaces as a rejection, matching the client's own contract.
 */
export async function gmailListExecute(
  token: string,
  params: EmailListParams<GmailLabel>,
  fetchFn?: typeof globalThis.fetch,
): Promise<GmailListResult> {
  assertEmailListParams(params, GMAIL_LABELS);
  return executeGmailList(
    token,
    { labelId: GMAIL_LABEL_IDS[params.label], maxResults: params.maxResults },
    fetchFn,
  );
}

/** Gmail list tool — authenticates with the injected credential, calls Gmail. */
export const GMAIL_LIST: Tool = emailListCapability({
  service: "gmail",
  labels: GMAIL_LABELS,
  defaultLabel: "INBOX",
  description:
    "List email messages from the user's Gmail account. Returns message metadata (subject, sender, date).",
  requiredScopes: GMAIL_CAPABILITY_SCOPES.read,
  execute: gmailListExecute,
});

/**
 * Map a thrown executor error to the tool's failure result — the identical
 * tail every gmail executor shares. A `GmailApiError` carries the Gmail
 * status in its message; anything else degrades to a generic string.
 */
function gmailToolError(err: unknown): ToolExecutionResult {
  return {
    success: false,
    error: err instanceof Error ? err.message : "Tool execution failed",
  };
}

/**
 * Gmail read tool — full message content by id. Governed as the constant
 * account-level sentinel noun `mailbox`: read is
 * consented per account/session, not per message — a per-id noun would storm
 * the user on a search-then-read task. The message id is audited as parameter
 * metadata, so no audit precision is lost. The sentinel is deliberately not
 * `*` (survives wildcard-allow hardening) and cannot collide with label
 * nouns, which are uppercase system IDs or `label:`-prefixed tokens.
 */
export const GMAIL_READ: Tool = {
  service: "gmail",
  verb: "read",
  description:
    "Read the full content (body and headers) of one email message from the user's Gmail account, by message id — e.g. an id returned by gmail_search.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: {
        type: "string",
        description: "The Gmail message id to read.",
      },
    },
    required: ["messageId"],
  },
  nounExtractor: () => "mailbox",
  requiredScopes: GMAIL_CAPABILITY_SCOPES.read,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return { success: false, error: "No credential found for service: gmail" };
    }
    const messageId = params.messageId;
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      return {
        success: false,
        error: "Invalid parameter: messageId must be a non-empty string",
      };
    }
    try {
      const data = await executeGmailGet(token, { messageId });
      return { success: true, data };
    } catch (err) {
      return gmailToolError(err);
    }
  },
};

/**
 * Gmail search tool — Gmail query syntax over the account. Governed as the
 * mailbox/label the query resolves to (`anywhere` when unfiltered); the raw
 * `q` is audited as parameter metadata, never the noun. Built by the
 * shared factory so the schema and noun resolution cannot
 * drift from the mock's search parity tool.
 */
export const GMAIL_SEARCH: Tool = emailSearchCapability({
  service: "gmail",
  description:
    "Search email messages in the user's Gmail account with Gmail query syntax. Returns message metadata (id, subject, sender, date); use gmail_read with a returned id for full content.",
  requiredScopes: GMAIL_CAPABILITY_SCOPES.read,
  execute: (token, params) => executeGmailSearch(token, params),
});

/**
 * Gmail send tool — a consequential verb, governed as the exact recipient-
 * address set across to+cc+bcc. Built by the shared
 * factory, so the envelope the executor transmits and the noun governance
 * evaluated come from the same params, read the same way.
 */
export const GMAIL_SEND: Tool = emailSendCapability({
  service: "gmail",
  description:
    "Send a new email message from the user's Gmail account. Requires the user's confirmation unless a matching grant exists for the exact recipient addresses.",
  requiredScopes: GMAIL_CAPABILITY_SCOPES.send,
  execute: (token, params) => executeGmailSend(token, params),
});

/**
 * Gmail reply tool — its own verb and grant, sharing send's recipient-
 * address noun *shape*: recipients come from the reply's own params,
 * extracted exactly as send's. `threadId`/
 * `inReplyTo` set threading only and never enter the recipient set, so a
 * `reply` grant to one recipient set cannot cover a reply that actually
 * leaves for different addresses.
 */
export const GMAIL_REPLY: Tool = {
  service: "gmail",
  verb: "reply",
  description:
    "Reply within an existing Gmail thread. Recipients are taken from this call's own to/cc/bcc params (e.g. from a gmail_read of the thread); threadId and inReplyTo control threading only.",
  inputSchema: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description: "The Gmail thread id to reply into (from gmail_read).",
      },
      inReplyTo: {
        type: "string",
        description:
          "The RFC 5322 Message-ID of the message being answered (with or without angle brackets).",
      },
      to: {
        type: "array",
        items: { type: "string" },
        description: "Recipient addresses for the reply.",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description: "CC recipient addresses.",
      },
      bcc: {
        type: "array",
        items: { type: "string" },
        description: "BCC recipient addresses.",
      },
      subject: {
        type: "string",
        description:
          "The subject of the thread being replied to; a Re: prefix is added if missing.",
      },
      body: { type: "string", description: "The plain-text reply body." },
    },
    required: ["threadId", "inReplyTo", "to", "subject", "body"],
  },
  nounExtractor: recipientAddressesNoun,
  requiredScopes: GMAIL_CAPABILITY_SCOPES.send,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return { success: false, error: "No credential found for service: gmail" };
    }
    const normalized = normalizeEmailEnvelope(params);
    if ("error" in normalized) {
      return { success: false, error: normalized.error };
    }
    const { threadId, inReplyTo } = params;
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      return {
        success: false,
        error: "Invalid parameter: threadId must be a non-empty string",
      };
    }
    if (typeof inReplyTo !== "string" || inReplyTo.trim().length === 0) {
      return {
        success: false,
        error: "Invalid parameter: inReplyTo must be a non-empty string",
      };
    }
    try {
      const data = await executeGmailReply(token, {
        ...normalized.envelope,
        threadId,
        inReplyTo,
      });
      return { success: true, data };
    } catch (err) {
      return gmailToolError(err);
    }
  },
};

/**
 * Gmail draft tool — creates a draft, sends nothing. A draft still names
 * recipients, so it is governed by send's recipient-address noun *shape*
 * over its own params — its own verb, its own grant.
 */
export const GMAIL_DRAFT: Tool = {
  service: "gmail",
  verb: "draft",
  description:
    "Create a draft email in the user's Gmail account. Nothing is sent — the draft is saved for the user to review and send themselves.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string" },
        description: "Recipient addresses the draft is composed to.",
      },
      cc: {
        type: "array",
        items: { type: "string" },
        description: "CC recipient addresses.",
      },
      bcc: {
        type: "array",
        items: { type: "string" },
        description: "BCC recipient addresses.",
      },
      subject: { type: "string", description: "The draft's subject." },
      body: { type: "string", description: "The plain-text draft body." },
    },
    required: ["to", "subject", "body"],
  },
  nounExtractor: recipientAddressesNoun,
  requiredScopes: GMAIL_CAPABILITY_SCOPES.draft,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return { success: false, error: "No credential found for service: gmail" };
    }
    const normalized = normalizeEmailEnvelope(params);
    if ("error" in normalized) {
      return { success: false, error: normalized.error };
    }
    try {
      const data = await executeGmailDraft(token, normalized.envelope);
      return { success: true, data };
    } catch (err) {
      return gmailToolError(err);
    }
  },
};

/**
 * Gmail's system label ids — recognized so the hygiene noun emits the real id,
 * never a `label:<name>` token that would misrepresent a valid system label as
 * a user label and blur the audit/consent record. Includes the category and
 * chat ids Gmail defines. Recognizing an id is not the same as permitting it:
 * whether a given label is mutable is Gmail's call (an immutable one fails
 * closed at the endpoint), and TRASH/SPAM are refused before dispatch
 * (GMAIL_LABEL_RESERVED_IDS). UNREAD joins the search resolver's set here: it
 * is not a mailbox a search resolves to, but it IS a label a mutation targets
 * (mark_read).
 */
const GMAIL_SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

/** The fixed noun for a label call that names no labels; the executor
 * rejects such a call as an input error regardless. */
export const NO_LABELS_NOUN = "no-labels";

/**
 * System labels gmail_label refuses to set — added or removed. TRASH and SPAM
 * are message *moves* with their own consequence class, not tidy labels:
 * trashing is a dedicated verb (gmail_trash, `delete`-grade), and marking spam
 * is deliberately not exposed at all. Routing either through the low-
 * consequence `label` verb would collapse exactly the consequence separation
 * the design keeps (the rejected coarse-
 * modify verb "lumps trash in with mark_read"). Compared against the canonical
 * id, so `trash` / `Trash` / `TRASH` are all caught.
 */
const GMAIL_LABEL_RESERVED_IDS = new Set(["TRASH", "SPAM"]);

/**
 * Canonicalize one label param to the id form hygiene nouns emit
 * (label IDs, never raw display names): a system
 * label id (any case) resolves to its canonical uppercase form, a real
 * user-label id (`Label_<n>`) passes verbatim, and anything else — a display
 * name the extractor cannot resolve to its id without a fetch — normalizes to
 * a prefixed `label:<name>` token that can never collide with the `read`
 * sentinel or a system id.
 *
 * The value returned is **unchanged from the raw input only when Gmail would
 * accept that raw input for a mutation** (an uppercase system id, or a
 * `Label_<n>`). Every other input is transformed, so — since the executor
 * forwards the caller's raw value verbatim (see labelMutationNoun) — any such
 * input fails closed at Gmail rather than mutating an unintended label. This
 * is why the display name `Drafts` maps to `label:drafts`, not to the `DRAFT`
 * system id: rewriting it to a valid-looking id would record consent to a real
 * label for a mutation Gmail can never perform (the raw `Drafts` is rejected).
 * Search's `in:drafts` → `DRAFT` resolution is a separate concern (a read
 * filter, not a forwarded mutation value).
 */
function canonicalizeGmailLabel(value: string): string {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (GMAIL_SYSTEM_LABEL_IDS.has(upper)) {
    return upper;
  }
  if (/^Label_\d+$/.test(trimmed)) {
    return trimmed;
  }
  return `label:${trimmed.toLowerCase()}`;
}

/** Collect a label array param defensively (non-arrays and non-strings
 * become their string forms rather than being dropped). */
function collectLabels(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((entry) => String(entry).trim()).filter((s) => s.length > 0);
}

/**
 * The gmail_label noun: every label the call mutates — added and removed —
 * canonicalized, de-duped, sorted, comma-joined (the target label is the one
 * sync-knowable target of a label mutation).
 *
 * The canonical form governs *consent only* — it is never sent to Gmail. The
 * executor forwards the caller's raw `addLabelIds`/`removeLabelIds` verbatim,
 * so any divergence (a display name the extractor could not resolve to an id,
 * a case/duplicate the set folded away) fails closed at Gmail with a 4xx
 * rather than mutating an unintended label.
 */
function labelMutationNoun(params: Record<string, unknown>): string {
  const labels = [
    ...collectLabels(params.addLabelIds),
    ...collectLabels(params.removeLabelIds),
  ];
  if (labels.length === 0) {
    return NO_LABELS_NOUN;
  }
  const canonical = new Set(labels.map(canonicalizeGmailLabel));
  return [...canonical].sort().join(",");
}

/**
 * Build one fixed-target message mutation tool (archive / mark_read /
 * trash): schema `{ messageId }`, a constant label noun — the one label the
 * verb is defined as mutating — and an executor that applies exactly that
 * mutation. The message id is audited as parameter metadata, not the noun
 * (same posture as gmail_read).
 */
function gmailMessageMutation(opts: {
  verb: string;
  noun: string;
  description: string;
  requiredScopes: string[];
  mutate: (token: string, messageId: string) => Promise<GmailModifyResult>;
}): Tool {
  return {
    service: "gmail",
    verb: opts.verb,
    description: opts.description,
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The Gmail message id to act on.",
        },
      },
      required: ["messageId"],
    },
    nounExtractor: () => opts.noun,
    requiredScopes: opts.requiredScopes,
    execute: async (params, ctx) => {
      const token = ctx.credential?.access_token;
      if (!token) {
        return {
          success: false,
          error: "No credential found for service: gmail",
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
        const data = await opts.mutate(token, messageId);
        return { success: true, data };
      } catch (err) {
        return gmailToolError(err);
      }
    },
  };
}

/** Archive is defined as removing INBOX — the noun is the label mutated. */
export const GMAIL_ARCHIVE: Tool = gmailMessageMutation({
  verb: "archive",
  noun: "INBOX",
  description:
    "Archive an email message in the user's Gmail account (removes it from the inbox; the message stays searchable under All Mail).",
  requiredScopes: GMAIL_CAPABILITY_SCOPES["modify-labels"],
  mutate: (token, messageId) =>
    executeGmailModify(token, {
      messageId,
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    }),
});

/** Mark-read is defined as removing UNREAD. */
export const GMAIL_MARK_READ: Tool = gmailMessageMutation({
  verb: "mark_read",
  noun: "UNREAD",
  description: "Mark an email message as read in the user's Gmail account.",
  requiredScopes: GMAIL_CAPABILITY_SCOPES["modify-labels"],
  mutate: (token, messageId) =>
    executeGmailModify(token, {
      messageId,
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    }),
});

/** Trash targets the TRASH label; Gmail auto-purges after ~30 days.
 * Permanent delete is deliberately not exposed. */
export const GMAIL_TRASH: Tool = gmailMessageMutation({
  verb: "trash",
  noun: "TRASH",
  description:
    "Move an email message to the trash in the user's Gmail account (reversible; Gmail purges trash after about 30 days).",
  requiredScopes: GMAIL_CAPABILITY_SCOPES.trash,
  mutate: (token, messageId) => executeGmailTrash(token, { messageId }),
});

/**
 * Gmail label tool — arbitrary label mutation, governed as the set of labels
 * being changed. A grant to `label`/`STARRED` covers starring/unstarring and
 * nothing else; touching a different label changes the noun and re-confirms.
 */
export const GMAIL_LABEL: Tool = {
  service: "gmail",
  verb: "label",
  description:
    "Add or remove labels on an email message in the user's Gmail account. Values must be Gmail label ids, not display names: the system ids (STARRED, IMPORTANT, INBOX, UNREAD) or a user label's own `Label_<n>` id. Gmail rejects a display name (e.g. \"Receipts\"), so use gmail_archive to remove INBOX and gmail_mark_read to remove UNREAD; reach this tool for starring/importance or a known user-label id. This tool cannot trash a message (use gmail_trash) and cannot mark a message as spam.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: {
        type: "string",
        description: "The Gmail message id to act on.",
      },
      addLabelIds: {
        type: "array",
        items: { type: "string" },
        description: "Label ids to add.",
      },
      removeLabelIds: {
        type: "array",
        items: { type: "string" },
        description: "Label ids to remove.",
      },
    },
    required: ["messageId"],
  },
  nounExtractor: labelMutationNoun,
  requiredScopes: GMAIL_CAPABILITY_SCOPES["modify-labels"],
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return { success: false, error: "No credential found for service: gmail" };
    }
    const messageId = params.messageId;
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
      return {
        success: false,
        error: "Invalid parameter: messageId must be a non-empty string",
      };
    }
    const addLabelIds = collectLabels(params.addLabelIds);
    const removeLabelIds = collectLabels(params.removeLabelIds);
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      return {
        success: false,
        error:
          "Invalid parameter: at least one of addLabelIds or removeLabelIds must name a label",
      };
    }
    // Refuse the reserved system labels before dispatch, whatever the grant:
    // trashing and marking spam are not `label` actions (see
    // GMAIL_LABEL_RESERVED_IDS). Match on the canonical id so any case reaches
    // it. Fails as an input error the same way the label-less call does.
    const reserved = [...new Set([...addLabelIds, ...removeLabelIds])]
      .map(canonicalizeGmailLabel)
      .filter((id) => GMAIL_LABEL_RESERVED_IDS.has(id));
    if (reserved.length > 0) {
      return {
        success: false,
        error: `Invalid parameter: gmail_label cannot modify the ${reserved
          .sort()
          .join(", ")} system label — use gmail_trash to trash a message; marking spam is not supported`,
      };
    }
    try {
      const data = await executeGmailModify(token, {
        messageId,
        addLabelIds,
        removeLabelIds,
      });
      return { success: true, data };
    } catch (err) {
      return gmailToolError(err);
    }
  },
};

/**
 * The gmail service: declarative data only. Its OAuth machinery lives on the
 * `google` provider strategy; gmail contributes just its scopes and tools.
 */
export const gmail: ServiceDefinition = {
  service: "gmail",
  connect: {
    type: "oauth",
    provider: "google",
    // Tier 3: the least-privilege non-redundant set.
    // gmail.modify covers drafts and every label mutation, so gmail.compose
    // is never requested. A user connected under a narrower set hits
    // needs_authorization on the wider tools and re-connects — the re-consent
    // widens because every connect requests this full set (the complete-
    // scope-set invariant), not via
    // include_granted_scopes, which beginAuth no longer sends. Note modify is
    // a near-master scope: from here the blast-radius bound rests on
    // governance (noun binding + hold), not scope narrowness.
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  },
  tools: [
    GMAIL_LIST,
    GMAIL_READ,
    GMAIL_SEARCH,
    GMAIL_SEND,
    GMAIL_REPLY,
    GMAIL_DRAFT,
    GMAIL_ARCHIVE,
    GMAIL_MARK_READ,
    GMAIL_LABEL,
    GMAIL_TRASH,
  ],
};
