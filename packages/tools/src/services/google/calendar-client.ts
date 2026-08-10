// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

type FetchFn = typeof globalThis.fetch;

/** Page size for calendarList.list — Google's documented maximum. */
const CALENDAR_LIST_PAGE_SIZE = 250;

/**
 * Defensive ceiling on pages fetched per listing loop. Google documents
 * that a page may be short or empty while more pages remain, so both
 * paging loops are open-ended by design — but each page is a Workers
 * subrequest, and the platform caps subrequests per invocation. Without a
 * ceiling, a pathological listing (an endless token chain, thousands of
 * near-empty pages) would exhaust that cap and surface as an opaque
 * platform error instead of a tool-level one. Ten pages covers 2,500
 * calendars in resolveCalendarId and the 250-event read cap in listEvents
 * even at heavy recurring-expansion shortfall.
 */
const MAX_LISTING_PAGES = 10;

export class CalendarApiError extends Error {
  constructor(
    /** Machine-readable code (`unknown_calendar`, `http_403`, …). */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

/**
 * Google's EventDateTime: exactly one of `dateTime` (RFC3339) or `date`
 * (all-day, YYYY-MM-DD), plus an optional IANA `timeZone`. The tools'
 * input schema mirrors this shape 1:1.
 */
export interface CalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  /**
   * Marks the entry for the calendar this copy of the event appears on —
   * i.e. the authenticated user's own entry (verified 2026-07-14,
   * developers.google.com/workspace/calendar/api/v3/reference/events).
   * Read-only.
   */
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  /** Marks a resource entry (a booked meeting room). */
  resource?: boolean;
  /** The attendee's note on the invitation. */
  comment?: string;
  /** How many extra guests this attendee brings (a "+2"). */
  additionalGuests?: number;
}

/** The event fields the tools read back and surface to the model. */
export interface CalendarEvent {
  id: string;
  status: string;
  summary: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string };
}

/** The writable event fields `insertEvent`/`patchEvent` accept. */
export interface CalendarEventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  /**
   * When present, Google replaces the stored attendee array WHOLESALE
   * (patch overwrites arrays). Callers must leave this key out entirely to
   * preserve the stored guest list — serializing `attendees: []` for an
   * absent param would silently wipe it. The entry
   * shape carries every writable per-guest field, because the same
   * wholesale rule erases any field a patch-back omits (respondToEvent
   * round-trips them all); the tools' own input surface stays `{ email }`.
   */
  attendees?: {
    email: string;
    displayName?: string;
    optional?: boolean;
    resource?: boolean;
    comment?: string;
    additionalGuests?: number;
    responseStatus?: string;
  }[];
}

/**
 * Google's `sendUpdates` values (verified 2026-07-14, events.patch
 * reference): `all` notifies every guest, `externalOnly` non-Google guests
 * only, `none` sends no guest notifications. The tools derive this from the
 * same `attendees` param the governance noun reads — never agent-supplied.
 */
export type CalendarSendUpdates = "all" | "externalOnly" | "none";

/** Raw shapes as Google returns them; mapped before leaving the client. */
interface RawEvent {
  /**
   * Version tag for conditional modification: threading it back as an
   * `If-Match` header makes a patch fail with 412 instead of clobbering a
   * concurrent edit (verified 2026-07-14,
   * developers.google.com/workspace/calendar/api/guides/version-resources).
   * Kept on the raw shape only — the model never needs it.
   */
  etag?: string;
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    optional?: boolean;
    resource?: boolean;
    comment?: string;
    additionalGuests?: number;
  }[];
  organizer?: { email?: string; displayName?: string };
}

function toCalendarEvent(raw: RawEvent): CalendarEvent {
  return {
    id: raw.id ?? "",
    status: raw.status ?? "",
    summary: raw.summary ?? "",
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.location !== undefined ? { location: raw.location } : {}),
    ...(raw.start !== undefined ? { start: raw.start } : {}),
    ...(raw.end !== undefined ? { end: raw.end } : {}),
    ...(raw.attendees !== undefined
      ? {
          attendees: raw.attendees.map((a) => ({
            email: a.email ?? "",
            ...(a.displayName !== undefined
              ? { displayName: a.displayName }
              : {}),
            ...(a.responseStatus !== undefined
              ? { responseStatus: a.responseStatus }
              : {}),
            ...(a.self !== undefined ? { self: a.self } : {}),
            ...(a.organizer !== undefined ? { organizer: a.organizer } : {}),
            ...(a.optional !== undefined ? { optional: a.optional } : {}),
            ...(a.resource !== undefined ? { resource: a.resource } : {}),
            ...(a.comment !== undefined ? { comment: a.comment } : {}),
            ...(a.additionalGuests !== undefined
              ? { additionalGuests: a.additionalGuests }
              : {}),
          })),
        }
      : {}),
    ...(raw.organizer !== undefined ? { organizer: raw.organizer } : {}),
  };
}

/**
 * One Calendar API call. Google returns a non-2xx status with a JSON error
 * body on failure; the error's `message` is surfaced as the thrown message
 * (matching gmail-client's posture, with the Slack-style machine code).
 * The access token is used for a single request and never stored.
 */
async function calendarApiCall<T>(
  accessToken: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  init: {
    query?: Record<string, string>;
    jsonBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
  fetchFn: FetchFn,
): Promise<T> {
  const url = new URL(`${CALENDAR_API_BASE}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetchFn(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.jsonBody ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.jsonBody ? { body: JSON.stringify(init.jsonBody) } : {}),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      // Non-JSON error body; the status alone carries the failure.
    }
    throw new CalendarApiError(
      `http_${res.status}`,
      `Google Calendar request failed (${res.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  // events.delete answers 204 with an empty body.
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

/**
 * Resolve a human calendar name (the governed noun, e.g. `work`) to its
 * calendar id. `primary` is Google's built-in alias for the user's main
 * calendar and short-circuits with no lookup. Otherwise pages
 * `calendarList.list` to exhaustion, matching each entry's EFFECTIVE
 * display name — `summaryOverride` (the user's personal rename of a shared
 * calendar, "the summary that the authenticated user has set" — verified
 * 2026-07-14, CalendarList reference) when present, else `summary` (the
 * owner's title). That is exactly the one name the user sees in every
 * Google UI; a renamed calendar's hidden original title deliberately does
 * NOT match, since it could name a different calendar than the user means.
 * Both sides fold trim+lowercase — the SAME fold the nounExtractor applies
 * (`calendarNoun` in calendar.ts), so governance and resolution cannot
 * disagree on identity, and a display name that
 * differs only by edge whitespace still matches what the user visually
 * sees. Matches de-dupe by calendar id: calendarList pagination is not
 * snapshot-consistent, so an entry shifting pages mid-listing can appear
 * twice, and counting it twice would report a phantom ambiguity. Zero
 * matches and multiple DISTINCT matches each throw a self-correcting
 * error; the resolver never silently picks a first match.
 */
export async function resolveCalendarId(
  accessToken: string,
  name: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<string> {
  const folded = name.trim().toLowerCase();
  if (folded === "primary") {
    return "primary";
  }

  const matches = new Set<string>();
  let pageToken = "";
  let pages = 0;
  do {
    const data = await calendarApiCall<{
      items?: { id?: string; summary?: string; summaryOverride?: string }[];
      nextPageToken?: string;
    }>(
      accessToken,
      "GET",
      "/users/me/calendarList",
      {
        query: {
          maxResults: String(CALENDAR_LIST_PAGE_SIZE),
          ...(pageToken ? { pageToken } : {}),
        },
      },
      fetchFn,
    );
    pages += 1;

    for (const entry of data.items ?? []) {
      const label = (entry.summaryOverride ?? entry.summary ?? "")
        .trim()
        .toLowerCase();
      if (entry.id && label === folded) {
        matches.add(entry.id);
      }
    }
    pageToken = data.nextPageToken ?? "";
    // A partial listing cannot safely resolve: the name might match on an
    // unfetched page, turning a real ambiguity into a wrong single match.
    // So the page ceiling fails the whole resolution rather than answering
    // from what happened to be fetched.
    if (pageToken !== "" && pages >= MAX_LISTING_PAGES) {
      throw new CalendarApiError(
        "calendar_list_too_long",
        `The account's calendar list is too long to resolve names against ` +
          `(more than ${MAX_LISTING_PAGES * CALENDAR_LIST_PAGE_SIZE} ` +
          `entries); use "primary" or hide unused calendars in Google ` +
          `Calendar.`,
      );
    }
  } while (pageToken !== "");

  if (matches.size === 1) {
    return [...matches][0]!;
  }
  if (matches.size > 1) {
    throw new CalendarApiError(
      "ambiguous_calendar",
      `Ambiguous calendar name "${name}": ${matches.size} calendars share ` +
        `that name; rename one in Google Calendar or use a unique name.`,
    );
  }
  throw new CalendarApiError(
    "unknown_calendar",
    `Unknown or inaccessible calendar: ${name}`,
  );
}

export interface ListEventsParams {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
  /** Free-text search over event fields (`events.list` `q`). */
  q?: string;
  maxResults: number;
}

/**
 * List a calendar's events via `events.list`, recurring events expanded to
 * their instances (`singleEvents=true`, ordered by start time) —
 * series/instance editing is deferred. Search is this
 * same listing with `q`; both bind to one calendar.
 *
 * `maxResults` is a PER-PAGE cap, not a result-set promise: Google
 * documents that a page "may contain fewer events than maxResults, or none
 * at all, even if there are more events matching the query" (verified
 * 2026-07-14, events.list reference) — recurring-event expansion makes
 * short pages routine. So this pages `nextPageToken` (the resolveCalendarId
 * discipline) until `maxResults` events are gathered, the listing is
 * exhausted, or the MAX_LISTING_PAGES budget runs out. `truncated: true`
 * means the listing was not exhausted — the caller's cap or the page
 * budget was hit with more matches outstanding — never that events were
 * silently dropped. Unlike resolveCalendarId, hitting the page budget here
 * returns the gathered events rather than failing: a partial event listing
 * flagged truncated is still correct, where a partial name resolution is
 * not.
 */
export async function listEvents(
  accessToken: string,
  params: ListEventsParams,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<{ events: CalendarEvent[]; truncated: boolean }> {
  const events: CalendarEvent[] = [];
  let pageToken = "";
  let pages = 0;
  do {
    const data = await calendarApiCall<{
      items?: RawEvent[];
      nextPageToken?: string;
    }>(
      accessToken,
      "GET",
      `/calendars/${encodeURIComponent(params.calendarId)}/events`,
      {
        query: {
          singleEvents: "true",
          orderBy: "startTime",
          // Ask each page for only what is still needed, so the gathered
          // set can never overshoot the caller's cap.
          maxResults: String(params.maxResults - events.length),
          ...(params.timeMin ? { timeMin: params.timeMin } : {}),
          ...(params.timeMax ? { timeMax: params.timeMax } : {}),
          ...(params.q ? { q: params.q } : {}),
          ...(pageToken ? { pageToken } : {}),
        },
      },
      fetchFn,
    );
    events.push(...(data.items ?? []).map(toCalendarEvent));
    pageToken = data.nextPageToken ?? "";
    pages += 1;
  } while (
    pageToken !== "" &&
    events.length < params.maxResults &&
    pages < MAX_LISTING_PAGES
  );

  return { events, truncated: pageToken !== "" };
}

/** The raw `events.get`, kept internal so `etag` never leaves the client. */
async function fetchRawEvent(
  accessToken: string,
  params: { calendarId: string; eventId: string },
  fetchFn: FetchFn,
): Promise<RawEvent> {
  return calendarApiCall<RawEvent>(
    accessToken,
    "GET",
    `/calendars/${encodeURIComponent(params.calendarId)}/events/` +
      encodeURIComponent(params.eventId),
    {},
    fetchFn,
  );
}

/** Fetch one event by id via `events.get`. */
export async function getEvent(
  accessToken: string,
  params: { calendarId: string; eventId: string },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<CalendarEvent> {
  return toCalendarEvent(await fetchRawEvent(accessToken, params, fetchFn));
}

/** Create an event via `events.insert`. */
export async function insertEvent(
  accessToken: string,
  params: {
    calendarId: string;
    event: CalendarEventInput;
    sendUpdates: CalendarSendUpdates;
  },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<CalendarEvent> {
  const data = await calendarApiCall<RawEvent>(
    accessToken,
    "POST",
    `/calendars/${encodeURIComponent(params.calendarId)}/events`,
    {
      query: { sendUpdates: params.sendUpdates },
      jsonBody: params.event as Record<string, unknown>,
    },
    fetchFn,
  );
  return toCalendarEvent(data);
}

/**
 * Patch an event via `events.patch`. Unnamed fields are preserved, but a
 * named array — `attendees` — is replaced wholesale (see CalendarEventInput).
 * `ifMatch` (an etag from a prior read) makes the patch conditional: Google
 * answers 412 instead of applying it over a concurrent edit (verified
 * 2026-07-14, developers.google.com/workspace/calendar/api/guides/
 * version-resources). respondToEvent threads it; the update tool does not —
 * its patch transmits exactly the fields the model named, not a read-back.
 */
export async function patchEvent(
  accessToken: string,
  params: {
    calendarId: string;
    eventId: string;
    event: CalendarEventInput;
    sendUpdates: CalendarSendUpdates;
    ifMatch?: string;
  },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<CalendarEvent> {
  const data = await calendarApiCall<RawEvent>(
    accessToken,
    "PATCH",
    `/calendars/${encodeURIComponent(params.calendarId)}/events/` +
      encodeURIComponent(params.eventId),
    {
      query: { sendUpdates: params.sendUpdates },
      jsonBody: params.event as Record<string, unknown>,
      ...(params.ifMatch ? { headers: { "If-Match": params.ifMatch } } : {}),
    },
    fetchFn,
  );
  return toCalendarEvent(data);
}

/** Delete (cancel) an event via `events.delete`. Google answers 204. */
export async function deleteEvent(
  accessToken: string,
  params: {
    calendarId: string;
    eventId: string;
    sendUpdates: CalendarSendUpdates;
  },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<void> {
  await calendarApiCall<undefined>(
    accessToken,
    "DELETE",
    `/calendars/${encodeURIComponent(params.calendarId)}/events/` +
      encodeURIComponent(params.eventId),
    { query: { sendUpdates: params.sendUpdates } },
    fetchFn,
  );
}

/**
 * RSVP to an event. Calendar v3 has no dedicated RSVP endpoint, and
 * `events.patch` replaces the attendee array wholesale — so this composes
 * `events.get`, sets `responseStatus` on the authenticated user's own entry
 * (the one flagged `self: true` — verified 2026-07-14, Events resource
 * reference), and patches back the FULL attendee list so no other guest is
 * dropped. Wholesale replacement also erases any per-guest FIELD the
 * patch-back omits, so every writable attendee field (displayName,
 * optional, resource, comment, additionalGuests) rides through unchanged —
 * only self's responseStatus differs from what was read. The read-only
 * fields (id — the attendee's Profile ID, self, organizer; writability
 * verified 2026-07-14, Events resource reference) stay out of the patch
 * body; Google keys attendees by email. The caller passes
 * `sendUpdates=none`: the RSVP is event *data* that syncs to the
 * organizer's copy regardless — `none` only suppresses the guest-facing
 * "event changed" notification blast.
 *
 * The read's etag rides the patch as `If-Match`, so a concurrent edit in
 * the get-to-patch gap (an organizer adding a guest) fails the patch with
 * 412 instead of being silently reverted by the stale list. The 412 is
 * rethrown as a self-correcting retry instruction, not retried here: a
 * governed tool call is one audited attempt (the audit-before-execute
 * invariant), so the retry must be a fresh call.
 */
export async function respondToEvent(
  accessToken: string,
  params: {
    calendarId: string;
    eventId: string;
    responseStatus: "accepted" | "declined" | "tentative";
    sendUpdates: CalendarSendUpdates;
  },
  fetchFn: FetchFn = globalThis.fetch,
): Promise<CalendarEvent> {
  const raw = await fetchRawEvent(
    accessToken,
    { calendarId: params.calendarId, eventId: params.eventId },
    fetchFn,
  );
  const event = toCalendarEvent(raw);

  const attendees = event.attendees ?? [];
  if (!attendees.some((a) => a.self === true)) {
    throw new CalendarApiError(
      "not_an_attendee",
      `The user is not an attendee of event ${params.eventId}; ` +
        `only an invited attendee can respond.`,
    );
  }

  const updated = attendees.map((a) => ({
    email: a.email,
    ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
    ...(a.optional !== undefined ? { optional: a.optional } : {}),
    ...(a.resource !== undefined ? { resource: a.resource } : {}),
    ...(a.comment !== undefined ? { comment: a.comment } : {}),
    ...(a.additionalGuests !== undefined
      ? { additionalGuests: a.additionalGuests }
      : {}),
    ...(a.self === true
      ? { responseStatus: params.responseStatus }
      : a.responseStatus !== undefined
        ? { responseStatus: a.responseStatus }
        : {}),
  }));

  try {
    return await patchEvent(
      accessToken,
      {
        calendarId: params.calendarId,
        eventId: params.eventId,
        event: { attendees: updated },
        sendUpdates: params.sendUpdates,
        ...(raw.etag ? { ifMatch: raw.etag } : {}),
      },
      fetchFn,
    );
  } catch (err) {
    if (err instanceof CalendarApiError && err.code === "http_412") {
      throw new CalendarApiError(
        "event_modified",
        `Event ${params.eventId} was modified while the RSVP was being ` +
          `written; retry the respond call to work from the current event.`,
      );
    }
    throw err;
  }
}
