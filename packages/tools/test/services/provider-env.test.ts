import { describe, it, expect } from "vitest";
import { missingProviderEnv } from "../../src/services/provider-env";
import { googleProvider } from "../../src/services/google/provider";
import { mockProvider } from "../../src/services/mock/provider";
import type { ProviderEnv } from "../../src/services/types";

// A fully configured environment, narrowed per test to model the absences the
// type system cannot express (every ProviderEnv slot is a required `string`).
const CONFIGURED: ProviderEnv = {
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  SLACK_CLIENT_ID: "slack-id",
  SLACK_CLIENT_SECRET: "slack-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  MICROSOFT_CLIENT_ID: "microsoft-id",
  MICROSOFT_CLIENT_SECRET: "microsoft-secret",
};

/** Drop keys from a configured env, as an unset binding would. */
function without(...keys: (keyof ProviderEnv)[]): ProviderEnv {
  const env: Record<string, string> = { ...CONFIGURED };
  for (const key of keys) delete env[key];
  return env as unknown as ProviderEnv;
}

describe("missingProviderEnv", () => {
  it("reports nothing when every declared key is set", () => {
    expect(missingProviderEnv(googleProvider, CONFIGURED)).toEqual([]);
  });

  it("reports an absent key", () => {
    expect(missingProviderEnv(googleProvider, without("GOOGLE_CLIENT_ID"))).toEqual([
      "GOOGLE_CLIENT_ID",
    ]);
  });

  it("reports every absent key in declaration order", () => {
    expect(
      missingProviderEnv(
        googleProvider,
        without("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
      ),
    ).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  });

  it("reports the secret alone when only the id is set", () => {
    // The id-only deployment: begin-flow would pass and the token exchange
    // would then fail just as opaquely, so the secret is checked up front too.
    expect(
      missingProviderEnv(googleProvider, without("GOOGLE_CLIENT_SECRET")),
    ).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });

  it("treats a set-but-blank key as missing", () => {
    // `GOOGLE_CLIENT_ID=` in a .env file: present to the runtime, useless to
    // the authorization server.
    expect(
      missingProviderEnv(googleProvider, {
        ...CONFIGURED,
        GOOGLE_CLIENT_ID: "",
      }),
    ).toEqual(["GOOGLE_CLIENT_ID"]);
  });

  it("treats a whitespace-only key as missing", () => {
    expect(
      missingProviderEnv(googleProvider, {
        ...CONFIGURED,
        GOOGLE_CLIENT_SECRET: "   ",
      }),
    ).toEqual(["GOOGLE_CLIENT_SECRET"]);
  });

  it("ignores another provider's absent keys", () => {
    // Scoping guard: an unconfigured Slack must not block a Google connect.
    expect(
      missingProviderEnv(
        googleProvider,
        without("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"),
      ),
    ).toEqual([]);
  });

  it("reports nothing for the mock on a wholly unconfigured environment", () => {
    // The mock declares no requirement, so onboarding against it works on a
    // deployment that has registered no OAuth client at all.
    const bare = {} as unknown as ProviderEnv;
    expect(missingProviderEnv(mockProvider, bare)).toEqual([]);
  });
});
