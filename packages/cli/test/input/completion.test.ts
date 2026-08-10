import { describe, it, expect } from "vitest";
import {
  filterCommands,
  filterServiceArgs,
  computeCompletions,
  reduceMenu,
  CLOSED_MENU,
  type ServiceSource,
  type MenuState,
} from "../../src/input/completion";

/**
 * The pure completion model — command matching, service
 * argument matching, the buffer→items decision, and the arrow reducer. All
 * headless, as earlier work established: the editor's terminal I/O is the only
 * part a real PTY has to cover.
 */

const services: ServiceSource = {
  connectable: ["mock_email", "gmail", "google_calendar", "slack"],
  connected: ["gmail", "slack"],
};

describe("filterCommands", () => {
  it("lists every command for a bare colon", () => {
    const values = filterCommands(":").map((c) => c.value);
    expect(values).toEqual([
      ":help",
      ":status",
      ":cap",
      ":connect",
      ":disconnect",
      ":clear",
      ":kill",
      ":quit",
      ":exit",
    ]);
  });

  it("narrows by prefix", () => {
    expect(filterCommands(":co").map((c) => c.value)).toEqual([":connect"]);
    expect(filterCommands(":q").map((c) => c.value)).toEqual([":quit"]);
  });

  it("flags service-taking commands with expectsArg", () => {
    expect(filterCommands(":connect")).toEqual([{ value: ":connect", expectsArg: true }]);
    expect(filterCommands(":status")).toEqual([{ value: ":status", expectsArg: false }]);
  });

  it("returns nothing for a non-colon buffer (a chat message)", () => {
    expect(filterCommands("hello")).toEqual([]);
    expect(filterCommands("")).toEqual([]);
  });

  it("returns nothing once a space is typed (the command token is complete)", () => {
    expect(filterCommands(":connect ")).toEqual([]);
  });

  it("returns nothing for a no-match stem", () => {
    expect(filterCommands(":zzz")).toEqual([]);
  });
});

describe("filterServiceArgs", () => {
  it("lists the catalog for :connect and narrows by prefix", () => {
    expect(filterServiceArgs(":connect", "", services).map((c) => c.value)).toEqual([
      "mock_email",
      "gmail",
      "google_calendar",
      "slack",
    ]);
    expect(filterServiceArgs(":connect", "g", services).map((c) => c.value)).toEqual([
      "gmail",
      "google_calendar",
    ]);
  });

  it("lists only connected services for :disconnect", () => {
    expect(filterServiceArgs(":disconnect", "", services).map((c) => c.value)).toEqual([
      "gmail",
      "slack",
    ]);
  });

  it("never expects a further arg on a service completion", () => {
    expect(filterServiceArgs(":connect", "gm", services)).toEqual([
      { value: "gmail", expectsArg: false },
    ]);
  });

  it("returns nothing for a command that takes no service argument", () => {
    expect(filterServiceArgs(":status", "", services)).toEqual([]);
    expect(filterServiceArgs(":kill", "g", services)).toEqual([]);
  });
});

describe("computeCompletions", () => {
  it("routes a bare stem to command matching", () => {
    expect(computeCompletions(":dis", services).map((c) => c.value)).toEqual([":disconnect"]);
  });

  it("routes a command + space to service-argument matching", () => {
    expect(computeCompletions(":connect g", services).map((c) => c.value)).toEqual([
      "gmail",
      "google_calendar",
    ]);
  });

  it("lists the whole argument set immediately after the space", () => {
    expect(computeCompletions(":disconnect ", services).map((c) => c.value)).toEqual([
      "gmail",
      "slack",
    ]);
  });

  it("stops completing after the argument is committed with a second space", () => {
    expect(computeCompletions(":connect gmail ", services)).toEqual([]);
    expect(computeCompletions(":connect gmail x", services)).toEqual([]);
  });

  it("offers nothing for a chat message", () => {
    expect(computeCompletions("send an email", services)).toEqual([]);
  });
});

describe("reduceMenu", () => {
  const items = [
    { value: ":connect", expectsArg: true },
    { value: ":disconnect", expectsArg: true },
    { value: ":kill", expectsArg: false },
  ];

  it("opens on a non-empty set and highlights the top", () => {
    const s = reduceMenu(CLOSED_MENU, { type: "set", items });
    expect(s).toEqual({ items, index: 0, open: true });
  });

  it("stays closed on an empty set", () => {
    expect(reduceMenu(CLOSED_MENU, { type: "set", items: [] })).toEqual({
      items: [],
      index: 0,
      open: false,
    });
  });

  it("resets the highlight to the top on every recompute", () => {
    const moved: MenuState = { items, index: 2, open: true };
    expect(reduceMenu(moved, { type: "set", items }).index).toBe(0);
  });

  it("moves down with wraparound", () => {
    let s: MenuState = reduceMenu(CLOSED_MENU, { type: "set", items });
    s = reduceMenu(s, { type: "down" });
    expect(s.index).toBe(1);
    s = reduceMenu(s, { type: "down" });
    s = reduceMenu(s, { type: "down" });
    expect(s.index).toBe(0); // wrapped past the last item
  });

  it("moves up with wraparound from the top", () => {
    const s = reduceMenu(reduceMenu(CLOSED_MENU, { type: "set", items }), { type: "up" });
    expect(s.index).toBe(2); // wrapped to the last item
  });

  it("ignores arrows on a closed or empty menu", () => {
    expect(reduceMenu(CLOSED_MENU, { type: "down" })).toBe(CLOSED_MENU);
    const openEmpty: MenuState = { items: [], index: 0, open: true };
    expect(reduceMenu(openEmpty, { type: "up" })).toBe(openEmpty);
  });

  it("closes on dismiss and keeps the items until the next set", () => {
    const open = reduceMenu(CLOSED_MENU, { type: "set", items });
    const closed = reduceMenu(open, { type: "close" });
    expect(closed.open).toBe(false);
    expect(closed.items).toBe(items);
    // A subsequent recompute reopens it.
    expect(reduceMenu(closed, { type: "set", items }).open).toBe(true);
  });
});
