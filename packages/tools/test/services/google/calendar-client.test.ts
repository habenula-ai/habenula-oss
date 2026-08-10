import { describe, it, expect } from "vitest";
import {
  CalendarApiError,
  deleteEvent,
  getEvent,
  insertEvent,
  listEvents,
  patchEvent,
  resolveCalendarId,
  respondToEvent,
} from "../../../src/services/google/calendar-client";

/**
 * Build a fake fetch serving a paginated calendarList.list. Each call
 * records the request URL; pages advance by the pageToken the client sends
 * back, so a client that drops pagination never reaches page two.
 */
function pagedCalendarListFetch(
  pages: {
    items: { id: string; summary: string; summaryOverride?: string }[];
    nextPageToken: string;
  }[],
) {
  const urls: URL[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    urls.push(url);
    const token = url.searchParams.get("pageToken") ?? "";
    const index = token === "" ? 0 : Number(token.replace("page-", ""));
    const page = pages[index]!;
    return new Response(
      JSON.stringify({ items: page.items, nextPageToken: page.nextPageToken }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetchFn, urls };
}

/** A fetch that records every request and answers the given JSON body. */
function capturingFetch(status: number, body: unknown) {
  const requests: { url: URL; method: string; body: unknown }[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      url: new URL(typeof input === "string" ? input : input.toString()),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      ...(status === 204
        ? {}
        : { headers: { "Content-Type": "application/json" } }),
    });
  };
  return { fetchFn, requests };
}

describe("resolveCalendarId", () => {
  it("short-circuits primary with no lookup", async () => {
    const { fetchFn, urls } = pagedCalendarListFetch([]);

    expect(await resolveCalendarId("tok", "primary", fetchFn)).toBe("primary");
    // The fold applies before the short-circuit, so casing never defeats it.
    expect(await resolveCalendarId("tok", "  PRIMARY ", fetchFn)).toBe(
      "primary",
    );
    expect(urls).toHaveLength(0);
  });

  it("matches a calendar name case-insensitively", async () => {
    const { fetchFn, urls } = pagedCalendarListFetch([
      {
        items: [
          { id: "cal-personal", summary: "Personal" },
          { id: "cal-work", summary: "Work" },
        ],
        nextPageToken: "",
      },
    ]);

    expect(await resolveCalendarId("tok", "work", fetchFn)).toBe("cal-work");
    expect(await resolveCalendarId("tok", "WORK", fetchFn)).toBe("cal-work");
    expect(urls[0]!.pathname).toBe("/calendar/v3/users/me/calendarList");
  });

  it("matches a renamed shared calendar by its summaryOverride — the name the user sees", async () => {
    // The user renamed a shared calendar to "Family": summaryOverride is
    // the only name any Google UI shows them for it (CalendarList
    // reference); the owner's title must not be required knowledge.
    const { fetchFn } = pagedCalendarListFetch([
      {
        items: [
          {
            id: "cal-shared",
            summary: "Cheerful Chaos Crew",
            summaryOverride: "Family",
          },
        ],
        nextPageToken: "",
      },
    ]);

    expect(await resolveCalendarId("tok", "family", fetchFn)).toBe(
      "cal-shared",
    );
  });

  it("a renamed calendar's hidden original title no longer matches", async () => {
    // cal-a was renamed away from "Cheerful Chaos Crew"; cal-b is owner-
    // titled with that exact name. The user saying it can only mean cal-b —
    // matching cal-a's invisible original title would land on a calendar
    // the user is not looking at (and here, a phantom ambiguity).
    const { fetchFn } = pagedCalendarListFetch([
      {
        items: [
          {
            id: "cal-a",
            summary: "Cheerful Chaos Crew",
            summaryOverride: "Family",
          },
          { id: "cal-b", summary: "Cheerful Chaos Crew" },
        ],
        nextPageToken: "",
      },
    ]);

    expect(
      await resolveCalendarId("tok", "Cheerful Chaos Crew", fetchFn),
    ).toBe("cal-b");
  });

  it("an override colliding with another calendar's title is ambiguous, never a first-match", async () => {
    // The user's rename of one calendar matches another calendar's owner
    // title: their UI genuinely shows two calendars named "Family", so the
    // resolver must refuse rather than pick either.
    const { fetchFn } = pagedCalendarListFetch([
      {
        items: [
          { id: "cal-a", summary: "Chaos", summaryOverride: "Family" },
          { id: "cal-b", summary: "Family" },
        ],
        nextPageToken: "",
      },
    ]);

    await expect(resolveCalendarId("tok", "family", fetchFn)).rejects.toThrow(
      'Ambiguous calendar name "family": 2 calendars share that name',
    );
  });

  it("paginates pageToken to exhaustion and finds a late-page calendar", async () => {
    const { fetchFn, urls } = pagedCalendarListFetch([
      { items: [{ id: "c1", summary: "Personal" }], nextPageToken: "page-1" },
      { items: [{ id: "c2", summary: "Family" }], nextPageToken: "page-2" },
      { items: [{ id: "c3", summary: "Work" }], nextPageToken: "" },
    ]);

    expect(await resolveCalendarId("tok", "work", fetchFn)).toBe("c3");
    expect(urls).toHaveLength(3);
    // The token threads through: page N+1 is requested with page N's token.
    expect(urls[0]!.searchParams.get("pageToken")).toBeNull();
    expect(urls[1]!.searchParams.get("pageToken")).toBe("page-1");
    expect(urls[2]!.searchParams.get("pageToken")).toBe("page-2");
  });

  it("throws a self-correcting unknown-calendar error after exhausting the listing", async () => {
    const { fetchFn, urls } = pagedCalendarListFetch([
      { items: [{ id: "c1", summary: "Personal" }], nextPageToken: "" },
    ]);

    await expect(
      resolveCalendarId("tok", "no-such-calendar", fetchFn),
    ).rejects.toThrow("Unknown or inaccessible calendar: no-such-calendar");
    expect(urls).toHaveLength(1);
  });

  it("throws on an ambiguous name rather than picking a first match", async () => {
    // Two calendars share the summary after folding — even split across
    // pages, so an early-return-on-first-match implementation would wrongly
    // resolve instead of detecting the ambiguity.
    const { fetchFn } = pagedCalendarListFetch([
      { items: [{ id: "c1", summary: "Work" }], nextPageToken: "page-1" },
      { items: [{ id: "c2", summary: "work" }], nextPageToken: "" },
    ]);

    await expect(resolveCalendarId("tok", "work", fetchFn)).rejects.toThrow(
      'Ambiguous calendar name "work": 2 calendars share that name',
    );
  });

  it("de-dupes one calendar repeated across pages — pagination drift is never a phantom ambiguity", async () => {
    // calendarList pagination is not snapshot-consistent: an entry shifting
    // pages mid-listing can appear on two pages. The SAME id twice is one
    // calendar and must resolve, not throw ambiguous_calendar.
    const { fetchFn } = pagedCalendarListFetch([
      { items: [{ id: "c-work", summary: "Work" }], nextPageToken: "page-1" },
      { items: [{ id: "c-work", summary: "Work" }], nextPageToken: "" },
    ]);

    expect(await resolveCalendarId("tok", "work", fetchFn)).toBe("c-work");
  });

  it("folds edge whitespace on the stored name too — both sides get the same trim+lowercase", async () => {
    // The user sees "Work" in their UI regardless of an invisible trailing
    // space in the stored summary; the input side already trims, so the
    // label side must too or the calendar is unreachable by the one name
    // the user can type.
    const { fetchFn } = pagedCalendarListFetch([
      { items: [{ id: "c-work", summary: "Work " }], nextPageToken: "" },
    ]);

    expect(await resolveCalendarId("tok", "work", fetchFn)).toBe("c-work");

    // And two names identical after the fold are visually identical to the
    // user — a genuine ambiguity, not a resolvable pair.
    const { fetchFn: dupFetch } = pagedCalendarListFetch([
      {
        items: [
          { id: "c1", summary: "Work" },
          { id: "c2", summary: "Work " },
        ],
        nextPageToken: "",
      },
    ]);
    await expect(resolveCalendarId("tok", "work", dupFetch)).rejects.toThrow(
      'Ambiguous calendar name "work"',
    );
  });

  it("fails resolution when the calendar list outruns the page budget", async () => {
    // A partial listing cannot safely resolve a name (the match might be on
    // an unfetched page), so the budget fails the call with a
    // self-correcting error instead of answering from what was fetched —
    // and instead of burning subrequests until the platform cap kills the
    // whole invocation opaquely.
    const urls: URL[] = [];
    const endlessFetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      urls.push(new URL(typeof input === "string" ? input : input.toString()));
      return new Response(
        JSON.stringify({ items: [], nextPageToken: "again" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    await expect(
      resolveCalendarId("tok", "work", endlessFetch),
    ).rejects.toThrow("calendar list is too long to resolve names against");
    expect(urls).toHaveLength(10);
  });

  it("sends the Bearer token on the request", async () => {
    let captured: HeadersInit | undefined;
    const fetchFn = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = init?.headers;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(resolveCalendarId("tok-abc", "work", fetchFn)).rejects.toThrow(
      "Unknown or inaccessible calendar",
    );
    expect(
      (captured as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer tok-abc");
  });
});

describe("event methods shape their requests", () => {
  it("listEvents: expanded single events ordered by start, with window and cap", async () => {
    const { fetchFn, requests } = capturingFetch(200, {
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

    const { events, truncated } = await listEvents(
      "tok",
      {
        calendarId: "cal-work",
        timeMin: "2026-07-14T00:00:00Z",
        timeMax: "2026-07-15T00:00:00Z",
        maxResults: 10,
      },
      fetchFn,
    );

    const { url, method } = requests[0]!;
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/calendar/v3/calendars/cal-work/events");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("timeMin")).toBe("2026-07-14T00:00:00Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-07-15T00:00:00Z");
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("q")).toBeNull();
    expect(truncated).toBe(false);
    expect(events).toEqual([
      {
        id: "ev1",
        status: "confirmed",
        summary: "Standup",
        start: { dateTime: "2026-07-14T09:00:00-07:00" },
        end: { dateTime: "2026-07-14T09:15:00-07:00" },
      },
    ]);
  });

  it("listEvents pages short pages to the cap — an incomplete page is never the answer", async () => {
    // Google documents that a page "may contain fewer events than
    // maxResults, or none at all, even if there are more events matching
    // the query" (events.list reference) — routine under recurring-event
    // expansion. The client must follow nextPageToken, asking each page for
    // only the remainder, until the cap or exhaustion.
    const pages = [
      { items: [{ id: "e1", summary: "A" }, { id: "e2", summary: "B" }], nextPageToken: "page-1" },
      { items: [], nextPageToken: "page-2" },
      { items: [{ id: "e3", summary: "C" }], nextPageToken: "" },
    ];
    const requests: URL[] = [];
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      requests.push(url);
      const token = url.searchParams.get("pageToken") ?? "";
      const index = token === "" ? 0 : Number(token.replace("page-", ""));
      return new Response(JSON.stringify(pages[index]!), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const { events, truncated } = await listEvents(
      "tok",
      { calendarId: "primary", maxResults: 10 },
      fetchFn,
    );

    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(truncated).toBe(false);
    // The token threads through, and each page asks for only the remainder.
    expect(requests.map((u) => u.searchParams.get("pageToken"))).toEqual([
      null,
      "page-1",
      "page-2",
    ]);
    expect(requests.map((u) => u.searchParams.get("maxResults"))).toEqual([
      "10",
      "8",
      "8",
    ]);
  });

  it("listEvents stops at the cap and reports truncated when more matches remain", async () => {
    const pages = [
      { items: [{ id: "e1" }, { id: "e2" }], nextPageToken: "page-1" },
      { items: [{ id: "e3" }], nextPageToken: "page-2" },
    ];
    const requests: URL[] = [];
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      requests.push(url);
      const token = url.searchParams.get("pageToken") ?? "";
      const index = token === "" ? 0 : Number(token.replace("page-", ""));
      return new Response(JSON.stringify(pages[index]!), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const { events, truncated } = await listEvents(
      "tok",
      { calendarId: "primary", maxResults: 3 },
      fetchFn,
    );

    // The cap is reached with page-2's token outstanding: the caller is
    // told the window holds more, and no further page is fetched.
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(truncated).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("listEvents stops at the page budget with truncated: true — partial data beats a platform kill", async () => {
    // An endless chain of near-empty pages must not burn Workers
    // subrequests until the platform cap fails the whole invocation. Unlike
    // name resolution, a partial event listing flagged truncated is still a
    // correct answer, so the budget returns what was gathered.
    const urls: URL[] = [];
    const drippingFetch = (async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      urls.push(url);
      return new Response(
        JSON.stringify({
          items: [{ id: `e${urls.length}`, summary: "Drip" }],
          nextPageToken: "again",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const { events, truncated } = await listEvents(
      "tok",
      { calendarId: "primary", maxResults: 50 },
      drippingFetch,
    );

    expect(urls).toHaveLength(10);
    expect(events).toHaveLength(10);
    expect(truncated).toBe(true);
  });

  it("listEvents with q is the search variant", async () => {
    const { fetchFn, requests } = capturingFetch(200, { items: [] });

    await listEvents(
      "tok",
      { calendarId: "primary", q: "dentist", maxResults: 5 },
      fetchFn,
    );

    expect(requests[0]!.url.searchParams.get("q")).toBe("dentist");
    expect(requests[0]!.url.searchParams.get("timeMin")).toBeNull();
  });

  it("getEvent addresses one event, URL-encoding the ids", async () => {
    const { fetchFn, requests } = capturingFetch(200, {
      id: "ev/9",
      status: "confirmed",
      summary: "1:1",
    });

    const event = await getEvent(
      "tok",
      { calendarId: "team cal@group.calendar.google.com", eventId: "ev/9" },
      fetchFn,
    );

    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url.pathname).toBe(
      "/calendar/v3/calendars/team%20cal%40group.calendar.google.com/events/ev%2F9",
    );
    expect(event.summary).toBe("1:1");
  });

  it("insertEvent POSTs the event body with sendUpdates on the query", async () => {
    const { fetchFn, requests } = capturingFetch(200, {
      id: "ev-new",
      status: "confirmed",
      summary: "Kickoff",
    });

    await insertEvent(
      "tok",
      {
        calendarId: "primary",
        event: {
          summary: "Kickoff",
          start: { dateTime: "2026-07-20T10:00:00Z" },
          end: { dateTime: "2026-07-20T11:00:00Z" },
          attendees: [{ email: "ana@example.com" }],
        },
        sendUpdates: "all",
      },
      fetchFn,
    );

    const { url, method, body } = requests[0]!;
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(body).toEqual({
      summary: "Kickoff",
      start: { dateTime: "2026-07-20T10:00:00Z" },
      end: { dateTime: "2026-07-20T11:00:00Z" },
      attendees: [{ email: "ana@example.com" }],
    });
  });

  it("patchEvent PATCHes only the named fields", async () => {
    const { fetchFn, requests } = capturingFetch(200, {
      id: "ev1",
      status: "confirmed",
      summary: "Moved",
    });

    await patchEvent(
      "tok",
      {
        calendarId: "primary",
        eventId: "ev1",
        event: { summary: "Moved" },
        sendUpdates: "none",
      },
      fetchFn,
    );

    const { url, method, body } = requests[0]!;
    expect(method).toBe("PATCH");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/ev1");
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    // No attendees key: an absent param must never serialize as [] — that
    // would wipe the stored guest list.
    expect(body).toEqual({ summary: "Moved" });
  });

  it("deleteEvent DELETEs and accepts Google's empty 204", async () => {
    const { fetchFn, requests } = capturingFetch(204, null);

    await deleteEvent(
      "tok",
      { calendarId: "primary", eventId: "ev1", sendUpdates: "all" },
      fetchFn,
    );

    const { url, method } = requests[0]!;
    expect(method).toBe("DELETE");
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/ev1");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
  });

  it("surfaces Google's JSON error message with the HTTP status", async () => {
    const { fetchFn } = capturingFetch(403, {
      error: { code: 403, message: "Request had insufficient scopes." },
    });

    await expect(
      getEvent("tok", { calendarId: "primary", eventId: "ev1" }, fetchFn),
    ).rejects.toThrow(
      "Google Calendar request failed (403): Request had insufficient scopes.",
    );
    await expect(
      getEvent("tok", { calendarId: "primary", eventId: "ev1" }, fetchFn),
    ).rejects.toBeInstanceOf(CalendarApiError);
  });

  it("survives a non-JSON error body", async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response("Bad Gateway", { status: 502 });

    await expect(
      getEvent("tok", { calendarId: "primary", eventId: "ev1" }, fetchFn),
    ).rejects.toThrow("Google Calendar request failed (502)");
  });
});

describe("respondToEvent (get-then-patch RSVP)", () => {
  /**
   * Fake fetch: GET answers the stored event (with `etag` when given);
   * PATCH records its body and headers and answers `patchStatus` (default
   * echo). The stored event has the authenticated user flagged `self: true`
   * plus two other guests whose statuses must survive.
   */
  function rsvpFetch(
    attendees: unknown[] | undefined,
    opts: { etag?: string; patchStatus?: number } = {},
  ) {
    const requests: {
      method: string;
      url: URL;
      body: unknown;
      headers: Record<string, string>;
    }[] = [];
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url: new URL(typeof input === "string" ? input : input.toString()),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (method === "PATCH" && opts.patchStatus !== undefined) {
        return new Response(
          JSON.stringify({ error: { message: "Precondition Failed" } }),
          {
            status: opts.patchStatus,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: "ev1",
          status: "confirmed",
          summary: "Planning",
          ...(opts.etag !== undefined ? { etag: opts.etag } : {}),
          ...(attendees !== undefined ? { attendees } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchFn, requests };
  }

  it("sets responseStatus on the self attendee and patches back the full list", async () => {
    const { fetchFn, requests } = rsvpFetch([
      { email: "organizer@example.com", organizer: true, responseStatus: "accepted" },
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
      { email: "other@example.com", responseStatus: "declined" },
    ]);

    await respondToEvent(
      "tok",
      {
        calendarId: "primary",
        eventId: "ev1",
        responseStatus: "accepted",
        sendUpdates: "none",
      },
      fetchFn,
    );

    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(requests[1]!.url.searchParams.get("sendUpdates")).toBe("none");
    // The full list is patched back — no guest dropped (events.patch
    // replaces the array wholesale) — with only self's status changed.
    expect(requests[1]!.body).toEqual({
      attendees: [
        { email: "organizer@example.com", responseStatus: "accepted" },
        { email: "me@example.com", responseStatus: "accepted" },
        { email: "other@example.com", responseStatus: "declined" },
      ],
    });
    // No etag on the read → the patch is unconditional, not a bogus header.
    expect(requests[1]!.headers["If-Match"]).toBeUndefined();
  });

  it("threads the read's etag as If-Match so a concurrent edit cannot be clobbered", async () => {
    // The patch-back writes the WHOLE attendee list from the GET's
    // snapshot; without If-Match, a guest added between GET and PATCH would
    // be silently removed by the stale list. The etag makes Google refuse
    // (412) instead (version-resources guide).
    const { fetchFn, requests } = rsvpFetch(
      [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
      { etag: '"etag-3181161784712000"' },
    );

    await respondToEvent(
      "tok",
      {
        calendarId: "primary",
        eventId: "ev1",
        responseStatus: "accepted",
        sendUpdates: "none",
      },
      fetchFn,
    );

    expect(requests[1]!.headers["If-Match"]).toBe('"etag-3181161784712000"');
    // The etag stays in the header — never in the patch body Google would
    // treat as event data.
    expect(requests[1]!.body).toEqual({
      attendees: [{ email: "me@example.com", responseStatus: "accepted" }],
    });
  });

  it("surfaces a 412 as a self-correcting retry error, not a silent clobber", async () => {
    const { fetchFn, requests } = rsvpFetch(
      [{ email: "me@example.com", self: true, responseStatus: "needsAction" }],
      { etag: '"etag-old"', patchStatus: 412 },
    );

    const attempt = respondToEvent(
      "tok",
      {
        calendarId: "primary",
        eventId: "ev1",
        responseStatus: "declined",
        sendUpdates: "none",
      },
      fetchFn,
    );

    await expect(attempt).rejects.toThrow(
      "Event ev1 was modified while the RSVP was being written; retry",
    );
    // One audited attempt, one patch: the retry is the model's next
    // governed call, never an automatic re-patch here.
    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
  });

  it("preserves every writable guest field through the wholesale patch-back", async () => {
    // events.patch replaces the attendee array wholesale, which erases any
    // per-guest field the patch-back omits — an RSVP must not flip an
    // optional guest to required, drop a +2, lose an invite comment, or
    // strip a room's resource flag. Read-only fields (id — the Profile ID,
    // self, organizer) stay out of the patch body; Google keys attendees by
    // email.
    const { fetchFn, requests } = rsvpFetch([
      { email: "me@example.com", self: true, responseStatus: "needsAction" },
      {
        id: "profile-123",
        email: "colleague@example.com",
        displayName: "Colleague",
        optional: true,
        additionalGuests: 2,
        comment: "joining late",
        responseStatus: "tentative",
      },
      {
        email: "room-4a@resource.calendar.google.com",
        resource: true,
        responseStatus: "accepted",
      },
    ]);

    await respondToEvent(
      "tok",
      {
        calendarId: "primary",
        eventId: "ev1",
        responseStatus: "declined",
        sendUpdates: "none",
      },
      fetchFn,
    );

    expect(requests[1]!.body).toEqual({
      attendees: [
        { email: "me@example.com", responseStatus: "declined" },
        {
          email: "colleague@example.com",
          displayName: "Colleague",
          optional: true,
          additionalGuests: 2,
          comment: "joining late",
          responseStatus: "tentative",
        },
        {
          email: "room-4a@resource.calendar.google.com",
          resource: true,
          responseStatus: "accepted",
        },
      ],
    });
  });

  it("throws a self-correcting error when the user is not an attendee", async () => {
    const { fetchFn, requests } = rsvpFetch([
      { email: "organizer@example.com", organizer: true },
    ]);

    await expect(
      respondToEvent(
        "tok",
        {
          calendarId: "primary",
          eventId: "ev1",
          responseStatus: "declined",
          sendUpdates: "none",
        },
        fetchFn,
      ),
    ).rejects.toThrow("The user is not an attendee of event ev1");
    // Nothing was patched.
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("throws the same error on an event with no attendees at all", async () => {
    const { fetchFn } = rsvpFetch(undefined);

    await expect(
      respondToEvent(
        "tok",
        {
          calendarId: "primary",
          eventId: "ev1",
          responseStatus: "tentative",
          sendUpdates: "none",
        },
        fetchFn,
      ),
    ).rejects.toThrow("not an attendee");
  });
});
