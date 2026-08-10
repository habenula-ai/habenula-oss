import { describe, it, expect } from "vitest";
import {
  parseReplLine,
  postTurnHints,
  REPL_HELP,
  resumeNotice,
  sessionTimes,
} from "../../src/commands/repl-meta";

describe("parseReplLine", () => {
  it("returns blank for empty / whitespace-only input", () => {
    expect(parseReplLine("").kind).toBe("blank");
    expect(parseReplLine("   ").kind).toBe("blank");
    expect(parseReplLine("\t").kind).toBe("blank");
  });

  it("treats non-colon lines as chat turns and trims", () => {
    expect(parseReplLine("what are my emails?")).toEqual({
      kind: "chat",
      text: "what are my emails?",
    });
    expect(parseReplLine("  hello  ")).toEqual({
      kind: "chat",
      text: "hello",
    });
  });

  it("parses :exit/.exit as detach and :quit/.quit as end-session", () => {
    // Two different verbs under single-session: exit
    // detaches (the session survives; a returning launch re-attaches), quit
    // ends the active session. The dot forms stay synonyms of their colon
    // forms. This deliberately changes the earlier muscle memory where :quit
    // was a pure exit synonym.
    expect(parseReplLine(":exit").kind).toBe("exit");
    expect(parseReplLine(".exit").kind).toBe("exit");
    expect(parseReplLine(":quit").kind).toBe("quit");
    expect(parseReplLine(".quit").kind).toBe("quit");
  });

  it("parses :help, :status, :cap, :kill, :clear", () => {
    expect(parseReplLine(":help").kind).toBe("help");
    expect(parseReplLine(":status").kind).toBe("status");
    expect(parseReplLine(":cap").kind).toBe("cap");
    expect(parseReplLine(":kill").kind).toBe("kill");
    expect(parseReplLine(":clear").kind).toBe("clear");
  });

  it("parses :connect with any service name (service-generic)", () => {
    expect(parseReplLine(":connect mock_email")).toEqual({
      kind: "connect",
      service: "mock_email",
    });
    expect(parseReplLine(":connect gmail")).toEqual({
      kind: "connect",
      service: "gmail",
    });
    // The command no longer enforces a fixed service set — the catalog is the
    // source of truth, validated server-side at the connect entry.
    expect(parseReplLine(":connect file_system")).toEqual({
      kind: "connect",
      service: "file_system",
    });
  });

  it("rejects :connect without a service", () => {
    expect(parseReplLine(":connect").kind).toBe("error");
  });

  it("parses :disconnect with any service name", () => {
    expect(parseReplLine(":disconnect email")).toEqual({
      kind: "disconnect",
      service: "email",
    });
  });

  it("rejects :disconnect with no service", () => {
    expect(parseReplLine(":disconnect").kind).toBe("error");
  });

  it("treats :policy as an unknown meta-command (removed)", () => {
    // The standing-allow mutate command was removed — there is no permanent
    // allow to set. :policy now falls through to the unknown-command error.
    expect(parseReplLine(":policy allow").kind).toBe("error");
    expect(parseReplLine(":policy").kind).toBe("error");
  });

  it("returns error for unknown meta-commands", () => {
    const result = parseReplLine(":nope");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain(":nope");
      expect(result.message).toContain(":help");
    }
  });

  it("handles extra whitespace between meta-command and argument", () => {
    expect(parseReplLine(":connect   mock_email")).toEqual({
      kind: "connect",
      service: "mock_email",
    });
  });

  it("does not treat a message that happens to contain a colon as meta", () => {
    expect(parseReplLine("summarize this: recent emails")).toEqual({
      kind: "chat",
      text: "summarize this: recent emails",
    });
  });
});

describe("REPL_HELP", () => {
  it("mentions every meta-command keyword", () => {
    expect(REPL_HELP).toContain(":help");
    expect(REPL_HELP).toContain(":status");
    expect(REPL_HELP).toContain(":cap");
    expect(REPL_HELP).toContain(":connect");
    expect(REPL_HELP).toContain(":disconnect");
    expect(REPL_HELP).toContain(":kill");
    expect(REPL_HELP).toContain(":quit");
    expect(REPL_HELP).toContain(":exit");
  });

  it("mentions the dot synonyms so dot-command muscle memory still works", () => {
    expect(REPL_HELP).toContain(".exit");
    expect(REPL_HELP).toContain(".quit");
  });

  it("distinguishes the two verbs: quit ends the session, exit leaves it active", () => {
    const quitLine = REPL_HELP.split("\n").find((l) => l.includes(":quit"))!;
    const exitLine = REPL_HELP.split("\n").find((l) => l.includes(":exit"))!;
    expect(quitLine).toContain("End the session");
    expect(exitLine).toContain("stays active");
  });
});

describe("sessionTimes / resumeNotice", () => {
  const now = new Date("2026-07-03T12:00:00.000Z");
  const session = {
    sessionId: "session-abc",
    startedAt: "2026-07-03T11:48:00.000Z", // 12m ago
    expiry: "2026-07-03T13:18:00.000Z", // 78m left
  };

  it("computes age and remaining in minutes", () => {
    expect(sessionTimes(session, now)).toEqual({ age: "12m", left: "78m" });
  });

  it("stays minutes-only (90-min lifetime bounds spans) and clamps negatives to 0m", () => {
    expect(
      sessionTimes(
        {
          sessionId: "s",
          startedAt: "2026-07-03T10:30:00.000Z", // 90m ago
          expiry: "2026-07-03T11:59:00.000Z", // past — clock skew
        },
        now,
      ),
    ).toEqual({ age: "90m", left: "0m" });
  });

  it("returns null when expiry is absent or an instant is unparseable", () => {
    expect(
      sessionTimes({ sessionId: "s", startedAt: "x", expiry: null }, now),
    ).toBeNull();
    expect(
      sessionTimes(
        { sessionId: "s", startedAt: "not-a-date", expiry: "2026-07-03T13:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("resumeNotice reads as reassurance with a lever, and omits times when unknown", () => {
    const notice = resumeNotice(session, now);
    expect(notice).toContain("Resuming active session (started 12m ago, 78m left)");
    expect(notice).toContain(":quit");
    expect(notice).toContain(":status");

    const bare = resumeNotice(
      { sessionId: "s", startedAt: "x", expiry: null },
      now,
    );
    expect(bare).toContain("Resuming active session.");
    expect(bare).not.toContain("ago");
  });
});

describe("postTurnHints", () => {
  it("returns no hints for an all-success turn", () => {
    expect(
      postTurnHints([
        { outcome: "success" },
        { outcome: "success" },
      ]),
    ).toEqual([]);
  });

  it("returns no hints when there are no tool calls at all", () => {
    expect(postTurnHints([])).toEqual([]);
  });

  it("returns a :connect hint when any tool call was not_connected", () => {
    const hints = postTurnHints([{ outcome: "not_connected" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(":connect mock_email");
    expect(hints[0]).toContain(":connect gmail");
  });

  it("returns a re-connect hint when any tool call was needs_authorization", () => {
    // Connected but under-scoped: the fix is
    // re-running :connect to grant the wider access, not a policy change.
    const hints = postTurnHints([{ outcome: "needs_authorization" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(":connect");
    expect(hints[0]).toContain("authorized");
  });

  it("needs_authorization takes priority over denied", () => {
    const hints = postTurnHints([
      { outcome: "denied" },
      { outcome: "needs_authorization" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(":connect");
    expect(hints[0]).not.toContain("denied by your policy");
  });

  it("returns a denial hint when any tool call was denied", () => {
    const hints = postTurnHints([{ outcome: "denied" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("denied");
  });

  it("never promises a confirmation for a boundary refusal", () => {
    // The refusal has no remediation: no grant, policy edit or retry makes the
    // call allowed. The policy-deny hint would send the user to wait for a
    // confirmation the engine will never offer, so it must not fire.
    const hints = postTurnHints([{ outcome: "boundary_refused" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).not.toContain("denied by your policy");
    expect(hints[0]).not.toContain("confirmation when prompted");
    expect(hints[0]).toContain("trusted surface");
  });

  it("boundary_refused takes priority over denied on the same turn", () => {
    // A turn can carry both. The one with no remediation wins, because the
    // other hint's advice is false for it.
    const hints = postTurnHints([
      { outcome: "denied" },
      { outcome: "boundary_refused" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).not.toContain("denied by your policy");
  });

 it("does not misdirect an errored call to :connect", () => {
    // An `error` outcome means the tool passed the connection gate and failed
    // during execution, so :connect is the wrong remediation — it would loop
    // the user through a pointless reconnect of an already-connected service.
    // The hint corrects that rather than pointing at an audit-log surface that
    // does not exist yet.
    const hints = postTurnHints([{ outcome: "error" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).not.toContain(":connect");
    expect(hints[0]).toContain("failed");
  });

  it("points at the tool line once the engine sends a reason", () => {
    // With the reason rendered inline, the hint stops setting expectations for
    // an unavailable surface and names where the answer already is.
    const hints = postTurnHints([
      { outcome: "error", error: "Recipient address rejected" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[tool:");
    expect(hints[0]).not.toContain(":connect");
  });

  it("keeps the older wording when the engine sent no reason", () => {
    // Engine/CLI version skew: an engine predating the `error` field sends an
    // `error` outcome with nothing to render, so pointing at the tool line
    // would send the user looking for a reason that is not there.
    for (const call of [
      { outcome: "error" as const },
      { outcome: "error" as const, error: "" },
    ]) {
      const hints = postTurnHints([call]);
      expect(hints[0]).not.toContain("[tool:");
      expect(hints[0]).toContain("already connected");
    }
  });

  it("not_connected takes priority over denied (the most actionable wins)", () => {
    // The not-connected case is reported as a deny under the hood, so the
    // governance pipeline will often surface BOTH outcomes on the same
    // turn. The user's first move must be :connect — otherwise they chase a
    // denial that is really a missing connection, and end up in a confused loop.
    const hints = postTurnHints([
      { outcome: "denied" },
      { outcome: "not_connected" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(":connect");
    expect(hints[0]).not.toContain("denied by your policy");
  });

  it("not_connected takes priority over error", () => {
    const hints = postTurnHints([
      { outcome: "error" },
      { outcome: "not_connected" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(":connect");
  });

  it("denial takes priority over error", () => {
    const hints = postTurnHints([
      { outcome: "error" },
      { outcome: "denied" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("denied");
  });

  it("still fires the hint when one call was success and another was denied", () => {
    const hints = postTurnHints([
      { outcome: "success" },
      { outcome: "denied" },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("denied");
  });
});
