import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  googleCalendar,
  CALENDAR_LIST,
  CALENDAR_READ,
  CALENDAR_SEARCH,
  CALENDAR_CREATE,
  CALENDAR_UPDATE,
  CALENDAR_CANCEL,
  CALENDAR_RESPOND,
  CALENDAR_SCOPES,
  CALENDAR_CAPABILITY_SCOPES,
  CALENDAR_READ_MAX_RESULTS,
  EMPTY_ATTENDEES_NOUN,
  calendarNoun,
  calendarWriteNoun,
} from "../../../src/services/google/calendar";
import type { Tool } from "../../../src/tools/types";

/**
 * Canned Calendar API fetch covering every endpoint the tools speak: a
 * calendar list with one uniquely named calendar and one case-folded
 * duplicate pair, plus event list/get/insert/patch/delete. Records methods,
 * URLs, and parsed JSON bodies in call order. The `self: true` attendee on
 * the canned event feeds the respond tool's get-then-patch.
 */
function calendarApiFetch() {
  const requests: { method: string; url: URL; body: unknown }[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      return json({
        items: [
          { id: "cal-work", summary: "Work" },
          { id: "cal-dup-1", summary: "Team" },
          { id: "cal-dup-2", summary: "team" },
        ],
        nextPageToken: "",
      });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/events")) {
      if (method === "POST") {
        return json({ id: "ev-new", status: "confirmed", ...(init?.body ? JSON.parse(init.body as string) : {}) });
      }
      return json({
        items: [
          {
            id: "ev1",
            status: "confirmed",
            summary: "Standup",
            start: { dateTime: "2026-07-14T09:00:00-07:00" },
            end: { dateTime: "2026-07-14T09:15:00-07:00" },
          },
        ],
      });
    }
    // Single-event GET/PATCH.
    return json({
      id: "ev1",
      status: "confirmed",
      summary: "Planning",
      attendees: [
        { email: "organizer@example.com", organizer: true, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "needsAction" },
        { email: "guest@other.org", responseStatus: "declined" },
      ],
    });
  }) as typeof globalThis.fetch;
  return { fetchFn, requests };
}

const ctxWithCredential = {
  userId: "calendar-tool-user",
  credential: {
    access_token: "scrubbed-calendar-access-token",
    refresh_token: "scrubbed-calendar-refresh-token",
    expiry_unix: 4102444800,
    scopes: CALENDAR_SCOPES,
  },
};

const WINDOW = {
  timeMin: "2026-07-14T00:00:00Z",
  timeMax: "2026-07-15T00:00:00Z",
};

/** Minimal valid params per tool, for the uniform no-credential sweep. */
const TOOL_PARAMS: [Tool, Record<string, unknown>][] = [
  [CALENDAR_LIST, { ...WINDOW }],
  [CALENDAR_READ, { eventId: "ev1" }],
  [CALENDAR_SEARCH, { q: "standup" }],
  [
    CALENDAR_CREATE,
    {
      summary: "Sync",
      start: { dateTime: "2026-07-20T10:00:00Z" },
      end: { dateTime: "2026-07-20T11:00:00Z" },
    },
  ],
  [CALENDAR_UPDATE, { eventId: "ev1", summary: "Moved" }],
  [CALENDAR_CANCEL, { eventId: "ev1" }],
  [CALENDAR_RESPOND, { eventId: "ev1", responseStatus: "accepted" }],
];

let originalFetch: typeof globalThis.fetch;
let requests: { method: string; url: URL; body: unknown }[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  const canned = calendarApiFetch();
  globalThis.fetch = canned.fetchFn;
  requests = canned.requests;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("google_calendar service definition", () => {
  it("declares the google provider with the Calendar scope set", () => {
    expect(googleCalendar.service).toBe("google_calendar");
    expect(googleCalendar.connect).toEqual({
      type: "oauth",
      provider: "google",
      scopes: CALENDAR_SCOPES,
    });
    expect(googleCalendar.tools).toEqual([
      CALENDAR_LIST,
      CALENDAR_READ,
      CALENDAR_SEARCH,
      CALENDAR_CREATE,
      CALENDAR_UPDATE,
      CALENDAR_CANCEL,
      CALENDAR_RESPOND,
    ]);
    // The iterated catalog invariants exercise tools[0] — LIST stays first.
    expect(googleCalendar.tools[0]).toBe(CALENDAR_LIST);
  });

  it("each tool's requiredScopes comes from the capability map", () => {
    for (const tool of [CALENDAR_LIST, CALENDAR_READ, CALENDAR_SEARCH]) {
      expect(tool.requiredScopes).toBe(CALENDAR_CAPABILITY_SCOPES.read);
    }
    for (const tool of [
      CALENDAR_CREATE,
      CALENDAR_UPDATE,
      CALENDAR_CANCEL,
      CALENDAR_RESPOND,
    ]) {
      expect(tool.requiredScopes).toBe(CALENDAR_CAPABILITY_SCOPES.write);
    }
  });

  it("the requested calendar.events scope satisfies both capabilities", () => {
    // Calendar requests one events scope for read+write; decline it and all
    // seven tools gate, grant it and all seven clear.
    const events = "https://www.googleapis.com/auth/calendar.events";
    expect(CALENDAR_SCOPES).toContain(events);
    expect(CALENDAR_CAPABILITY_SCOPES.read).toContain(events);
    expect(CALENDAR_CAPABILITY_SCOPES.write).toContain(events);
    // The name-resolution scope is requested but gates nothing: a missing
    // resolution scope surfaces as the unknown-calendar tool error instead.
    const resolution =
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    expect(CALENDAR_SCOPES).toContain(resolution);
    expect(CALENDAR_CAPABILITY_SCOPES.read).not.toContain(resolution);
    expect(CALENDAR_CAPABILITY_SCOPES.write).not.toContain(resolution);
  });

  it("every tool fails closed without a credential", async () => {
    for (const [tool, params] of TOOL_PARAMS) {
      const result = await tool.execute(params, { userId: "u" });
      expect(result).toEqual({
        success: false,
        error: "No credential found for service: google_calendar",
      });
    }
    expect(requests).toHaveLength(0);
  });
});

describe("calendar-name noun folding", () => {
  it("folds case and whitespace so grant and call name one calendar", () => {
    expect(calendarNoun({ calendar: "Work" })).toBe("work");
    expect(calendarNoun({ calendar: "  WORK " })).toBe("work");
    expect(calendarNoun({ calendar: "work" })).toBe("work");
  });

  it("defaults to primary when the param is omitted", () => {
    expect(calendarNoun({})).toBe("primary");
  });

  it("an unknown calendar surfaces as a self-correcting tool error", async () => {
    const result = await CALENDAR_LIST.execute(
      { calendar: "nonexistent", ...WINDOW },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Unknown or inaccessible calendar: nonexistent",
    );
  });

  it("an ambiguous calendar (two summaries sharing a fold) is a tool error, never a first-match", async () => {
    const result = await CALENDAR_LIST.execute(
      { calendar: "Team", ...WINDOW },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous calendar name "team"');
  });

  it("a mixed-case name resolves to the same calendar as its fold", async () => {
    for (const calendar of ["Work", "work", "WORK"]) {
      requests.length = 0;
      const result = await CALENDAR_READ.execute(
        { calendar, eventId: "ev1" },
        ctxWithCredential,
      );
      expect(result.success).toBe(true);
      // Resolution landed on the one cal-work id regardless of casing.
      expect(
        requests.some((r) => r.url.pathname.includes("/calendars/cal-work/")),
      ).toBe(true);
    }
  });

  it("a whitespace-only calendar name is an input error before any fetch", async () => {
    // "  " folds to the empty noun and can never resolve — it must fail as
    // a self-correcting input error, not reach the API as a doomed lookup
    // governed on an empty-string noun.
    const result = await CALENDAR_LIST.execute(
      { calendar: "   ", ...WINDOW },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "calendar must be a non-empty calendar name",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("write noun + sendUpdates coupling (one attendees input, read twice)", () => {
  it("naming attendees yields the de-duped sorted invitee-domain noun", () => {
    const noun = calendarWriteNoun({
      calendar: "Work",
      attendees: [
        { email: "ana@Example.com" },
        { email: "bob@other.org" },
        { email: "carol@example.com" },
      ],
    });
    expect(noun).toBe("example.com,other.org");
  });

  it("omitting attendees falls back to the folded calendar: noun", () => {
    expect(calendarWriteNoun({ calendar: "Work" })).toBe("calendar:work");
    expect(calendarWriteNoun({})).toBe("calendar:primary");
  });

  it("an empty attendees array yields the sentinel noun and the executor rejects it", async () => {
    expect(calendarWriteNoun({ attendees: [] })).toBe(EMPTY_ATTENDEES_NOUN);

    const create = await CALENDAR_CREATE.execute(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        attendees: [],
      },
      ctxWithCredential,
    );
    expect(create.success).toBe(false);
    expect(create.error).toContain("attendees must not be an empty array");

    // On update the empty array is a guest-list WIPE — same rejection.
    const update = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", attendees: [] },
      ctxWithCredential,
    );
    expect(update.success).toBe(false);
    expect(update.error).toContain("attendees must not be an empty array");
    expect(requests).toHaveLength(0);
  });

  it("an unparseable attendee fails closed to its unparseable: token", () => {
    const noun = calendarWriteNoun({
      attendees: [{ email: "ana@example.com" }, { email: "not-an-email" }],
    });
    expect(noun).toBe("example.com,unparseable:not-an-email");
  });

  it("a non-array attendees takes the sentinel noun, never a plausible domain", async () => {
    // The executor always rejects a non-array (resolveAttendees), so the
    // noun must not read as a real domain grant — a user must never be
    // asked to confirm "example.com" for a call that can only error.
    expect(calendarWriteNoun({ attendees: "ana@example.com" })).toBe(
      EMPTY_ATTENDEES_NOUN,
    );

    const result = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", attendees: "ana@example.com" },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("attendees must be an array");
    expect(requests).toHaveLength(0);
  });

  it("a crafted colon-domain attendee cannot mint the calendar: fallback noun", () => {
    // The domain-noun and calendar-noun namespaces must stay disjoint: if
    // x@calendar:primary parsed to the "domain" calendar:primary, a grant
    // minted for a quiet no-attendee write on primary would silently cover
    // an attendee-bearing, notify-all call. recipientDomain rejects
    // colon-bearing domains, so the address fails closed to its opaque
    // unparseable token — which can never equal a quiet-write noun.
    const noun = calendarWriteNoun({
      attendees: [{ email: "x@calendar:primary" }],
    });
    expect(noun).toBe("unparseable:x@calendar:primary");
    expect(noun).not.toBe(calendarWriteNoun({ calendar: "primary" }));
  });

  it("create with attendees transmits them and sendUpdates=all", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Kickoff",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        attendees: [{ email: "ana@example.com" }],
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const insert = requests.find((r) => r.method === "POST")!;
    expect(insert.url.searchParams.get("sendUpdates")).toBe("all");
    expect((insert.body as { attendees?: unknown }).attendees).toEqual([
      { email: "ana@example.com" },
    ]);
  });

  it("create without attendees transmits none and sendUpdates=none", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Focus block",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const insert = requests.find((r) => r.method === "POST")!;
    expect(insert.url.searchParams.get("sendUpdates")).toBe("none");
    expect(insert.body as Record<string, unknown>).not.toHaveProperty(
      "attendees",
    );
  });

  it("update without attendees keeps the key out of the patch body entirely", async () => {
    // events.patch replaces named arrays wholesale: serializing
    // `attendees: []` for an absent param would wipe the stored guest list.
    const result = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", summary: "Moved" },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(patch.body).toEqual({ summary: "Moved" });
  });

  it("update naming attendees replaces the list and sendUpdates=all", async () => {
    const result = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", attendees: [{ email: "new@example.com" }] },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("all");
    expect(patch.body).toEqual({ attendees: [{ email: "new@example.com" }] });
  });

  it("a malformed attendee entry is an input error before any fetch", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        attendees: ["ana@example.com"],
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "each attendee must be an object with a non-empty string email",
    );
    expect(requests).toHaveLength(0);
  });

  it("attendee emails are transmitted trimmed — the same address the noun parsed", async () => {
    // recipientDomain trims before extracting the domain; the envelope must
    // carry the same trimmed address, not stray whitespace Google may choke
    // on.
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        attendees: [{ email: "  ana@example.com " }],
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const insert = requests.find((r) => r.method === "POST")!;
    expect((insert.body as { attendees?: unknown }).attendees).toEqual([
      { email: "ana@example.com" },
    ]);
  });

  it("a display-name attendee form is an input error before any fetch", async () => {
    // attendees[].email is an API field, not an RFC5322 header: Google 400s
    // "Ana <ana@example.com>", so the executor rejects it with a
    // self-correcting error instead. The noun already parsed the same
    // domain the bare form carries (recipientDomain handles both), so
    // governance is never narrower than what could transmit.
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        attendees: [{ email: "Ana <ana@example.com>" }],
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "each attendee email must be a bare address",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("timezone input schema (fail-closed)", () => {
  const base = { summary: "Sync", end: { dateTime: "2026-07-20T11:00:00Z" } };

  it("rejects a timed dateTime carrying neither an offset nor a timeZone", async () => {
    const result = await CALENDAR_CREATE.execute(
      { ...base, start: { dateTime: "2026-07-20T10:00:00" } },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "start dateTime must carry a UTC offset",
    );
    expect(requests).toHaveLength(0);
  });

  it("accepts a timed dateTime with an explicit timeZone instead of an offset", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        ...base,
        start: {
          dateTime: "2026-07-20T10:00:00",
          timeZone: "America/Los_Angeles",
        },
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
  });

  it("accepts RFC3339's lowercase t/z in both dateTime forms", async () => {
    // RFC3339 is case-insensitive in T and Z; the offset and local shapes
    // must agree on that, not accept lowercase in one and reject it (with a
    // misleading seconds message) in the other.
    const offset = await CALENDAR_CREATE.execute(
      { ...base, start: { dateTime: "2026-07-20t10:00:00z" } },
      ctxWithCredential,
    );
    expect(offset.success).toBe(true);

    const local = await CALENDAR_CREATE.execute(
      {
        ...base,
        start: {
          dateTime: "2026-07-20t10:00:00",
          timeZone: "America/Los_Angeles",
        },
      },
      ctxWithCredential,
    );
    expect(local.success).toBe(true);
  });

  it("accepts an all-day date with no zone at all", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        summary: "Offsite",
        start: { date: "2026-07-20" },
        end: { date: "2026-07-21" },
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
  });

  it("rejects setting both dateTime and date, or neither", async () => {
    const both = await CALENDAR_CREATE.execute(
      {
        ...base,
        start: { dateTime: "2026-07-20T10:00:00Z", date: "2026-07-20" },
      },
      ctxWithCredential,
    );
    expect(both.success).toBe(false);
    expect(both.error).toContain("exactly one of dateTime or date");

    const neither = await CALENDAR_CREATE.execute(
      { ...base, start: {} },
      ctxWithCredential,
    );
    expect(neither.success).toBe(false);
    expect(neither.error).toContain("exactly one of dateTime or date");
  });

  it("rejects a seconds-less dateTime — RFC3339 has no such form and Google 400s it", async () => {
    const result = await CALENDAR_CREATE.execute(
      { ...base, start: { dateTime: "2026-07-20T10:00Z" } },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("RFC3339 timestamp with seconds");
    expect(requests).toHaveLength(0);
  });

  it("a timeZone does not smuggle a malformed dateTime through", async () => {
    const result = await CALENDAR_CREATE.execute(
      {
        ...base,
        start: { dateTime: "next tuesday", timeZone: "America/Los_Angeles" },
      },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("RFC3339 timestamp with seconds");
    expect(requests).toHaveLength(0);
  });

  it("list requires offset-carrying RFC3339 window bounds", async () => {
    const result = await CALENDAR_LIST.execute(
      { timeMin: "2026-07-14T00:00:00", timeMax: "2026-07-15T00:00:00Z" },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "timeMin must be an RFC3339 timestamp with a UTC offset",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("read tools", () => {
  it("list resolves the calendar then lists the window", async () => {
    const result = await CALENDAR_LIST.execute(
      { calendar: "Work", ...WINDOW, maxResults: 5 },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      calendar: "work",
      events: [
        {
          id: "ev1",
          status: "confirmed",
          summary: "Standup",
          start: { dateTime: "2026-07-14T09:00:00-07:00" },
          end: { dateTime: "2026-07-14T09:15:00-07:00" },
        },
      ],
    });
    const list = requests.at(-1)!;
    expect(list.url.pathname).toBe("/calendar/v3/calendars/cal-work/events");
    expect(list.url.searchParams.get("maxResults")).toBe("5");
  });

  it("list rejects an out-of-range maxResults", async () => {
    const result = await CALENDAR_LIST.execute(
      { ...WINDOW, maxResults: CALENDAR_READ_MAX_RESULTS + 1 },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("maxResults must be an integer between");
  });

  it("primary short-circuits with no calendarList lookup", async () => {
    const result = await CALENDAR_LIST.execute(
      { ...WINDOW },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe(
      "/calendar/v3/calendars/primary/events",
    );
  });

  it("search passes the query through with optional bounds", async () => {
    const result = await CALENDAR_SEARCH.execute(
      { q: "standup", timeMin: WINDOW.timeMin },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const list = requests.at(-1)!;
    expect(list.url.searchParams.get("q")).toBe("standup");
    expect(list.url.searchParams.get("timeMin")).toBe(WINDOW.timeMin);
    expect(list.url.searchParams.get("timeMax")).toBeNull();
  });

  it("a bare search defaults timeMin to now — upcoming events, not oldest-first history", async () => {
    // Unbounded events.list orders by startTime ascending over ALL history,
    // so a bare search would surface the oldest matches. The executor
    // stamps timeMin at execution; the exact value is the wall clock's, so
    // assert the shape (an offset-carrying RFC3339 instant), not the value.
    const result = await CALENDAR_SEARCH.execute(
      { q: "dentist" },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const list = requests.at(-1)!;
    expect(list.url.searchParams.get("timeMin")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(list.url.searchParams.get("timeMax")).toBeNull();
  });

  it("a timeMax-only search reaches the past — no timeMin floor is injected", async () => {
    const result = await CALENDAR_SEARCH.execute(
      { q: "dentist", timeMax: WINDOW.timeMax },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const list = requests.at(-1)!;
    expect(list.url.searchParams.get("timeMin")).toBeNull();
    expect(list.url.searchParams.get("timeMax")).toBe(WINDOW.timeMax);
  });

  it("a capped window surfaces truncated: true to the model", async () => {
    // The events listing answers the cap's worth of events and claims
    // another page: the model must be told the window holds more, not be
    // handed a partial list shaped like a complete one.
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          items: [{ id: "ev1", status: "confirmed", summary: "Standup" }],
          nextPageToken: "more",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof globalThis.fetch;

    const result = await CALENDAR_LIST.execute(
      { ...WINDOW, maxResults: 1 },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    expect((result.data as { truncated?: boolean }).truncated).toBe(true);
  });
});

describe("cancel and respond", () => {
  it("cancel deletes with sendUpdates=all (guests are told)", async () => {
    const result = await CALENDAR_CANCEL.execute(
      { eventId: "ev1" },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      calendar: "primary",
      eventId: "ev1",
      cancelled: true,
    });
    const del = requests.find((r) => r.method === "DELETE")!;
    expect(del.url.pathname).toBe("/calendar/v3/calendars/primary/events/ev1");
    expect(del.url.searchParams.get("sendUpdates")).toBe("all");
  });

  it("respond patches the self attendee's RSVP back with sendUpdates=none", async () => {
    const result = await CALENDAR_RESPOND.execute(
      { eventId: "ev1", responseStatus: "accepted" },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(patch.body).toEqual({
      attendees: [
        { email: "organizer@example.com", responseStatus: "accepted" },
        { email: "me@example.com", responseStatus: "accepted" },
        { email: "guest@other.org", responseStatus: "declined" },
      ],
    });
  });

  it("respond rejects an unknown responseStatus before any fetch", async () => {
    const result = await CALENDAR_RESPOND.execute(
      { eventId: "ev1", responseStatus: "maybe" },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "responseStatus must be accepted, declined, or tentative",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("update input validation", () => {
  it("rejects an update naming no field to change", async () => {
    const result = await CALENDAR_UPDATE.execute(
      { eventId: "ev1" },
      ctxWithCredential,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "update requires at least one field to change",
    );
    expect(requests).toHaveLength(0);
  });

  it("a non-string description or location is an input error, not a silent drop", async () => {
    // Silently dropping the field would turn {eventId, description: 42}
    // into the misleading "requires at least one field to change" (and on
    // create, quietly not set what the model asked for).
    const create = await CALENDAR_CREATE.execute(
      {
        summary: "Sync",
        start: { dateTime: "2026-07-20T10:00:00Z" },
        end: { dateTime: "2026-07-20T11:00:00Z" },
        description: 42,
      },
      ctxWithCredential,
    );
    expect(create.success).toBe(false);
    expect(create.error).toContain("description must be a string");

    const update = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", location: 42 },
      ctxWithCredential,
    );
    expect(update.success).toBe(false);
    expect(update.error).toContain("location must be a string");
    expect(requests).toHaveLength(0);
  });

  it("update clears description with an empty string", async () => {
    const result = await CALENDAR_UPDATE.execute(
      { eventId: "ev1", description: "" },
      ctxWithCredential,
    );
    expect(result.success).toBe(true);
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ description: "" });
  });
});
