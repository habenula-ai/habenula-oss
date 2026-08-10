// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { emailListCapability } from "../shared/email.js";
import { emailSearchCapability } from "../shared/email-search.js";
import { emailSendCapability } from "../shared/email-send.js";
import type { Tool } from "../../tools/types.js";
import type { ServiceDefinition } from "../types.js";
import {
  executeMockEmailList,
  executeMockEmailSearch,
  executeMockEmailSend,
  MOCK_EMAIL_LABELS,
} from "./mock-email-data.js";

export * from "./mock-email-data.js";

/**
 * The one scope the mock's read-shaped tools require. The mock provider mints
 * its credential from `mockEmail.connect.scopes`, so a normally-connected
 * mock always passes the scope precondition — the gate exists here for parity
 * with gmail, not to fire in onboarding.
 */
const MOCK_EMAIL_READ_SCOPES = ["email.read"];

/**
 * Mock email list tool — returns canned onboarding data. Makes no external
 * call, but inherits the shared credential check and error wrapping so it is
 * not a special case.
 */
export const MOCK_EMAIL_LIST: Tool = emailListCapability({
  service: "mock_email",
  labels: MOCK_EMAIL_LABELS,
  defaultLabel: "INBOX",
  description:
    "List email messages from the user's mock email account, an onboarding sandbox with canned data. Returns message metadata (subject, sender, date).",
  requiredScopes: MOCK_EMAIL_READ_SCOPES,
  execute: (_token, params) => executeMockEmailList(params),
});

/**
 * Mock email search tool — searches the canned data, so the search flow
 * (query → governed label noun → results) is demoable without a live Gmail
 * account. Shares the gmail search tool's schema and
 * noun resolver via the same factory.
 */
export const MOCK_EMAIL_SEARCH: Tool = emailSearchCapability({
  service: "mock_email",
  description:
    "Search email messages in the user's mock email account, an onboarding sandbox with canned data. Supports Gmail-style query syntax. Returns message metadata (subject, sender, date).",
  requiredScopes: MOCK_EMAIL_READ_SCOPES,
  execute: (_token, params) => executeMockEmailSearch(params),
});

/**
 * Mock email send tool — the consequential-verb demo surface: the
 * recipient-address noun, the confirmation hold,
 * and the audit trail all run for real; only the transmission is canned.
 * Shares gmail_send's schema and noun rule via the same factory.
 */
export const MOCK_EMAIL_SEND: Tool = {
  ...emailSendCapability({
    service: "mock_email",
    description:
      "Send an email from the user's mock email account, an onboarding sandbox — the send is acknowledged but no real email is transmitted.",
    requiredScopes: ["email.send"],
    execute: (_token, params) => executeMockEmailSend(params),
  }),
  // The onboarding demo of structured iteration: a
  // commissioned send needs its recipient, so `to` is a REQUIRED published data
  // slot. A commission that omits it parks `needs_input` naming `to`, which the
  // client answers with `habenula_provide`. Confined to the mock send so the
  // gmail send surface is unchanged. (`recipient` is deliberately not the key —
  // the suite reserves it as the canonical *unpublished* example.)
  dataSlots: [
    {
      key: "to",
      description:
        "The recipient address the email is sent to; reference it in your goal as {{data.to}}.",
      required: true,
    },
  ],
};

/**
 * The mock_email service: declarative data only. Its OAuth machinery lives on
 * the `mock` provider strategy; these scopes are the source of truth for the
 * credential the mock mints — the shared callback threads them into
 * `generateMockTokens` via `exchangeCode`.
 */
export const mockEmail: ServiceDefinition = {
  service: "mock_email",
  connect: {
    type: "oauth",
    provider: "mock",
    scopes: ["email.read", "email.send"],
  },
  tools: [MOCK_EMAIL_LIST, MOCK_EMAIL_SEARCH, MOCK_EMAIL_SEND],
};
