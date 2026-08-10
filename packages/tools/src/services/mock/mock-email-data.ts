// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { assertEmailListParams, type EmailListParams } from "../shared/email.js";
import {
  parseEmailSearchQuery,
  type EmailSearchParams,
} from "../shared/email-search.js";
import type { EmailSendParams } from "../shared/email-send.js";

/**
 * The mock's list-tool vocabulary: the three onboarding mailboxes it holds
 * canned data for. Narrower than Gmail's system-label set — each service owns
 * its own vocabulary.
 */
export const MOCK_EMAIL_LABELS = ["INBOX", "SENT", "DRAFTS"] as const;

export type MockEmailLabel = (typeof MOCK_EMAIL_LABELS)[number];

export interface MockEmailMessage {
  subject: string;
  sender: string;
  timestamp: string; // ISO 8601
}

export interface MockEmailListResult {
  messages: MockEmailMessage[];
}

const INBOX_MESSAGES: MockEmailMessage[] = [
  {
    subject: "Team standup moved to 10am starting Monday",
    sender: "priya.chen@company.com",
    timestamp: "2026-04-07T09:15:00Z",
  },
  {
    subject: "Your Amazon order has shipped",
    sender: "shipment-tracking@amazon.com",
    timestamp: "2026-04-07T08:42:00Z",
  },
  {
    subject: "Re: Q2 planning doc — comments added",
    sender: "marcus.williams@company.com",
    timestamp: "2026-04-07T07:58:00Z",
  },
  {
    subject: "Invitation: Design review @ Wed Apr 9, 2pm",
    sender: "calendar-noreply@google.com",
    timestamp: "2026-04-06T22:30:00Z",
  },
  {
    subject: "Your weekly digest from Hacker News",
    sender: "digest@hackernewsletter.com",
    timestamp: "2026-04-06T18:00:00Z",
  },
  {
    subject: "Flight confirmation: SFO → JFK Apr 15",
    sender: "no-reply@united.com",
    timestamp: "2026-04-06T14:22:00Z",
  },
  {
    subject: "Can you review my PR before EOD?",
    sender: "alex.rodriguez@company.com",
    timestamp: "2026-04-06T11:05:00Z",
  },
  {
    subject: "New comment on your Google Doc",
    sender: "comments-noreply@docs.google.com",
    timestamp: "2026-04-06T09:30:00Z",
  },
  {
    subject: "Reminder: dentist appointment tomorrow at 3pm",
    sender: "reminders@dentistoffice.com",
    timestamp: "2026-04-05T20:00:00Z",
  },
  {
    subject: "Invoice #4821 from Figma",
    sender: "billing@figma.com",
    timestamp: "2026-04-05T16:45:00Z",
  },
];

const SENT_MESSAGES: MockEmailMessage[] = [
  {
    subject: "Re: Q2 planning doc — comments added",
    sender: "me",
    timestamp: "2026-04-07T08:10:00Z",
  },
  {
    subject: "Updated project timeline attached",
    sender: "me",
    timestamp: "2026-04-06T17:30:00Z",
  },
  {
    subject: "Re: Can you review my PR before EOD?",
    sender: "me",
    timestamp: "2026-04-06T12:00:00Z",
  },
  {
    subject: "Lunch next week?",
    sender: "me",
    timestamp: "2026-04-05T15:20:00Z",
  },
  {
    subject: "Re: Flight confirmation: SFO → JFK Apr 15",
    sender: "me",
    timestamp: "2026-04-05T14:45:00Z",
  },
];

const DRAFTS_MESSAGES: MockEmailMessage[] = [
  {
    subject: "Blog post draft: Why governance matters for AI agents",
    sender: "me",
    timestamp: "2026-04-07T06:00:00Z",
  },
  {
    subject: "Re: Partnership proposal from Acme Corp",
    sender: "me",
    timestamp: "2026-04-06T10:15:00Z",
  },
  {
    subject: "Feedback on new onboarding flow",
    sender: "me",
    timestamp: "2026-04-05T13:00:00Z",
  },
];

// Keyed by the mock's vocabulary union so a new label is a tsc error here.
const LABEL_DATA: Record<MockEmailLabel, MockEmailMessage[]> = {
  INBOX: INBOX_MESSAGES,
  SENT: SENT_MESSAGES,
  DRAFTS: DRAFTS_MESSAGES,
};

/**
 * Mock email list tool. Returns realistic canned email data for onboarding.
 * This is a production feature — users interact with mock data before
 * connecting real credentials, building trust in the governance pipeline.
 */
export function executeMockEmailList(
  params: EmailListParams<MockEmailLabel>
): MockEmailListResult {
  assertEmailListParams(params, MOCK_EMAIL_LABELS);
  const messages = LABEL_DATA[params.label];

  return { messages: messages.slice(0, params.maxResults) };
}

export interface MockEmailSearchResult {
  messages: MockEmailMessage[];
}

/**
 * Noun token → the mock mailboxes it denotes (the shared resolver emits
 * Gmail's singular DRAFT id for the drafts mailbox). A token absent here
 * (SPAM, STARRED, `label:<user>`) names a mailbox the mock does not hold: it
 * narrows the searched set to nothing rather than being ignored, so the data
 * a search returns never exceeds what its governed noun claims — a search
 * consented as STARRED must not read INBOX.
 */
const NOUN_MAILBOXES: Record<string, MockEmailLabel[]> = {
  INBOX: ["INBOX"],
  SENT: ["SENT"],
  DRAFT: ["DRAFTS"],
};

/**
 * Mock email search tool: matches the canned data so the search flow is
 * demoable without a live account. Mailbox filters come from the shared query
 * parse — the same one the noun resolver uses, so the searched set always
 * stays within the governed noun. Of the non-mailbox operators, `from:` and
 * `subject:` narrow against the fields the mock actually holds; the rest
 * (`is:unread`, `has:attachment`, …) filter nothing here and are dropped.
 * Bare terms must all appear (case-insensitive) in a message's subject or
 * sender.
 */
export function executeMockEmailSearch(
  params: EmailSearchParams,
): MockEmailSearchResult {
  const { mailboxes, anywhere, rest } = parseEmailSearchQuery(params.q);

  const searched =
    anywhere || mailboxes.size === 0
      ? [...MOCK_EMAIL_LABELS]
      : [...mailboxes].flatMap((noun) => NOUN_MAILBOXES[noun] ?? []);

  const senderTerms: string[] = [];
  const subjectTerms: string[] = [];
  const terms: string[] = [];
  for (const token of rest) {
    const operator = /^([a-z_]+):(.+)$/.exec(token);
    if (!operator) {
      terms.push(token);
    } else if (operator[1] === "from") {
      senderTerms.push(operator[2]!);
    } else if (operator[1] === "subject") {
      subjectTerms.push(operator[2]!);
    }
  }

  const messages = searched
    .flatMap((label) => LABEL_DATA[label])
    .filter((message) => {
      const subject = message.subject.toLowerCase();
      const sender = message.sender.toLowerCase();
      return (
        senderTerms.every((term) => sender.includes(term)) &&
        subjectTerms.every((term) => subject.includes(term)) &&
        terms.every((term) => subject.includes(term) || sender.includes(term))
      );
    });

  return { messages: messages.slice(0, params.maxResults) };
}

/** The canned acknowledgement a mock send returns — shaped like Gmail's
 * send result (id + threadId) plus an explicit sandbox notice. */
export interface MockEmailSendResult {
  id: string;
  threadId: string;
  to: string[];
  subject: string;
  notice: string;
}

let sentCount = 0;

/**
 * Mock email send: transmits nothing — returns a canned acknowledgement so
 * the consequential-verb flow (recipient-address noun → hold → confirm →
 * dispatch) is demoable end-to-end without a live account. The counter only
 * disambiguates ids within one DO lifetime; nothing persists.
 */
export function executeMockEmailSend(
  params: EmailSendParams,
): MockEmailSendResult {
  sentCount++;
  return {
    id: `mock-sent-${sentCount}`,
    threadId: `mock-thread-${sentCount}`,
    to: params.to,
    subject: params.subject,
    notice: "Sandbox send: no real email was transmitted.",
  };
}
