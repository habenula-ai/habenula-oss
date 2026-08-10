// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { truncateEmailBody } from "../shared/email-read.js";
import {
  graphFetch,
  graphPagedList,
  GraphApiError,
  type GraphDeps,
} from "./graph.js";

/**
 * The Graph-native Outlook Mail executors. Result shapes mirror the Gmail
 * client's (subject / sender / timestamp, ids on search hits) so the
 * model-facing data is uniform across mail services; the wire format is
 * Graph's own — structured JSON, `$select` projections, no MIME assembly.
 * Speaks Graph's folder vocabulary verbatim; validation lives in the
 * outlook-mail.ts adapters. Access tokens are used per request, never stored.
 */

/** A Graph email address node: `{ name, address }` under a recipient. */
interface GraphEmailAddress {
  name?: string;
  address?: string;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

/** The `$select`-projected message fields list/search/read consume. */
interface GraphMessage {
  id?: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
}

export interface OutlookMailMessage {
  subject: string;
  sender: string;
  timestamp: string;
}

export interface OutlookMailListResult {
  messages: OutlookMailMessage[];
}

/** A search hit carries its message id so the model can follow up with an
 * `outlook_mail_read` on it (the search-then-read flow). */
export interface OutlookMailSearchMessage extends OutlookMailMessage {
  id: string;
}

export interface OutlookMailSearchResult {
  messages: OutlookMailSearchMessage[];
}

/** Full message content: the projected metadata plus the text body. */
export interface OutlookMailReadResult {
  id: string;
  subject: string;
  sender: string;
  to: string;
  timestamp: string;
  body: string;
}

/** Send reports Graph's 202 acceptance — not delivery. */
export interface OutlookMailSendResult {
  accepted: true;
}

/** Format one Graph recipient as the `Name <address>` display string the
 * Gmail results carry (address alone when no name; empty when neither). */
function formatEmailAddress(recipient: GraphRecipient | undefined): string {
  const name = recipient?.emailAddress?.name ?? "";
  const address = recipient?.emailAddress?.address ?? "";
  if (name && address) {
    return `${name} <${address}>`;
  }
  return address || name;
}

function toListMessage(msg: GraphMessage): OutlookMailMessage {
  return {
    subject: msg.subject ?? "",
    sender: formatEmailAddress(msg.from),
    timestamp: msg.receivedDateTime ?? "",
  };
}

/** An outlook-native list request: a Graph well-known folder name usable
 * verbatim in the URL path, and a validated message count. */
export interface OutlookMailListRequest {
  folder: string;
  maxResults: number;
}

/**
 * List a folder's messages. Graph returns the projected metadata inline
 * (`$select`), so there is no Gmail-style per-message fanout; `$top` asks for
 * the governed page size and graphPagedList bounds any `nextLink` walk.
 */
export async function executeOutlookMailList(
  accessToken: string,
  request: OutlookMailListRequest,
  deps?: GraphDeps,
): Promise<OutlookMailListResult> {
  const { folder, maxResults } = request;
  const query = new URLSearchParams({
    $select: "subject,from,receivedDateTime",
    $top: String(maxResults),
  });
  const rows = await graphPagedList<GraphMessage>(
    accessToken,
    `/me/mailFolders/${encodeURIComponent(folder)}/messages?${query.toString()}`,
    maxResults,
    deps,
  );
  return { messages: rows.map(toListMessage) };
}

/** An outlook-native search request: a raw query for Graph `$search` and a
 * validated message count. */
export interface OutlookMailSearchRequest {
  q: string;
  maxResults: number;
}

/** Double-quote the `$search` value, backslash-escaping embedded backslashes
 * and quotes — backslashes first, or an input like `foo\"` would corrupt the
 * escape state and un-terminate the clause. Whether Graph's KQL accepts this
 * exact escaping is confirmed by the manual staging round-trip,
 * not a fixture. */
function searchClause(q: string): string {
  return `"${q.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Search the whole mailbox with Graph `$search`. No `$orderby` / `$count` /
 * `$skip` — Graph rejects them with `$search` — and search responses page
 * differently from a folder list (Graph caps search result sets), so the
 * bound is enforced on this path in its own right.
 */
export async function executeOutlookMailSearch(
  accessToken: string,
  request: OutlookMailSearchRequest,
  deps?: GraphDeps,
): Promise<OutlookMailSearchResult> {
  const { q, maxResults } = request;
  const query = new URLSearchParams({
    $search: searchClause(q),
    $select: "id,subject,from,receivedDateTime",
    $top: String(maxResults),
  });
  const rows = await graphPagedList<GraphMessage>(
    accessToken,
    `/me/messages?${query.toString()}`,
    maxResults,
    deps,
  );
  return {
    messages: rows.map((msg) => ({ id: msg.id ?? "", ...toListMessage(msg) })),
  };
}

export interface OutlookMailReadRequest {
  messageId: string;
}

/**
 * Fetch one message in full by id. The `Prefer` header asks Graph to convert
 * an HTML body to text server-side; the body then runs through the shared
 * truncation contract (services/shared/email-read.ts). The body flows to the
 * model (the tool's purpose) but is never written to the audit log; the id
 * is audited as parameter metadata.
 */
export async function executeOutlookMailGet(
  accessToken: string,
  request: OutlookMailReadRequest,
  deps?: GraphDeps,
): Promise<OutlookMailReadResult> {
  const { messageId } = request;
  const query = new URLSearchParams({
    $select: "id,subject,from,toRecipients,receivedDateTime,body",
  });
  const res = await graphFetch(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}?${query.toString()}`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
    deps,
  );
  const msg = (await res.json()) as GraphMessage;
  return {
    id: msg.id ?? messageId,
    subject: msg.subject ?? "",
    sender: formatEmailAddress(msg.from),
    to: (msg.toRecipients ?? []).map(formatEmailAddress).join(", "),
    timestamp: msg.receivedDateTime ?? "",
    body: truncateEmailBody(msg.body?.content ?? ""),
  };
}

/** An outlook-native send request: the validated envelope (recipients already
 * normalized to address lists by the shared send capability). */
export interface OutlookMailSendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/**
 * Convert one envelope recipient — `Display <addr>` or bare `addr` — to
 * Graph's recipient node. A surrounding-quote layer on the display name is
 * RFC 5322 syntax, not part of the name, so it is stripped. Recipient
 * strings are JSON values end to end: no header lines exist on this path,
 * so Gmail's header-injection sanitizer has no analogue here.
 */
function toGraphRecipient(recipient: string): GraphRecipient {
  const trimmed = recipient.trim();
  const angle = /^(.*?)\s*<([^<>]*)>$/.exec(trimmed);
  if (!angle) {
    return { emailAddress: { address: trimmed } };
  }
  let name = angle[1]!.trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1);
  }
  const address = angle[2]!.trim();
  return name.length > 0
    ? { emailAddress: { address, name } }
    : { emailAddress: { address } };
}

/**
 * Send a message (`POST /me/sendMail`, structured JSON — no MIME assembly).
 * Graph answers `202 Accepted` with no body: the request was accepted, not
 * delivered, and the result says so. Anything else throws.
 */
export async function executeOutlookMailSend(
  accessToken: string,
  request: OutlookMailSendRequest,
  deps?: GraphDeps,
): Promise<OutlookMailSendResult> {
  const res = await graphFetch(
    accessToken,
    "/me/sendMail",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: request.subject,
          body: { contentType: "Text", content: request.body },
          toRecipients: request.to.map(toGraphRecipient),
          ccRecipients: request.cc.map(toGraphRecipient),
          bccRecipients: request.bcc.map(toGraphRecipient),
        },
        saveToSentItems: true,
      }),
    },
    deps,
  );
  if (res.status !== 202) {
    throw new GraphApiError(
      res.status,
      `Outlook send expected 202 Accepted, got ${String(res.status)}`,
    );
  }
  return { accepted: true };
}
