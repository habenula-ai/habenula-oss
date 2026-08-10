// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The recipient-address noun for send-shaped email verbs (send, reply,
 * draft). Pure and synchronous: the recipients
 * governance evaluates are exactly the recipients the executor transmits,
 * because both read the same params through `collectRecipients` — one
 * source, read twice, so the governed noun and the sent envelope cannot
 * diverge. The grant grain is the exact address set — a new address, even
 * inside an already-granted domain, changes the noun and re-confirms
 * (per-address subset coverage is the tracked follow-up).
 * `recipientDomain` remains for the calendar invitee noun, which keeps
 * domain grain until it aligns to address grain with the same issue.
 */

/**
 * The fixed noun for an empty envelope. Deliberately not a domain (no dot,
 * has no meaning as a host) and never granted implicitly; the executor
 * rejects a zero-recipient send as an input error regardless.
 */
export const NO_RECIPIENTS_NOUN = "no-recipients";

/**
 * Split one address-list string on the commas that separate recipients,
 * leaving commas inside a double-quoted display name intact. RFC 5322 quotes
 * a display name that contains a comma (`"Last, First" <a@x>`), so a naive
 * `split(",")` would tear that one recipient into a bogus extra address (and
 * a spurious `unparseable:` domain in the noun). Quote-aware splitting keeps
 * the recipient whole, so the governed noun and the transmitted `To` line
 * both see exactly one address.
 */
function splitAddressList(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Normalize one recipient param (`to` / `cc` / `bcc`) to its address list.
 * Accepts an array of address strings or one comma-separated string; any
 * other shape yields the value's string form as a single (unparseable-bound)
 * entry rather than dropping it. Comma splitting is quote-aware, so a
 * `"Last, First" <a@x>` display name survives as one recipient. Both the noun
 * extractor and the executor's envelope read recipients through this one
 * function.
 */
export function collectRecipients(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) =>
      typeof entry === "string" ? splitAddressList(entry) : [String(entry)],
    )
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

/**
 * Parse one address — `Display Name <addr@host>` or bare `addr@host` — to
 * its lower-cased domain (the substring after the LAST `@`, so a quoted
 * local part containing `@` cannot smuggle a wrong domain). Fails closed:
 * anything that does not parse to a plausible domain returns an opaque
 * `unparseable:<raw>` token, never dropped, so a grant can never silently
 * cover a malformed recipient. A colon-bearing "domain" is rejected here —
 * no real domain contains `:`, and this rejection is what makes the
 * colon-prefixed noun namespaces (`unparseable:<raw>` here,
 * `calendar:<name>` in the calendar write noun) unforgeable: without it a
 * crafted address like `x@calendar:primary` would parse to a "plausible"
 * domain colliding with the quiet-write noun. Distinct hosts stay distinct
 * (`mail.acme.com` ≠ `acme.com`): erring toward re-confirmation over
 * coverage.
 */
export function recipientDomain(address: string): string {
  const trimmed = address.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  const addr = (angle ? angle[1]! : trimmed).trim();
  const at = addr.lastIndexOf("@");
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plausible =
    at > 0 &&
    local.length > 0 &&
    // A bare display name ("Alice alice@x.com" without angle brackets) must
    // not parse as if it were the address — whitespace in the local part
    // fails closed to the unparseable token.
    !/[\s<>]/.test(local) &&
    domain.length > 0 &&
    !/[\s@,:<>]/.test(domain);
  return plausible
    ? domain.toLowerCase()
    : `unparseable:${trimmed.toLowerCase()}`;
}

/**
 * Parse one address — `Display Name <addr@host>` or bare `addr@host` — to
 * its lower-cased full address: the grant grain for send-shaped verbs, so a
 * grant names exact mailboxes, never a whole domain. Same fail-closed
 * discipline as recipientDomain: anything that does not parse to a plausible
 * address returns an opaque `unparseable:<raw>` token, never dropped. Two
 * local-part rejections are added at this grain: a comma (the noun's set
 * separator — a comma-bearing quoted local part would corrupt the joined
 * set) and a colon (keeps the colon-prefixed opaque-token namespace
 * unforgeable: a noun containing `:` is always a fail-closed token, never a
 * grantable mailbox).
 */
export function recipientAddress(address: string): string {
  const trimmed = address.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  const addr = (angle ? angle[1]! : trimmed).trim();
  const at = addr.lastIndexOf("@");
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plausible =
    at > 0 &&
    local.length > 0 &&
    // A bare display name ("Alice alice@x.com" without angle brackets) must
    // not parse as if it were the address — whitespace in the local part
    // fails closed to the unparseable token.
    !/[\s<>,:]/.test(local) &&
    domain.length > 0 &&
    !/[\s@,:<>]/.test(domain);
  return plausible
    ? addr.toLowerCase()
    : `unparseable:${trimmed.toLowerCase()}`;
}

/**
 * The noun itself: every address across to+cc+bcc, each parsed to its
 * lower-cased full address (or unparseable token), de-duped, sorted,
 * comma-joined. Zero recipients → the fixed non-matching sentinel. Policy
 * matching is exact-string, so a grant covers only an identical recipient
 * set: adding OR removing an address re-confirms (per-address subset
 * coverage is a tracked follow-up).
 */
export function recipientAddressesNoun(
  params: Record<string, unknown>,
): string {
  const addresses = [
    ...collectRecipients(params.to),
    ...collectRecipients(params.cc),
    ...collectRecipients(params.bcc),
  ];
  if (addresses.length === 0) {
    return NO_RECIPIENTS_NOUN;
  }
  const parsed = new Set(addresses.map(recipientAddress));
  return [...parsed].sort().join(",");
}
