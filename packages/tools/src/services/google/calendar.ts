// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Tool, ToolExecutionResult } from "../../tools/types.js";
import { recipientDomain } from "../shared/recipients.js";
import type { ServiceDefinition } from "../types.js";
import type {
  CalendarEventInput,
  CalendarEventTime,
  CalendarSendUpdates,
} from "./calendar-client.js";
import {
  deleteEvent,
  getEvent,
  insertEvent,
  listEvents,
  patchEvent,
  resolveCalendarId,
  respondToEvent,
} from "./calendar-client.js";

export * from "./calendar-client.js";

/**
 * The requested scope set (`connect.scopes`) — least-privilege for read+write
 * over events plus calendar-name resolution (verified 2026-07-11).
 * `calendar.events` reads and writes events and is
 * deliberately narrower than full `calendar` (no calendar creation, sharing,
 * or deletion); `calendar.calendarlist.readonly` covers only
 * `calendarList.list`, needed to resolve named calendars.
 */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

/** The capability classes Calendar tools declare. */
export type CalendarCapability = "read" | "write";

/**
 * Capability → the granted scopes ANY ONE of which covers it, feeding the
 * generic pre-policy scope precondition. Calendar requests only
 * `calendar.events` — one scope carrying both capabilities — so the gate is
 * effectively binary: decline it at consent and all seven tools return
 * needs_authorization; grant it and all seven clear. The broader
 * `calendar.readonly` / `calendar` scopes are covered but never requested
 * (a credential is judged by what it holds, gmail's map takes the same
 * posture on its umbrella scope).
 *
 * The name-resolution scope (`calendar.calendarlist.readonly`) is
 * deliberately absent: resolution is incidental to every verb, and a missing
 * resolution scope should surface as the self-correcting "unknown calendar"
 * tool error, not a scope denial — the posture Slack's channel-read scopes
 * take.
 */
export const CALENDAR_CAPABILITY_SCOPES: Record<CalendarCapability, string[]> =
  {
    read: [
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar",
    ],
    write: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar",
    ],
  };

/** Default result count for the event-reading tools when `maxResults` is omitted. */
export const CALENDAR_READ_DEFAULT_MAX_RESULTS = 25;

/** Upper bound on the event-reading tools' `maxResults`. */
export const CALENDAR_READ_MAX_RESULTS = 250;

/**
 * The fixed noun for a present-but-malformed `attendees` param — an empty
 * array or a non-array. Deliberately not a domain (no dot) and never
 * granted implicitly, mirroring NO_RECIPIENTS_NOUN; the executor rejects
 * both shapes as input errors regardless — on `update` an empty array
 * would be a guest-list WIPE (events.patch replaces the array wholesale),
 * too consequential to ride the calendar noun (clearing guests is
 * deferred), and a non-array must not mint a
 * plausible-looking domain noun for a call that can only error.
 */
export const EMPTY_ATTENDEES_NOUN = "empty-attendees";

/**
 * The folded calendar-name noun for `list`/`read`/`search`/`cancel`/
 * `respond`. Lower-cased on purpose: the client resolves calendar names
 * case-insensitively (prose a user types loosely, unlike Slack's lower-case
 * channel handles), and the noun must be the SAME function of the input as
 * resolution — `Work` and `work` produce one noun and resolve to one
 * calendar, so governance and resolution cannot disagree on identity.
 */
export function calendarNoun(params: Record<string, unknown>): string {
  return String(params.calendar ?? "primary")
    .trim()
    .toLowerCase();
}

/**
 * The write-verb noun for `create`/`update`, derived from the same
 * `attendees` param the executor's `sendUpdates` reads (one input, read
 * twice): naming attendees emails them, so the
 * governed reach is the invitee-domain set; naming none notifies no one, so
 * the noun falls back to the calendar (prefixed `calendar:` — collision-
 * proof because `recipientDomain` REJECTS colon-bearing domains, so a
 * crafted address like `x@calendar:primary` fails closed to its
 * `unparseable:` token instead of minting this prefix). Each address
 * parses through the shared fail-closed `recipientDomain` (an unparseable
 * attendee yields its `unparseable:` token, never silent coverage), then
 * de-dupe, sort, comma-join — the same set-noun discipline the email send
 * verbs apply (`recipientAddressesNoun`), over `attendees` instead of
 * to/cc/bcc. Kept at domain grain for now; alignment to email send's
 * address grain is deferred.
 */
export function calendarWriteNoun(params: Record<string, unknown>): string {
  const attendees = params.attendees;
  if (attendees === undefined || attendees === null) {
    return `calendar:${calendarNoun(params)}`;
  }
  // A non-array is an input error the executor always rejects
  // (resolveAttendees), so it takes the never-granted sentinel — the same
  // as the empty array — rather than being wrapped into a list that could
  // mint a plausible domain noun for a call that can only error.
  if (!Array.isArray(attendees) || attendees.length === 0) {
    return EMPTY_ATTENDEES_NOUN;
  }
  const domains = new Set(
    attendees.map((a) => recipientDomain(attendeeEmail(a))),
  );
  return [...domains].sort().join(",");
}

/**
 * One attendee entry's address, for the noun and the envelope alike. A
 * malformed entry (no string `email`) yields its string form, which
 * recipientDomain fail-closes to an `unparseable:` token — and the executor
 * rejects it as an input error before any fetch.
 */
function attendeeEmail(entry: unknown): string {
  if (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { email?: unknown }).email === "string"
  ) {
    return (entry as { email: string }).email;
  }
  return String(entry);
}

/**
 * An RFC3339 timestamp that carries its own UTC offset (Z or ±hh:mm).
 * Seconds are required — RFC3339 has no seconds-less form, and Google
 * rejects one; better our self-correcting error than an opaque 400.
 */
const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** The same instant shape without an offset — valid only alongside an explicit IANA `timeZone`. Case-insensitive like OFFSET_DATETIME: RFC3339 allows a lowercase `t`. */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/i;

/** An all-day date, YYYY-MM-DD. */
const ALL_DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one `start`/`end` value against the EventDateTime input schema
 * (the timezone decision pinned here): exactly one of
 * `dateTime`/`date`, and a timed `dateTime` must carry a UTC offset or an
 * explicit IANA `timeZone` — never silently assumed UTC or the account's
 * zone (fail-closed). An all-day `date` needs no zone.
 */
function invalidEventTime(value: unknown, field: string): string | null {
  const invalid = (reason: string) =>
    `Invalid parameter: ${field} ${reason}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(
      "must be an object with exactly one of dateTime (RFC3339) or date (YYYY-MM-DD)",
    );
  }
  const { dateTime, date, timeZone } = value as CalendarEventTime;
  if ((dateTime === undefined) === (date === undefined)) {
    return invalid("must set exactly one of dateTime or date");
  }
  if (timeZone !== undefined && (typeof timeZone !== "string" || !timeZone)) {
    return invalid("timeZone must be a non-empty IANA zone name");
  }
  if (date !== undefined) {
    return typeof date === "string" && ALL_DAY_DATE.test(date)
      ? null
      : invalid("date must be an all-day YYYY-MM-DD value");
  }
  if (typeof dateTime !== "string") {
    return invalid("dateTime must be an RFC3339 string");
  }
  if (OFFSET_DATETIME.test(dateTime)) {
    return null;
  }
  if (LOCAL_DATETIME.test(dateTime)) {
    return timeZone
      ? null
      : invalid(
          "dateTime must carry a UTC offset (e.g. Z or -07:00) or the object must set timeZone",
        );
  }
  return invalid(
    "dateTime must be an RFC3339 timestamp with seconds, e.g. 2026-07-20T10:00:00-07:00",
  );
}

/** Validate a `timeMin`/`timeMax` bound: RFC3339 with an offset, required or not. */
function invalidTimeBound(
  value: unknown,
  field: string,
  required: boolean,
): string | null {
  if (value === undefined) {
    return required ? `Invalid parameter: ${field} is required` : null;
  }
  if (typeof value !== "string" || !OFFSET_DATETIME.test(value)) {
    return `Invalid parameter: ${field} must be an RFC3339 timestamp with a UTC offset (e.g. 2026-07-14T00:00:00Z)`;
  }
  return null;
}

/**
 * Validate the `attendees` param and derive the executor's `sendUpdates`
 * from it — the same single input the noun read.
 * Returns the envelope to transmit: `attendees` populated → the parsed list
 * + `sendUpdates=all`; omitted → no attendees key at all (events.patch must
 * not see `[]` — that wipes the guest list) + `sendUpdates=none`; an empty
 * array or a malformed entry → an input error. An address must be BARE
 * (`ana@example.com`): the Calendar API's `attendees[].email` field is not
 * an RFC5322 header, so a display-name form (`Ana <ana@example.com>`) that
 * gmail's envelope would accept is rejected here with a self-correcting
 * error instead of Google's opaque 400. Fail-safe against the noun either
 * way: recipientDomain parses the display-name form to the same domain the
 * bare address carries, so the noun is never narrower than what could
 * transmit.
 */
function resolveAttendees(
  value: unknown,
):
  | { attendees?: { email: string }[]; sendUpdates: CalendarSendUpdates }
  | { error: string } {
  if (value === undefined || value === null) {
    return { sendUpdates: "none" };
  }
  if (!Array.isArray(value)) {
    return {
      error:
        "Invalid parameter: attendees must be an array of { email } objects",
    };
  }
  if (value.length === 0) {
    return {
      error:
        "Invalid parameter: attendees must not be an empty array — omit it " +
        "to leave the guest list untouched (clearing all guests is not supported)",
    };
  }
  const emails: string[] = [];
  for (const entry of value) {
    const email = attendeeEmail(entry);
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { email?: unknown }).email !== "string" ||
      email.trim() === ""
    ) {
      return {
        error:
          "Invalid parameter: each attendee must be an object with a " +
          "non-empty string email",
      };
    }
    const trimmedEmail = email.trim();
    // Internal whitespace or angle brackets mark a display-name form (or a
    // pasted address list) — not a bare address the API field accepts.
    if (/[\s<>]/.test(trimmedEmail)) {
      return {
        error:
          "Invalid parameter: each attendee email must be a bare address " +
          "like ana@example.com — no display names or angle brackets",
      };
    }
    // Trimmed on push: the noun's parser (recipientDomain) trims before
    // extracting the domain, so the transmitted envelope must too — one
    // input, read twice, byte-identical addresses.
    emails.push(trimmedEmail);
  }
  return { attendees: emails.map((email) => ({ email })), sendUpdates: "all" };
}

function isValidMaxResults(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= CALENDAR_READ_MAX_RESULTS
  );
}

/**
 * Required-string re-validation shared by every executor. The input schema
 * is advisory to the LLM, not enforced upstream, so each executor
 * re-validates before any fetch (the Slack posture).
 */
function invalidString(value: unknown, description: string): string | null {
  if (typeof value !== "string" || value === "") {
    return `Invalid parameter: ${description}`;
  }
  return null;
}

/**
 * Optional free-text params (`description`/`location`): a string when
 * present. The empty string is legal — on `update` it is how a field is
 * cleared — but a non-string must error rather than silently vanish from
 * the request (which on `update` cascades into the misleading "requires at
 * least one field to change").
 */
function invalidOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || typeof value === "string") {
    return null;
  }
  return `Invalid parameter: ${field} must be a string when provided`;
}

/**
 * The optional calendar param the tools govern on (defaulted to primary).
 * Whitespace-only is rejected along with empty: it folds to the empty noun
 * and can never resolve, so it must fail as an input error, not reach the
 * API as a doomed lookup.
 */
function invalidCalendar(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return "Invalid parameter: calendar must be a non-empty calendar name when provided";
  }
  return null;
}

function invalidEventId(value: unknown): string | null {
  return invalidString(value, "eventId must be a non-empty event id");
}

function toErrorResult(err: unknown): ToolExecutionResult {
  const message = err instanceof Error ? err.message : "Tool execution failed";
  return { success: false, error: message };
}

const NO_CREDENTIAL: ToolExecutionResult = {
  success: false,
  error: "No credential found for service: google_calendar",
};

/** The shared `calendar` input-schema property. */
const CALENDAR_PROPERTY = {
  type: "string",
  description:
    "Calendar name, e.g. primary or Work. Matched case-insensitively; " +
    "defaults to primary (the user's main calendar).",
};

/** The shared start/end EventDateTime input-schema property. */
function eventTimeProperty(field: "start" | "end"): Record<string, unknown> {
  return {
    type: "object",
    description:
      `Event ${field} time. Exactly one of dateTime or date. A dateTime ` +
      "must include a UTC offset (e.g. 2026-07-20T10:00:00-07:00 or ...Z) " +
      "or the object must set timeZone to an IANA zone (e.g. " +
      "America/Los_Angeles); use date (YYYY-MM-DD) for all-day events.",
    properties: {
      dateTime: {
        type: "string",
        description: "RFC3339 timestamp for a timed event.",
      },
      date: {
        type: "string",
        description: "YYYY-MM-DD for an all-day event.",
      },
      timeZone: {
        type: "string",
        description: "IANA time zone name, e.g. America/Los_Angeles.",
      },
    },
  };
}

const ATTENDEES_PROPERTY = {
  type: "array",
  description:
    "People to invite, each { email }. IMPORTANT: naming attendees INVITES " +
    "them — Google emails every listed attendee. Omit this field entirely " +
    "to touch no one; on update, a provided list REPLACES the event's " +
    "guest list (an empty array is rejected).",
  items: {
    type: "object",
    properties: {
      email: {
        type: "string",
        description:
          "Attendee email address — a bare address like ana@example.com, " +
          "no display name.",
      },
    },
    required: ["email"],
  },
};

const MAX_RESULTS_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: CALENDAR_READ_MAX_RESULTS,
  description:
    `Maximum number of events to return. Defaults to ` +
    `${CALENDAR_READ_DEFAULT_MAX_RESULTS}, at most ${CALENDAR_READ_MAX_RESULTS}.`,
};

/**
 * Read a calendar's events in a time window: resolve the folded calendar
 * name (the governed noun) to its id, then list with recurring events
 * expanded. Scaffolding (credential check, validation, error wrapping) is
 * inline — Calendar's event vocabulary does not fit the email-shaped
 * capability builder, exactly as Slack's did not.
 */
export const CALENDAR_LIST: Tool = {
  service: "google_calendar",
  verb: "list",
  description:
    "List events on one of the user's Google calendars within a time " +
    "window. Takes RFC3339 timeMin/timeMax bounds (with UTC offsets) and " +
    "an optional calendar name (defaults to primary). Returns event id, " +
    "title, times, and attendees. truncated: true in the result means more " +
    "events matched than maxResults — narrow the window or raise maxResults.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.read,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      timeMin: {
        type: "string",
        description:
          "Window start, RFC3339 with a UTC offset, e.g. 2026-07-14T00:00:00Z.",
      },
      timeMax: {
        type: "string",
        description:
          "Window end, RFC3339 with a UTC offset, e.g. 2026-07-15T00:00:00Z.",
      },
      maxResults: MAX_RESULTS_PROPERTY,
    },
    required: ["timeMin", "timeMax"],
  },
  nounExtractor: calendarNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidCalendar(params.calendar) ??
      invalidTimeBound(params.timeMin, "timeMin", true) ??
      invalidTimeBound(params.timeMax, "timeMax", true);
    if (error) {
      return { success: false, error };
    }
    const maxResults = params.maxResults ?? CALENDAR_READ_DEFAULT_MAX_RESULTS;
    if (!isValidMaxResults(maxResults)) {
      return {
        success: false,
        error: `Invalid parameter: maxResults must be an integer between 1 and ${CALENDAR_READ_MAX_RESULTS}`,
      };
    }
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const { events, truncated } = await listEvents(token, {
        calendarId,
        timeMin: params.timeMin as string,
        timeMax: params.timeMax as string,
        maxResults,
      });
      return {
        success: true,
        data: { calendar, events, ...(truncated ? { truncated: true } : {}) },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Read one event by id. The event id is audited parameter metadata, not the
 * noun — the calendar is the governed object.
 */
export const CALENDAR_READ: Tool = {
  service: "google_calendar",
  verb: "read",
  description:
    "Read one event from a Google calendar by its event id (e.g. from " +
    "google_calendar_list). Returns full event details including attendees " +
    "and their RSVP statuses.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.read,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      eventId: {
        type: "string",
        description: "The event's id, e.g. from google_calendar_list.",
      },
    },
    required: ["eventId"],
  },
  nounExtractor: calendarNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error = invalidCalendar(params.calendar) ?? invalidEventId(params.eventId);
    if (error) {
      return { success: false, error };
    }
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const event = await getEvent(token, {
        calendarId,
        eventId: params.eventId as string,
      });
      return { success: true, data: { calendar, event } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Search one calendar's events by free text. There is no cross-calendar
 * search — search binds to one calendar like list/read.
 */
export const CALENDAR_SEARCH: Tool = {
  service: "google_calendar",
  verb: "search",
  description:
    "Search events on one of the user's Google calendars by free text " +
    "(matches title, description, location, attendees). Takes the query " +
    "and optional RFC3339 timeMin/timeMax bounds (with UTC offsets). " +
    "Searches from now onward unless bounds are given — pass timeMin to " +
    "search the past. truncated: true in the result means more events " +
    "matched than maxResults — narrow the bounds or raise maxResults.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.read,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      q: {
        type: "string",
        description: "Free-text search query, e.g. dentist.",
      },
      timeMin: {
        type: "string",
        description:
          "Optional window start, RFC3339 with a UTC offset. Defaults to " +
          "now — pass an earlier timeMin to search the past.",
      },
      timeMax: {
        type: "string",
        description: "Optional window end, RFC3339 with a UTC offset.",
      },
      maxResults: MAX_RESULTS_PROPERTY,
    },
    required: ["q"],
  },
  nounExtractor: calendarNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidCalendar(params.calendar) ??
      invalidString(params.q, "q must be a non-empty search query") ??
      invalidTimeBound(params.timeMin, "timeMin", false) ??
      invalidTimeBound(params.timeMax, "timeMax", false);
    if (error) {
      return { success: false, error };
    }
    const maxResults = params.maxResults ?? CALENDAR_READ_DEFAULT_MAX_RESULTS;
    if (!isValidMaxResults(maxResults)) {
      return {
        success: false,
        error: `Invalid parameter: maxResults must be an integer between 1 and ${CALENDAR_READ_MAX_RESULTS}`,
      };
    }
    // No bounds at all: default to searching from now onward. An unbounded
    // search returns the OLDEST matches first (orderBy=startTime over all
    // history), burying the upcoming events a bare search almost always
    // means. A timeMax-only call is an explicit past search and gets no
    // injected floor; the description tells the model timeMin reaches back.
    const timeMin =
      (params.timeMin as string | undefined) ??
      (params.timeMax === undefined ? new Date().toISOString() : undefined);
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const { events, truncated } = await listEvents(token, {
        calendarId,
        q: params.q as string,
        ...(timeMin ? { timeMin } : {}),
        ...(params.timeMax ? { timeMax: params.timeMax as string } : {}),
        maxResults,
      });
      return {
        success: true,
        data: { calendar, events, ...(truncated ? { truncated: true } : {}) },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Create an event. The governed noun and the notification setting derive
 * from the SAME `attendees` param: naming attendees
 * governs their domains and notifies them (`sendUpdates=all`); naming none
 * governs the calendar and notifies no one (`sendUpdates=none`).
 */
export const CALENDAR_CREATE: Tool = {
  service: "google_calendar",
  verb: "create",
  description:
    "Create an event on one of the user's Google calendars. Takes a title, " +
    "start and end times, and optionally attendees, description, and " +
    "location. Naming attendees INVITES them — Google emails each one; " +
    "omit attendees to add a quiet event that notifies no one.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.write,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      summary: { type: "string", description: "Event title." },
      start: eventTimeProperty("start"),
      end: eventTimeProperty("end"),
      attendees: ATTENDEES_PROPERTY,
      description: {
        type: "string",
        description: "Optional event description.",
      },
      location: { type: "string", description: "Optional event location." },
    },
    required: ["summary", "start", "end"],
  },
  nounExtractor: calendarWriteNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error =
      invalidCalendar(params.calendar) ??
      invalidString(params.summary, "summary must be a non-empty title") ??
      invalidEventTime(params.start, "start") ??
      invalidEventTime(params.end, "end") ??
      invalidOptionalText(params.description, "description") ??
      invalidOptionalText(params.location, "location");
    if (error) {
      return { success: false, error };
    }
    const resolved = resolveAttendees(params.attendees);
    if ("error" in resolved) {
      return { success: false, error: resolved.error };
    }
    const calendar = calendarNoun(params);
    const event: CalendarEventInput = {
      summary: params.summary as string,
      start: params.start as CalendarEventTime,
      end: params.end as CalendarEventTime,
      ...(resolved.attendees ? { attendees: resolved.attendees } : {}),
      ...(params.description !== undefined
        ? { description: params.description as string }
        : {}),
      ...(params.location !== undefined
        ? { location: params.location as string }
        : {}),
    };
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const created = await insertEvent(token, {
        calendarId,
        event,
        sendUpdates: resolved.sendUpdates,
      });
      return { success: true, data: { calendar, event: created } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Update an event via events.patch: only named fields change — except
 * `attendees`, which Google replaces WHOLESALE when named (the accepted
 * partial-removal residual). An absent attendees
 * param never enters the patch body, preserving the stored guest list; an
 * empty array is rejected as a wipe. Noun and sendUpdates derive from the
 * same attendees param, as on create.
 */
export const CALENDAR_UPDATE: Tool = {
  service: "google_calendar",
  verb: "update",
  description:
    "Update an event on one of the user's Google calendars by event id. " +
    "Only the fields provided change. Providing attendees REPLACES the " +
    "event's whole guest list and Google emails everyone listed; omit " +
    "attendees to edit quietly without touching or notifying guests.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.write,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      eventId: {
        type: "string",
        description: "The event's id, e.g. from google_calendar_list.",
      },
      summary: { type: "string", description: "New event title." },
      start: eventTimeProperty("start"),
      end: eventTimeProperty("end"),
      attendees: ATTENDEES_PROPERTY,
      description: { type: "string", description: "New event description." },
      location: { type: "string", description: "New event location." },
    },
    required: ["eventId"],
  },
  nounExtractor: calendarWriteNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    let error = invalidCalendar(params.calendar) ?? invalidEventId(params.eventId);
    if (!error && params.summary !== undefined) {
      error = invalidString(params.summary, "summary must be a non-empty title");
    }
    if (!error && params.start !== undefined) {
      error = invalidEventTime(params.start, "start");
    }
    if (!error && params.end !== undefined) {
      error = invalidEventTime(params.end, "end");
    }
    if (!error) {
      error =
        invalidOptionalText(params.description, "description") ??
        invalidOptionalText(params.location, "location");
    }
    if (error) {
      return { success: false, error };
    }
    const resolved = resolveAttendees(params.attendees);
    if ("error" in resolved) {
      return { success: false, error: resolved.error };
    }
    const event: CalendarEventInput = {
      ...(params.summary !== undefined
        ? { summary: params.summary as string }
        : {}),
      ...(params.start !== undefined
        ? { start: params.start as CalendarEventTime }
        : {}),
      ...(params.end !== undefined
        ? { end: params.end as CalendarEventTime }
        : {}),
      ...(resolved.attendees ? { attendees: resolved.attendees } : {}),
      ...(params.description !== undefined
        ? { description: params.description as string }
        : {}),
      ...(params.location !== undefined
        ? { location: params.location as string }
        : {}),
    };
    if (Object.keys(event).length === 0) {
      return {
        success: false,
        error:
          "Invalid parameter: update requires at least one field to change",
      };
    }
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const updated = await patchEvent(token, {
        calendarId,
        eventId: params.eventId as string,
        event,
        sendUpdates: resolved.sendUpdates,
      });
      return { success: true, data: { calendar, event: updated } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * Cancel (delete) an event. Governs the calendar, not the notification
 * reach: the people a cancellation reaches live on the STORED event, not
 * the call, and nouns must be knowable synchronously — the posture
 * gmail_trash takes. The event id is audited metadata.
 * Attendees are notified (`sendUpdates=all`): a silent cancellation strands
 * guests at a dead slot.
 */
export const CALENDAR_CANCEL: Tool = {
  service: "google_calendar",
  verb: "cancel",
  description:
    "Cancel (delete) an event on one of the user's Google calendars by " +
    "event id. Google notifies the event's attendees of the cancellation.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.write,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      eventId: {
        type: "string",
        description: "The event's id, e.g. from google_calendar_list.",
      },
    },
    required: ["eventId"],
  },
  nounExtractor: calendarNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error = invalidCalendar(params.calendar) ?? invalidEventId(params.eventId);
    if (error) {
      return { success: false, error };
    }
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      await deleteEvent(token, {
        calendarId,
        eventId: params.eventId as string,
        sendUpdates: "all",
      });
      return {
        success: true,
        data: { calendar, eventId: params.eventId, cancelled: true },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * RSVP to an event the user was invited to. Governed by the calendar name
 * at low consequence — the RSVP writes the user's own attendance and tells
 * the organizer, one already-known party.
 * `sendUpdates=none`: the RSVP is event data that syncs to the organizer's
 * copy regardless; none only suppresses the guest-facing change blast
 * (see respondToEvent).
 */
export const CALENDAR_RESPOND: Tool = {
  service: "google_calendar",
  verb: "respond",
  description:
    "RSVP to an event the user was invited to: accept, decline, or mark " +
    "tentative. Takes the event id and the response. The organizer sees " +
    "the updated response; other guests are not notified.",
  requiredScopes: CALENDAR_CAPABILITY_SCOPES.write,
  inputSchema: {
    type: "object",
    properties: {
      calendar: CALENDAR_PROPERTY,
      eventId: {
        type: "string",
        description: "The event's id, e.g. from google_calendar_list.",
      },
      responseStatus: {
        type: "string",
        enum: ["accepted", "declined", "tentative"],
        description: "The user's RSVP.",
      },
    },
    required: ["eventId", "responseStatus"],
  },
  nounExtractor: calendarNoun,
  execute: async (params, ctx) => {
    const token = ctx.credential?.access_token;
    if (!token) {
      return NO_CREDENTIAL;
    }
    const error = invalidCalendar(params.calendar) ?? invalidEventId(params.eventId);
    if (error) {
      return { success: false, error };
    }
    const responseStatus = params.responseStatus;
    if (
      responseStatus !== "accepted" &&
      responseStatus !== "declined" &&
      responseStatus !== "tentative"
    ) {
      return {
        success: false,
        error:
          "Invalid parameter: responseStatus must be accepted, declined, or tentative",
      };
    }
    const calendar = calendarNoun(params);
    try {
      const calendarId = await resolveCalendarId(token, calendar);
      const event = await respondToEvent(token, {
        calendarId,
        eventId: params.eventId as string,
        responseStatus,
        sendUpdates: "none",
      });
      return { success: true, data: { calendar, responseStatus, event } };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};

/**
 * The google_calendar service: declarative data only. Its OAuth machinery
 * lives on the existing `google` provider strategy — Calendar is the second
 * real google service and contributes just its scopes and tools.
 * CALENDAR_LIST stays first — the iterated catalog
 * invariants exercise each service's first tool.
 */
export const googleCalendar: ServiceDefinition = {
  service: "google_calendar",
  connect: {
    type: "oauth",
    provider: "google",
    scopes: CALENDAR_SCOPES,
  },
  tools: [
    CALENDAR_LIST,
    CALENDAR_READ,
    CALENDAR_SEARCH,
    CALENDAR_CREATE,
    CALENDAR_UPDATE,
    CALENDAR_CANCEL,
    CALENDAR_RESPOND,
  ],
};
