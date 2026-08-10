import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

/**
 * `loadConfig` resolution, from an explicit env map and an explicit file-vars
 * record so nothing leaks in from the real process.env or the developer's real
 * ~/.habenula/config — every call passes `null` (no file) or a literal record.
 * The `humanTouch` value matrix (1/true/yes/on, fail-safe on junk) is covered
 * in gate/confirm-presence.test.ts; here it is spot-checked as a field only.
 */
describe("loadConfig", () => {
  it("applies defaults from an empty environment and no file", () => {
    const cfg = loadConfig({}, null);
    expect(cfg.apiUrl).toBe("http://localhost:8787");
    expect(cfg.userId).toBe("cli-user");
    expect(cfg.internalMcpUrl).toBe("http://localhost:8787/internal/mcp");
    expect(cfg.internalToken).toBeUndefined();
    expect(cfg.internalTokenSource).toBe("absent");
    expect(cfg.humanTouch).toBe(false);
  });

  it("reads every override from the environment", () => {
    const cfg = loadConfig(
      {
        HABENULA_API_URL: "http://engine.local:9999",
        HABENULA_USER_ID: "user-a",
        HABENULA_INTERNAL_MCP_URL: "http://elsewhere:1234/custom/mcp",
        HABENULA_INTERNAL_MCP_TOKEN: "tok-123",
        HABENULA_HUMAN_TOUCH: "true",
      },
      null,
    );
    expect(cfg.apiUrl).toBe("http://engine.local:9999");
    expect(cfg.userId).toBe("user-a");
    expect(cfg.internalMcpUrl).toBe("http://elsewhere:1234/custom/mcp");
    expect(cfg.internalToken).toBe("tok-123");
    expect(cfg.internalTokenSource).toBe("env");
    expect(cfg.humanTouch).toBe(true);
  });

  it("derives the internal MCP URL from an overridden apiUrl", () => {
    const cfg = loadConfig(
      { HABENULA_API_URL: "https://engine.example:8443/" },
      null,
    );
    expect(cfg.internalMcpUrl).toBe("https://engine.example:8443/internal/mcp");
  });

  it("keeps the derived URL on the default origin when only the token is set", () => {
    const cfg = loadConfig({ HABENULA_INTERNAL_MCP_TOKEN: "tok" }, null);
    expect(cfg.internalMcpUrl).toBe("http://localhost:8787/internal/mcp");
    expect(cfg.internalToken).toBe("tok");
    expect(cfg.internalTokenSource).toBe("env");
  });

  describe("the apiUrl derivation from the local port", () => {
    it("derives apiUrl from a recorded port when HABENULA_API_URL is unset", () => {
      const cfg = loadConfig({}, { HABENULA_PORT: "8788" });
      expect(cfg.apiUrl).toBe("http://localhost:8788");
      expect(cfg.internalMcpUrl).toBe("http://localhost:8788/internal/mcp");
    });

    it("resolves the three port sources in order: environment, file, default", () => {
      expect(
        loadConfig({ HABENULA_PORT: "9001" }, { HABENULA_PORT: "8788" }).apiUrl,
      ).toBe("http://localhost:9001");
      expect(loadConfig({}, { HABENULA_PORT: "8788" }).apiUrl).toBe(
        "http://localhost:8788",
      );
      expect(loadConfig({}, null).apiUrl).toBe("http://localhost:8787");
    });

    it("HABENULA_API_URL wins over the derivation outright", () => {
      const cfg = loadConfig(
        { HABENULA_API_URL: "http://localhost:9999" },
        { HABENULA_PORT: "8788" },
      );
      expect(cfg.apiUrl).toBe("http://localhost:9999");
    });

    it("faults on a malformed port rather than silently dialling the default", () => {
      // Silently ignoring it reported "engine not reachable at
      // http://localhost:8787" while the engine served the port the file wrote
      // down — every signal in the output pointing at the wrong subsystem.
      for (const [env, file] of [
        [{ HABENULA_PORT: "0x22" }, { HABENULA_PORT: "8788" }],
        [{}, { HABENULA_PORT: "0" }],
        [{}, { HABENULA_PORT: "99999" }],
        [{ HABENULA_PORT: "87 88" }, null],
        [{}, { HABENULA_PORT: "8788x" }],
      ] as const) {
        const cfg = loadConfig(env, file);
        expect(cfg.configFault?.message).toMatch(/is not a port/);
      }
    });

    it("names the layer that stated the malformed port", () => {
      expect(loadConfig({ HABENULA_PORT: "nope" }, null).configFault?.message).toContain(
        "HABENULA_PORT in your environment",
      );
      expect(
        loadConfig({}, { HABENULA_PORT: "nope" }).configFault?.message,
      ).toContain("HABENULA_PORT in your habenula config file");
    });

    it("carries no fault for a well-formed config", () => {
      expect(loadConfig({}, { HABENULA_PORT: "8788" }).configFault).toBeUndefined();
      expect(loadConfig({}, null).configFault).toBeUndefined();
    });

    it("treats a blank port assignment as unset, not malformed", () => {
      const cfg = loadConfig({ HABENULA_PORT: "" }, { HABENULA_PORT: "8788" });
      expect(cfg.configFault).toBeUndefined();
      expect(cfg.apiUrl).toBe("http://localhost:8788");
    });
  });

  describe("the file-sourced drive token and its scope", () => {
    const fileWithToken = {
      INTERNAL_MCP_TOKEN: "file-token",
      HABENULA_PORT: "8788",
    };

    /**
     * A live engine started from this config holding the recorded port. Injected
     * so these cases isolate the origin check; the proof itself is covered in
     * its own describe below, and in engine/run-record.test.ts.
     */
    const proven = { daemonHoldsPort: () => true };

    it("resolves the token from the file when the target is the engine the file describes", () => {
      const cfg = loadConfig({}, fileWithToken, proven);
      expect(cfg.internalToken).toBe("file-token");
      expect(cfg.internalTokenSource).toBe("file");
    });

    it("the environment token wins over the file's and records its source", () => {
      const cfg = loadConfig(
        { HABENULA_INTERNAL_MCP_TOKEN: "env-token" },
        fileWithToken,
        proven,
      );
      expect(cfg.internalToken).toBe("env-token");
      expect(cfg.internalTokenSource).toBe("env");
    });

    it("withholds the file's token from a non-local target (withheld-remote)", () => {
      const cfg = loadConfig(
        { HABENULA_API_URL: "https://staging.example.com" },
        fileWithToken,
      );
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-remote");
    });

    it("withholds the file's token from a loopback target on a different port", () => {
      const cfg = loadConfig(
        { HABENULA_API_URL: "http://localhost:9999" },
        fileWithToken,
      );
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-remote");
    });

    it("compares against the internal-MCP origin, not apiUrl", () => {
      // A local apiUrl with a remote internal URL must not carry the token —
      // the token travels in a header addressed to internalMcpUrl.
      const cfg = loadConfig(
        { HABENULA_INTERNAL_MCP_URL: "http://elsewhere:1234/custom/mcp" },
        fileWithToken,
      );
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-remote");
    });

    it("treats the loopback host spellings as one origin", () => {
      const cfg = loadConfig(
        { HABENULA_INTERNAL_MCP_URL: "http://127.0.0.1:8788/internal/mcp" },
        fileWithToken,
        proven,
      );
      expect(cfg.internalToken).toBe("file-token");
      expect(cfg.internalTokenSource).toBe("file");
    });

    it("an environment port keeps the file token resolvable on the engine it configures", () => {
      // HABENULA_PORT=8789 for one run moves the derived origin with it; the
      // file's token must follow, or the escape hatch would withhold the token
      // from the engine the file itself supplied INTERNAL_MCP_TOKEN to.
      const cfg = loadConfig({ HABENULA_PORT: "8789" }, fileWithToken, proven);
      expect(cfg.apiUrl).toBe("http://localhost:8789");
      expect(cfg.internalToken).toBe("file-token");
      expect(cfg.internalTokenSource).toBe("file");
    });

    it("withholds a token from a file with no recorded port (withheld-unrecorded)", () => {
      // The normal intermediate a failed spawn leaves: secrets written, port
      // never recorded. The 8787 default is not a port the file stated, so the
      // comparison must not run against it.
      const cfg = loadConfig({}, { INTERNAL_MCP_TOKEN: "file-token" });
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-unrecorded");
    });

    it("stays withheld-unrecorded even when the target is explicitly the default origin", () => {
      const cfg = loadConfig(
        { HABENULA_API_URL: "http://localhost:8787" },
        { INTERNAL_MCP_TOKEN: "file-token" },
      );
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-unrecorded");
    });

    it("withholds the token when no live engine holds the recorded port (withheld-unproven)", () => {
      // The disclosure this gate closes: `ssh -L 8788:remote:8788` makes
      // http://localhost:8788 a *remote* engine that passes every clause of the
      // origin check, because a loopback address on the recorded port names an
      // address and not an engine.
      const cfg = loadConfig({}, fileWithToken, {
        daemonHoldsPort: () => false,
      });
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-unproven");
    });

    it("asks about the port the token would actually travel to", () => {
      const asked: number[] = [];
      loadConfig({ HABENULA_PORT: "8789" }, fileWithToken, {
        daemonHoldsPort: (port) => {
          asked.push(port);
          return true;
        },
      });
      expect(asked).toEqual([8789]);
    });

    it("withholds by default when the file vars were supplied rather than read", () => {
      // No injected proof and no resolved persist root: nothing has been proven,
      // so a test that hands over file vars can never accidentally prove
      // ownership of a port and let a token travel.
      const cfg = loadConfig({}, fileWithToken);
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("withheld-unproven");
    });

    it("an empty environment token does not shadow the file's", () => {
      // `export HABENULA_INTERNAL_MCP_TOKEN="$UNSET"` in a wrapper script put an
      // empty string in the environment, sent `Authorization: Bearer `, and 401ed
      // with advice about the environment while the right token sat in the file.
      const cfg = loadConfig(
        { HABENULA_INTERNAL_MCP_TOKEN: "  " },
        fileWithToken,
        proven,
      );
      expect(cfg.internalToken).toBe("file-token");
      expect(cfg.internalTokenSource).toBe("file");
    });

    it("an empty token line in the file is absent, not a token", () => {
      const cfg = loadConfig({}, { INTERNAL_MCP_TOKEN: "", HABENULA_PORT: "8788" }, proven);
      expect(cfg.internalToken).toBeUndefined();
      expect(cfg.internalTokenSource).toBe("absent");
    });
  });

  describe("ordinary CLI variables read the file layer too", () => {
    it("reads userId and humanTouch from the file beneath the environment", () => {
      const cfg = loadConfig(
        {},
        { HABENULA_USER_ID: "file-user", HABENULA_HUMAN_TOUCH: "on" },
      );
      expect(cfg.userId).toBe("file-user");
      expect(cfg.humanTouch).toBe(true);
    });

    it("the environment wins over the file for both", () => {
      const cfg = loadConfig(
        { HABENULA_USER_ID: "env-user", HABENULA_HUMAN_TOUCH: "off" },
        { HABENULA_USER_ID: "file-user", HABENULA_HUMAN_TOUCH: "on" },
      );
      expect(cfg.userId).toBe("env-user");
      expect(cfg.humanTouch).toBe(false);
    });
  });

  describe("a blank assignment is unset, not a decision", () => {
    it("an empty HABENULA_HUMAN_TOUCH does not switch the gate off", () => {
      // The gate is value-based so a stray empty assignment cannot switch it ON.
      // The file layer made the reverse possible: an empty export switching a
      // presence check OFF, silently, with approvals then granted unchecked.
      const cfg = loadConfig(
        { HABENULA_HUMAN_TOUCH: "" },
        { HABENULA_HUMAN_TOUCH: "on" },
      );
      expect(cfg.humanTouch).toBe(true);
    });

    it("an explicit off still beats the file's on", () => {
      const cfg = loadConfig(
        { HABENULA_HUMAN_TOUCH: "off" },
        { HABENULA_HUMAN_TOUCH: "on" },
      );
      expect(cfg.humanTouch).toBe(false);
    });

    it("an empty user id falls through to the file, then to the default", () => {
      // An empty userId is not benign: the engine's userIdField only defaults
      // null and undefined, so an empty string routes to an empty-named Durable
      // Object — `kill` would answer { killed: true } having stopped nothing.
      expect(
        loadConfig({ HABENULA_USER_ID: "" }, { HABENULA_USER_ID: "file-user" })
          .userId,
      ).toBe("file-user");
      expect(loadConfig({ HABENULA_USER_ID: "  " }, null).userId).toBe("cli-user");
      expect(loadConfig({}, { HABENULA_USER_ID: "" }).userId).toBe("cli-user");
    });

    it("an empty HABENULA_API_URL falls through to the derivation", () => {
      const cfg = loadConfig({ HABENULA_API_URL: "" }, { HABENULA_PORT: "8788" });
      expect(cfg.apiUrl).toBe("http://localhost:8788");
    });
  });
});
