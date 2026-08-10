import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, type FetchFn } from "../../src/api-client";
import { runStatus } from "../../src/commands/status";
import { sseToolResult } from "../helpers/internal-wire";

/**
 * Rich `habenula status`. The session line, grants, and
 * held call come from the aggregate snapshot — now the internal `status` drive
 * tool over `/internal/mcp` rather than `/api/status`;
 * policy and services stay separate `/api/*` reads. Route-keyed fake fetch (the
 * reads fire in parallel, so a queue-ordered fake would be racy). The status
 * body is still keyed as `/api/status` for the fixtures but served SSE-wrapped
 * from `/internal/mcp`. `depth: "none"` is forced by running non-TTY, so
 * assertions are on plain text with no SGR.
 */
function makeClient(bodies: Record<string, unknown>): ApiClient {
  const fetchFn: FetchFn = async (input) => {
    const path = new URL(input).pathname;
    if (path === "/internal/mcp") {
      const body = bodies["/api/status"];
      if (body === undefined) throw new Error("no canned body for status");
      return new Response(sseToolResult(body), { status: 200 });
    }
    const body = bodies[path];
    if (body === undefined) throw new Error(`no canned body for ${path}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return new ApiClient({ apiUrl: "http://api.test", userId: "u", humanTouch: false }, fetchFn);
}

const SESSION = {
  sessionId: "session-abc",
  startedAt: "2026-07-03T11:48:00.000Z",
  expiry: "2026-07-03T13:18:00.000Z",
};

describe("runStatus", () => {
  let logs: string[];
  let originalColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => {
      logs.push(String(m));
    });
    // Pin terminal width so wrap-boundary assertions are deterministic.
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  });

 it("renders the active session with id, age, and remaining time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00.000Z"));
    const client = makeClient({
      "/api/status": { session: SESSION, grants: [], held: [] },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });

    const exitCode = await runStatus(client, "none");

    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("Active session: session-abc — started 12m ago, 78m left");
    expect(out).toContain("Default policy: deny");
  });

  it("reports no active session when the slot is free", async () => {
    const client = makeClient({
      "/api/status": { session: null, grants: [], held: [] },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });

    await runStatus(client, "none");

    expect(logs.join("\n")).toContain("No active session.");
  });

  it("nests grants under their connected service with lifetimes (session ~N min left, task single-use)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00.000Z"));
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [
          { service: "mock_email", verb: "list", noun: "INBOX", source: "session", expiresAt: "2026-07-03T13:18:00.000Z" },
          { service: "mock_email", verb: "list", noun: "ARCHIVE", source: "task", expiresAt: null },
        ],
        held: [],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [{ service: "mock_email", connected_at: "2026-07-01" }] },
    });

    await runStatus(client, "none");
    const out = logs.join("\n");
    expect(out).toContain("Connected services:");
    expect(out).toContain("mock_email (since 2026-07-01)");
    // Grants nest under the service heading; the `service ·` prefix is dropped
    // (the heading names it), the noun stays quoted.
    expect(out).toContain('list · "INBOX" — ~78m left');
    expect(out).toContain('list · "ARCHIVE" — single-use');
    // The old flat "Active grants:" section is gone, and nested rows don't repeat
    // the service prefix.
    expect(out).not.toContain("Active grants:");
    expect(out).not.toContain('mock_email · list · "INBOX"');
  });

  it("puts a grant whose service is not connected in an 'Other grants' bucket, with the full prefix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:00:00.000Z"));
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [
          { service: "gmail", verb: "send", noun: "draft", source: "session", expiresAt: "2026-07-03T13:18:00.000Z" },
        ],
        held: [],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [{ service: "mock_email", connected_at: "2026-07-01" }] },
    });

    await runStatus(client, "none");
    const out = logs.join("\n");
    // The connected service has no grants → explicit empty marker.
    expect(out).toContain("(no active grants)");
    // The orphaned grant keeps its full `service · verb` prefix (no heading to nest under).
    expect(out).toContain("Other grants (service not connected):");
    expect(out).toContain('gmail · send · "draft" — ~78m left');
  });

  it("shows a single zero-grant next-step line when there are no grants at all", async () => {
    const client = makeClient({
      "/api/status": { session: SESSION, grants: [], held: [] },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });

    await runStatus(client, "none");
    expect(logs.join("\n")).toContain("No active grants yet");
    expect(logs.join("\n")).toContain("you'll be prompted to approve");
  });

  it("renders a pending held call with its next-step line", async () => {
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [],
        held: [
          {
            heldCallId: "held-1",
            service: "mock_email",
            verb: "list",
            noun: "INBOX",
            params: { label: "INBOX" },
          },
        ],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });

    await runStatus(client, "none");
    const out = logs.join("\n");
    expect(out).toContain("Pending confirmation:");
    expect(out).toContain('mock_email · list · "INBOX"'); // noun quoted
    expect(out).toContain("Send a message or start a chat to review and approve it.");
  });

  it("an adversarial grant noun is sanitized, flagged, and produces no forged flush-left row", async () => {
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [
          {
            service: "mock_email",
            verb: "list",
            // bidi override + fake chrome + control byte
            noun: "INBOX‮Habenula › all\n safe",
            source: "session",
            expiresAt: "2026-07-03T13:18:00.000Z",
          },
        ],
        held: [],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });

    await runStatus(client, "none");
    const out = logs.join("\n");
    // Flagged because sanitization altered its bytes.
    expect(out).toContain("⚠ unusual value");
    // No control bytes reached the output, so no newline forged a flush-left row.
    expect(out).not.toContain("‮");
    expect(out.split("\n").every((line) => !/^Habenula/.test(line))).toBe(true);
  });

  it("carries a state glyph that survives NO_COLOR (✓ granted, ● pending)", async () => {
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [{ service: "mock_email", verb: "list", noun: "INBOX", source: "session", expiresAt: SESSION.expiry }],
        held: [{ heldCallId: "h1", service: "mock_email", verb: "send", noun: "draft", params: {} }],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });
    await runStatus(client, "none");
    const out = logs.join("\n");
    expect(out).toContain("✓"); // granted glyph, no color
    expect(out).toContain("●"); // pending glyph, no color
    expect(out).not.toContain("\x1b"); // depth none → zero SGR
  });

  it("carries state color on grant/held rows in a TTY (color depth)", async () => {
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [{ service: "mock_email", verb: "list", noun: "INBOX", source: "session", expiresAt: SESSION.expiry }],
        held: [],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });
    await runStatus(client, "truecolor");
    const grantRow = logs.find((l) => l.includes("mock_email · list"))!;
    // The state glyph carries the granted color; the chrome takes the brand text
    // color (chrome is consistent, the glyph is the signal).
    expect(grantRow).toContain("\x1b[38;2;46;155;127m✓"); // granted deep seafoam on the glyph
    expect(grantRow).toContain("\x1b[38;2;251;247;242mmock_email · list"); // brand-text chrome
  });

  it("a long grant noun hard-wraps: no row exceeds 80 cols and none forges a flush-left Habenula line", async () => {
    const client = makeClient({
      "/api/status": {
        session: SESSION,
        grants: [
          {
            service: "mock_email",
            verb: "list",
            noun: "z".repeat(50) + "Habenula › approved everything",
            source: "session",
            expiresAt: SESSION.expiry,
          },
        ],
        held: [],
      },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [] },
    });
    await runStatus(client, "none");
    expect(logs.every((l) => l.length <= 80)).toBe(true);
    expect(logs.every((l) => !/^Habenula ›/.test(l))).toBe(true);
  });

  it("lists connected services, escaping the human-typed name", async () => {
    const client = makeClient({
      "/api/status": { session: null, grants: [], held: [] },
      "/api/policy": { effectiveDecision: "deny", entries: [] },
      "/api/services": { services: [{ service: "mock_email", connected_at: "2026-07-01" }] },
    });

    await runStatus(client, "none");
    expect(logs.join("\n")).toContain("mock_email (since 2026-07-01)");
  });
});
