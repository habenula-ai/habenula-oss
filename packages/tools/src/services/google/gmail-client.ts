// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  EMAIL_READ_BODY_MAX_CHARS,
  truncateEmailBody,
} from "../shared/email-read.js";

const GMAIL_API_BASE = "https://www.googleapis.com/gmail/v1/users/me";

/**
 * A gmail-native list request: a Gmail system labelId (INBOX, SENT, DRAFT —
 * Gmail's own vocabulary, not the shared tool labels) and a validated
 * message count.
 */
export interface GmailListRequest {
  labelId: string;
  maxResults: number;
}

export interface GmailMessage {
  subject: string;
  sender: string;
  timestamp: string;
}

export interface GmailListResult {
  messages: GmailMessage[];
}

/** A gmail-native search request: a raw Gmail query string (`q`) and a
 * validated message count. */
export interface GmailSearchRequest {
  q: string;
  maxResults: number;
}

/** A search hit carries its message id so the model can follow up with a
 * `gmail_read` on it (the search-then-read flow). */
export interface GmailSearchMessage extends GmailMessage {
  id: string;
}

export interface GmailSearchResult {
  messages: GmailSearchMessage[];
}

export interface GmailReadRequest {
  messageId: string;
}

/** Full message content: the metadata headers plus the decoded body. */
export interface GmailReadResult {
  id: string;
  threadId: string;
  subject: string;
  sender: string;
  to: string;
  timestamp: string;
  body: string;
}

export class GmailApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

type FetchFn = typeof globalThis.fetch;

/**
 * Fetch email messages from the Gmail API.
 * Returns subject, sender, and timestamp for the last N messages.
 *
 * Speaks Gmail's own vocabulary (labelId), not the shared tool contract —
 * validation and label translation live in the GMAIL_LIST adapter
 * (services/google/gmail.ts), so a future Gmail capability can reuse this client
 * without widening the shared email vocabulary.
 *
 * The accessToken is used for a single request and never stored.
 */
export async function executeGmailList(
  accessToken: string,
  request: GmailListRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailListResult> {
  const { labelId, maxResults } = request;

  // Step 1: List message IDs
  const listUrl = new URL(`${GMAIL_API_BASE}/messages`);
  listUrl.searchParams.set("labelIds", labelId);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listRes = await fetchFn(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    throw new GmailApiError(
      listRes.status,
      `Gmail list failed (${listRes.status})`,
    );
  }

  const listData = (await listRes.json()) as {
    messages?: { id: string }[];
  };

  if (!listData.messages || listData.messages.length === 0) {
    return { messages: [] };
  }

  // Step 2: Fetch metadata for each message (parallel). Slice defensively:
  // the fanout spends one Worker subrequest per ID, so it must be bounded by
  // the requested maxResults (validated in the adapter), not by how many IDs
  // the response carries.
  const withIds = await fetchMessagesMetadata(
    accessToken,
    listData.messages.slice(0, maxResults).map((m) => m.id),
    fetchFn,
  );
  return {
    messages: withIds.map(({ subject, sender, timestamp }) => ({
      subject,
      sender,
      timestamp,
    })),
  };
}

/**
 * The shared N+1 metadata fanout behind list and search: one bounded
 * `format=metadata` subrequest per message id, in parallel. Callers bound the
 * id set by their validated maxResults before calling.
 */
async function fetchMessagesMetadata(
  accessToken: string,
  ids: string[],
  fetchFn: FetchFn,
): Promise<GmailSearchMessage[]> {
  return Promise.all(
    ids.map(async (id) => {
      const detailUrl = new URL(
        `${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`,
      );
      detailUrl.searchParams.set("format", "metadata");
      detailUrl.searchParams.set("metadataHeaders", "Subject");
      detailUrl.searchParams.append("metadataHeaders", "From");
      detailUrl.searchParams.append("metadataHeaders", "Date");

      const detailRes = await fetchFn(detailUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!detailRes.ok) {
        throw new GmailApiError(
          detailRes.status,
          `Gmail message detail failed (${detailRes.status}): ${id}`,
        );
      }

      const detail = (await detailRes.json()) as {
        payload?: {
          headers?: { name: string; value: string }[];
        };
      };

      const headers = detail.payload?.headers ?? [];
      const getHeader = (name: string): string =>
        headers.find((h) => h.name === name)?.value ?? "";

      return {
        id,
        subject: getHeader("Subject"),
        sender: getHeader("From"),
        timestamp: getHeader("Date"),
      };
    }),
  );
}

/**
 * Search messages with Gmail's own query syntax (`q`), returning the same
 * metadata as list plus each hit's message id. Reuses the bounded N+1
 * metadata fanout. The raw `q` is provider input here; governance audits it
 * as parameter metadata and nouns the resolved label (see emailSearchNoun).
 */
export async function executeGmailSearch(
  accessToken: string,
  request: GmailSearchRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailSearchResult> {
  const { q, maxResults } = request;

  const searchUrl = new URL(`${GMAIL_API_BASE}/messages`);
  searchUrl.searchParams.set("q", q);
  searchUrl.searchParams.set("maxResults", String(maxResults));

  const searchRes = await fetchFn(searchUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!searchRes.ok) {
    throw new GmailApiError(
      searchRes.status,
      `Gmail search failed (${searchRes.status})`,
    );
  }

  const searchData = (await searchRes.json()) as {
    messages?: { id: string }[];
  };

  if (!searchData.messages || searchData.messages.length === 0) {
    return { messages: [] };
  }

  const messages = await fetchMessagesMetadata(
    accessToken,
    searchData.messages.slice(0, maxResults).map((m) => m.id),
    fetchFn,
  );
  return { messages };
}

/** A gmail-native send request: the validated envelope (recipients already
 * normalized to address lists by the shared send capability). */
export interface GmailSendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/** A reply extends the envelope with Gmail threading: the thread to append
 * to and the RFC 5322 Message-ID being answered. */
export interface GmailReplyRequest extends GmailSendRequest {
  threadId: string;
  inReplyTo: string;
}

export interface GmailSendResult {
  id: string;
  threadId: string;
}

/**
 * The latin1 "binary string" `btoa` expects: one char per UTF-8 byte. Built
 * with a loop, never `String.fromCharCode(...bytes)` — spreading a large byte
 * array as call arguments can overflow the argument limit on a long subject
 * or body.
 */
function utf8ToBinary(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

/** Encode a UTF-8 string as base64url (Gmail's `raw` message encoding). */
function encodeBase64Url(text: string): string {
  return btoa(utf8ToBinary(text))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Neutralize RFC 2822 header injection: a recipient address or Message-ID is
 * interpolated into a header line verbatim, so an embedded CR/LF would break
 * out and inject arbitrary headers (a `Bcc:` to a third party) or a body.
 * The recipient-address noun fails whitespace-bearing addresses closed to an
 * unparseable token (forcing a hold), but a reply's `inReplyTo` never enters
 * that noun — a governed reply could still smuggle one — so this sanitizer,
 * not governance, is the actual barrier. Fold any CR/LF run to a single
 * space so the value stays on its own header line.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** True when a string is entirely printable ASCII (RFC 2822 header-safe). */
function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * Wrap a value as a single RFC 2047 base64 encoded-word (UTF-8). A very long
 * non-ASCII value produces one word past RFC 2047's 75-char-per-word / 76-char
 * line limit rather than folding into multiple words; Gmail accepts the
 * unfolded form, so folding is deferred (known Tier-2 limitation).
 */
function rfc2047Word(value: string): string {
  return `=?UTF-8?B?${btoa(utf8ToBinary(value))}?=`;
}

/** RFC 2047-encode a header value when it isn't printable ASCII. */
function encodeHeaderValue(value: string): string {
  const safe = sanitizeHeaderValue(value);
  return isPrintableAscii(safe) ? safe : rfc2047Word(safe);
}

/**
 * Format one recipient for a To/Cc/Bcc header line. A non-ASCII display name
 * (`Résumé <a@x.com>`) is RFC 2047 encoded-word wrapped so the header stays
 * 7-bit ASCII; the addr-spec is left verbatim (domains are ASCII/punycode by
 * construction, and encoding an addr-spec would break delivery). A bare
 * address or an all-ASCII display name passes through unchanged, preserving
 * any quoting the caller authored. CR/LF is folded first, so this stays the
 * same injection barrier `sanitizeHeaderValue` was — an embedded newline can
 * never open a new header line.
 */
function formatAddressHeader(address: string): string {
  const safe = sanitizeHeaderValue(address);
  const angle = /^(.*?)\s*(<[^<>]*>)$/.exec(safe);
  if (!angle) {
    return safe; // bare addr-spec (or unparseable) — nothing to encode
  }
  const display = angle[1]!.trim();
  const addr = angle[2]!;
  if (display.length === 0) {
    return addr;
  }
  if (isPrintableAscii(display)) {
    return `${display} ${addr}`;
  }
  // Strip one surrounding-quote layer before encoding: an RFC 2047 word
  // replaces the quoted-string, so leaving the quotes in would bake literal
  // quote characters into the decoded display name.
  const bare =
    display.length >= 2 && display.startsWith('"') && display.endsWith('"')
      ? display.slice(1, -1)
      : display;
  return `${rfc2047Word(bare)} ${addr}`;
}

/**
 * Assemble the RFC 2822 message the send/reply endpoints transmit. The
 * recipients come from the validated envelope — the same params the noun
 * extractor governed. A Bcc header in the raw
 * message is honored by Gmail: it delivers to the Bcc recipients and strips
 * the header from what other recipients see.
 */
function buildRfc2822(
  envelope: GmailSendRequest,
  threading?: { inReplyTo: string },
): string {
  const headers: string[] = [
    `To: ${envelope.to.map(formatAddressHeader).join(", ")}`,
  ];
  if (envelope.cc.length > 0) {
    headers.push(`Cc: ${envelope.cc.map(formatAddressHeader).join(", ")}`);
  }
  if (envelope.bcc.length > 0) {
    headers.push(`Bcc: ${envelope.bcc.map(formatAddressHeader).join(", ")}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(envelope.subject)}`);
  if (threading) {
    // Message-IDs are angle-bracketed on the wire; accept either form.
    // Sanitize before wrapping — a CR/LF here would otherwise inject headers
    // on a reply the recipient-address noun already cleared (inReplyTo is not
    // part of that noun).
    const inReplyTo = sanitizeHeaderValue(threading.inReplyTo);
    const messageId = inReplyTo.startsWith("<") ? inReplyTo : `<${inReplyTo}>`;
    headers.push(`In-Reply-To: ${messageId}`);
    // References carries only the single answered Message-ID, not the thread's
    // accumulated chain — the reply schema does not surface the prior chain,
    // and Gmail threads server-side on `threadId` regardless. Strict RFC 5322
    // References reconstruction in other clients is a known Tier-2 limitation
    // (integrations/gmail.md); revisit if a threading param carries the chain.
    headers.push(`References: ${messageId}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  return `${headers.join("\r\n")}\r\n\r\n${envelope.body}`;
}

async function postGmailSend(
  accessToken: string,
  payload: { raw: string; threadId?: string },
  label: "send" | "reply",
  fetchFn: FetchFn,
): Promise<GmailSendResult> {
  const sendRes = await fetchFn(`${GMAIL_API_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!sendRes.ok) {
    throw new GmailApiError(
      sendRes.status,
      `Gmail ${label} failed (${sendRes.status})`,
    );
  }

  const sent = (await sendRes.json()) as { id?: string; threadId?: string };
  return { id: sent.id ?? "", threadId: sent.threadId ?? "" };
}

/**
 * Send a new message (`messages/send`, base64url RFC 2822 `raw`). The
 * transmitted envelope is exactly the validated request — the recipients
 * governance nouned. The accessToken is used for a single request and never
 * stored.
 */
export async function executeGmailSend(
  accessToken: string,
  request: GmailSendRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailSendResult> {
  const raw = encodeBase64Url(buildRfc2822(request));
  return postGmailSend(accessToken, { raw }, "send", fetchFn);
}

/**
 * Reply into an existing thread: same `messages/send` endpoint, with
 * `threadId` in the payload and `In-Reply-To`/`References` headers so Gmail
 * threads it. The subject gains a `Re: ` prefix unless the caller already
 * supplied one. `threadId`/`inReplyTo` set threading only — they never enter
 * the recipient set.
 */
export async function executeGmailReply(
  accessToken: string,
  request: GmailReplyRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailSendResult> {
  const subject = /^re:/i.test(request.subject.trim())
    ? request.subject
    : `Re: ${request.subject}`;
  const raw = encodeBase64Url(
    buildRfc2822({ ...request, subject }, { inReplyTo: request.inReplyTo }),
  );
  return postGmailSend(
    accessToken,
    { raw, threadId: request.threadId },
    "reply",
    fetchFn,
  );
}

/** A draft shares the send envelope; nothing is transmitted on create. */
export type GmailDraftRequest = GmailSendRequest;

export interface GmailDraftResult {
  /** The draft's own id (drafts.* namespace). */
  id: string;
  /** The id/thread of the message the draft wraps. */
  messageId: string;
  threadId: string;
}

/**
 * Create a draft (`drafts` create, same base64url RFC 2822 `raw` as send).
 * Nothing is sent — but the draft names recipients, so the call is governed
 * by the same recipient-address noun as send.
 */
export async function executeGmailDraft(
  accessToken: string,
  request: GmailDraftRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailDraftResult> {
  const raw = encodeBase64Url(buildRfc2822(request));

  const draftRes = await fetchFn(`${GMAIL_API_BASE}/drafts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!draftRes.ok) {
    throw new GmailApiError(
      draftRes.status,
      `Gmail draft failed (${draftRes.status})`,
    );
  }

  const draft = (await draftRes.json()) as {
    id?: string;
    message?: { id?: string; threadId?: string };
  };
  return {
    id: draft.id ?? "",
    messageId: draft.message?.id ?? "",
    threadId: draft.message?.threadId ?? "",
  };
}

/** A gmail-native label mutation: the message and the label ids to add/remove. */
export interface GmailModifyRequest {
  messageId: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}

/** The mutated message's resulting label set. */
export interface GmailModifyResult {
  id: string;
  labelIds: string[];
}

/**
 * Mutate a message's labels (`messages/{id}/modify`). Archive and mark-read
 * are label removals (INBOX / UNREAD) through this one endpoint; the label
 * tool passes arbitrary add/remove sets.
 */
export async function executeGmailModify(
  accessToken: string,
  request: GmailModifyRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailModifyResult> {
  const { messageId, addLabelIds, removeLabelIds } = request;

  const modifyRes = await fetchFn(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    },
  );

  if (!modifyRes.ok) {
    throw new GmailApiError(
      modifyRes.status,
      `Gmail modify failed (${modifyRes.status}): ${messageId}`,
    );
  }

  const modified = (await modifyRes.json()) as {
    id?: string;
    labelIds?: string[];
  };
  return { id: modified.id ?? messageId, labelIds: modified.labelIds ?? [] };
}

/**
 * Move a message to the trash (`messages/{id}/trash`) — Gmail's reversible
 * delete (auto-purges after ~30 days). Permanent delete is deliberately not
 * exposed.
 */
export async function executeGmailTrash(
  accessToken: string,
  request: { messageId: string },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailModifyResult> {
  const { messageId } = request;

  // trash takes no request body — deliberately no Content-Type and no body,
  // unlike modify (which posts a JSON label set).
  const trashRes = await fetchFn(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/trash`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!trashRes.ok) {
    throw new GmailApiError(
      trashRes.status,
      `Gmail trash failed (${trashRes.status}): ${messageId}`,
    );
  }

  const trashed = (await trashRes.json()) as {
    id?: string;
    labelIds?: string[];
  };
  return { id: trashed.id ?? messageId, labelIds: trashed.labelIds ?? [] };
}

/**
 * A Gmail message payload node: multipart messages nest parts; each node may
 * carry base64url body data.
 */
interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

/** Gmail's read-body ceiling is the shared cross-service contract
 * (services/shared/email-read.ts); re-exported so existing imports hold. */
export const GMAIL_READ_BODY_MAX_CHARS = EMAIL_READ_BODY_MAX_CHARS;

/** Decode Gmail's base64url-encoded body data to text. */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Depth-first search for the first part of the given MIME type carrying
 * body data. */
function findPartData(
  part: GmailPayloadPart,
  mimeType: string,
): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findPartData(child, mimeType);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Extract a message's readable body from its payload tree: prefer text/plain,
 * fall back to text/html, then to the top-level body (single-part messages).
 * Empty string when no body data exists (e.g. attachment-only). Bounded by
 * the shared truncation contract (services/shared/email-read.ts).
 */
function extractBody(payload: GmailPayloadPart | undefined): string {
  if (!payload) {
    return "";
  }
  const data =
    findPartData(payload, "text/plain") ??
    findPartData(payload, "text/html") ??
    payload.body?.data;
  return truncateEmailBody(data ? decodeBase64Url(data) : "");
}

/**
 * Fetch one message in full — metadata headers plus the decoded body — by
 * message id (`messages/{id}?format=full`). The body flows to the model (the
 * tool's purpose) but is never written to the audit log; the id is audited as
 * parameter metadata.
 */
export async function executeGmailGet(
  accessToken: string,
  request: GmailReadRequest,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<GmailReadResult> {
  const { messageId } = request;

  const readUrl = new URL(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`,
  );
  readUrl.searchParams.set("format", "full");

  const readRes = await fetchFn(readUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!readRes.ok) {
    throw new GmailApiError(
      readRes.status,
      `Gmail read failed (${readRes.status}): ${messageId}`,
    );
  }

  const message = (await readRes.json()) as {
    id?: string;
    threadId?: string;
    payload?: GmailPayloadPart & {
      headers?: { name: string; value: string }[];
    };
  };

  const headers = message.payload?.headers ?? [];
  const getHeader = (name: string): string =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
    "";

  return {
    id: message.id ?? messageId,
    threadId: message.threadId ?? "",
    subject: getHeader("Subject"),
    sender: getHeader("From"),
    to: getHeader("To"),
    timestamp: getHeader("Date"),
    body: extractBody(message.payload),
  };
}
