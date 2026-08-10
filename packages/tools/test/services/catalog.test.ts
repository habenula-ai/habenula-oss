import { describe, it, expect } from "vitest";
import {
  SERVICES,
  OAUTH_PROVIDERS,
  REFRESH_FNS,
  lookupService,
} from "../../src/services/catalog";
import { mockProvider } from "../../src/services/mock/provider";
import type { ProviderEnv } from "../../src/services/types";
import { listTools, lookupTool, toolName } from "../../src/tools/registry";

/**
 * The catalog is the single source of truth: the tool registry and the refresh
 * map derive from it, so they cannot drift. These assertions are the
 * consistency guard.
 */
describe("service catalog consistency", () => {
  it("every OAuth service's provider is a registered OAUTH_PROVIDERS key", () => {
    // The connect entry and the shared callback resolve a service's OAuth
    // machinery through OAUTH_PROVIDERS[connect.provider]; an unregistered
    // provider would fail at first connect. Caught here instead.
    for (const service of SERVICES) {
      if (service.connect.type === "oauth") {
        expect(
          OAUTH_PROVIDERS[service.connect.provider],
          `service "${service.service}" names provider ` +
            `"${service.connect.provider}", which has no strategy registered`,
        ).toBeDefined();
      }
    }
  });

  it("listTools is exactly the flattened catalog tools, and every tool's service is declared", () => {
    const declared = new Set(SERVICES.map((s) => s.service));
    for (const tool of listTools()) {
      expect(declared.has(tool.service)).toBe(true);
    }
    expect(listTools()).toEqual(SERVICES.flatMap((s) => s.tools));
  });

  it("a service's tools resolve a refresh entry iff the service is OAuth", () => {
    // Connect-type-aware refresh coverage: dispatch resolves a tool's
    // credential via REFRESH_FNS keyed on the tool's service. Every OAuth
    // service's tools must resolve a refresh function (a tool shipped without
    // its refresh wiring fails closed at first call — caught here instead),
    // and every credential-less `none` service's tools must resolve none (a
    // `none` tool wrongly wired to a refresh is equally a catalog bug).
    for (const service of SERVICES) {
      const expectRefresh = service.connect.type === "oauth";
      for (const tool of service.tools) {
        // A tool must live under its own service's entry — otherwise the
        // REFRESH_FNS lookup below keys on the wrong service and a misfiled
        // tool (declared under another same-connect-type entry) passes CI.
        expect(tool.service).toBe(service.service);
        expect(
          typeof REFRESH_FNS[tool.service],
          `service "${tool.service}" (tool ${toolName(tool)}) should ` +
            (expectRefresh
              ? "have a refresh mapping"
              : "not have a refresh mapping (connect type is 'none')"),
        ).toBe(expectRefresh ? "function" : "undefined");
      }
    }
    // And the map holds nothing beyond the catalog's OAuth services.
    const oauthServices = SERVICES.filter(
      (s) => s.connect.type === "oauth",
    ).map((s) => s.service);
    expect(Object.keys(REFRESH_FNS).sort()).toEqual([...oauthServices].sort());
  });

  it("every provider's requiredEnv covers what its begin-flow reads", () => {
    // Drift guard for `requiredEnv`. Run each strategy's begin-flow against an
    // env that satisfies exactly its declared requirement and supplies nothing
    // else. A strategy reading a var it forgot to declare gets `undefined`,
    // which URLSearchParams coerces into the literal string — the precise
    // failure the declaration exists to prevent, so the authorize URL must
    // never contain it. A new provider is covered here the moment it registers.
    for (const [providerId, strategy] of Object.entries(OAUTH_PROVIDERS)) {
      const env = Object.fromEntries(
        strategy.requiredEnv.map((key) => [key, `declared-${key}`]),
      ) as unknown as ProviderEnv;

      const { authorizeUrl } = strategy.beginAuth(env, {
        scopes: ["https://example.test/scope"],
        state: "drift-user:0123456789abcdef",
        codeChallenge: "drift-challenge",
        // Absolute, because the mock resolves its in-process consent path
        // against this value rather than an off-origin authorization server.
        redirectUri: "http://localhost/callback/drift",
      });

      expect(
        authorizeUrl,
        `provider "${providerId}" emitted an unset env var into its authorize ` +
          `URL — its requiredEnv omits a var its beginAuth reads`,
      ).not.toContain("undefined");
    }
  });

  it("every non-mock provider declares a client id and secret requirement", () => {
    // The mock needs no registered client; every real provider authenticates
    // with both halves, so a strategy declaring neither would silently opt out
    // of the connect entry's configuration refusal.
    for (const [providerId, strategy] of Object.entries(OAUTH_PROVIDERS)) {
      const expected = strategy === mockProvider ? 0 : 2;
      expect(
        strategy.requiredEnv.length,
        `provider "${providerId}" declares ${strategy.requiredEnv.length} ` +
          `required env var(s); expected ${expected}`,
      ).toBe(expected);
    }
  });

  it("lookupService resolves declared names and rejects unknowns", () => {
    expect(lookupService("gmail")?.service).toBe("gmail");
    expect(lookupService("mock_email")?.service).toBe("mock_email");
    expect(lookupService("not-a-service")).toBeNull();
    // Names unified to the underscore form: the hyphen spelling of a real
    // service must not resolve. Guards against re-introducing the old
    // `mock-email` alias (the connect entry now posts the verbatim name).
    expect(lookupService("mock-email")).toBeNull();
  });

  it("lookupTool resolves by the ${service}_${verb} name", () => {
    for (const tool of listTools()) {
      expect(lookupTool(toolName(tool))).toBe(tool);
    }
    expect(lookupTool("does_not_exist")).toBeNull();
  });
});
