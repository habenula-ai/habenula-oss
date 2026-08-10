// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LLMToolInputSchema } from "../../llm/types.js";
import type { Tool } from "../../tools/types.js";
import { collectRecipients, recipientAddressesNoun } from "./recipients.js";

/**
 * The params a send-style email tool's `execute` body receives, pre-validated:
 * recipients normalized to address lists (to guaranteed non-empty), subject
 * and body guaranteed strings. The executor transmits exactly these — the
 * same params the noun extractor read.
 */
export interface EmailSendParams {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/**
 * Validate and normalize a send-shaped envelope from raw tool params. The
 * recipients are read through the SAME collectRecipients the noun extractor
 * used — one source, read twice. Shared by the
 * send factory below and reply-shaped tools that extend the envelope with
 * threading params.
 */
export function normalizeEmailEnvelope(
  params: Record<string, unknown>,
): { envelope: EmailSendParams } | { error: string } {
  const to = collectRecipients(params.to);
  const cc = collectRecipients(params.cc);
  const bcc = collectRecipients(params.bcc);
  if (to.length === 0) {
    return { error: "Invalid parameter: to must contain at least one recipient" };
  }
  const { subject, body } = params;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return { error: "Invalid parameter: subject must be a non-empty string" };
  }
  // Trim to reject a whitespace-only body, symmetric with subject; the
  // untrimmed original is what we transmit.
  if (typeof body !== "string" || body.trim().length === 0) {
    return { error: "Invalid parameter: body must be a non-empty string" };
  }
  return { envelope: { to, cc, bcc, subject, body } };
}

function emailSendInputSchema(): LLMToolInputSchema {
  return {
    type: "object",
    properties: {
      to: {
        type: "array",
        items: { type: "string" },
        description:
          'Recipient addresses, e.g. ["alice@example.com", "Bob <bob@example.com>"].',
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
      subject: { type: "string", description: "The message subject." },
      body: { type: "string", description: "The plain-text message body." },
    },
    required: ["to", "subject", "body"],
  };
}

/**
 * Build a send-style email `Tool`, mirroring emailListCapability /
 * emailSearchCapability: the builder owns the executor scaffolding
 * (credential check, envelope validation, error wrapping); a service supplies
 * its name, description, scope requirement, and the call that transmits (real
 * API vs. canned acknowledgement). Gmail and the mock share one schema and
 * one recipient-address noun rule, so the governed shape cannot drift
 * (mock parity).
 *
 * Send is a consequential verb: with no seeded grant it holds for
 * confirmation on first use, and the noun — the exact recipient-address set
 * — means any change to the recipients, even a new address inside an
 * already-granted domain, re-confirms.
 */
export function emailSendCapability(opts: {
  service: string;
  description: string;
  /** Threaded onto the returned Tool (see Tool.requiredScopes). */
  requiredScopes?: string[];
  execute: (
    token: string,
    params: EmailSendParams,
  ) => Promise<unknown> | unknown;
}): Tool {
  return {
    service: opts.service,
    verb: "send",
    description: opts.description,
    requiredScopes: opts.requiredScopes,
    inputSchema: emailSendInputSchema(),
    nounExtractor: recipientAddressesNoun,
    execute: async (params, ctx) => {
      const token = ctx.credential?.access_token;
      if (!token) {
        return {
          success: false,
          error: `No credential found for service: ${opts.service}`,
        };
      }
      const normalized = normalizeEmailEnvelope(params);
      if ("error" in normalized) {
        return { success: false, error: normalized.error };
      }
      try {
        const data = await opts.execute(token, normalized.envelope);
        return { success: true, data };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Tool execution failed";
        return { success: false, error: message };
      }
    },
  };
}
