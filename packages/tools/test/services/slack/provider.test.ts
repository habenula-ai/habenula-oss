import { describe, it, expect } from "vitest";
import {
  exchangeSlackCode,
  refreshSlackToken,
} from "../../../src/services/slack/provider";
import exchangeFixture from "./fixtures/oauth-exchange.json";
import refreshFixture from "./fixtures/oauth-refresh.json";

/**
 * The two OAuth parse paths are asserted against the checked-in fixtures
 * (see fixtures/README.md for provenance): the exchange leg reads the user
 * token NESTED under authed_user, the refresh leg reads it FLAT at the top
 * level. A copy-paste between the two mappings is the silent-credential bug
 * these fixtures guard against — each leg's fixture makes the wrong
 * nesting fail, not just differ.
 */

/** Create a mock fetch that returns the given JSON response. */
function mockFetch(status: number, body: Record<string, unknown>) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("Slack OAuth", () => {
  describe("exchangeSlackCode (nested authed_user shape)", () => {
    it("maps the authed_user fields onto StoredCredential", async () => {
      const result = await exchangeSlackCode({
        code: "test-auth-code",
        redirectUri: "http://localhost:8787/callback/slack",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, exchangeFixture),
      });

      // Non-empty access token and numeric expiry — the two properties whose
      // silent absence is the bug class this file guards against.
      expect(result.access_token).toBe(
        exchangeFixture.authed_user.access_token,
      );
      expect(result.access_token).not.toBe("");
      expect(result.refresh_token).toBe(
        exchangeFixture.authed_user.refresh_token,
      );
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // Comma-split, from authed_user.scope.
      expect(result.scopes).toEqual(
        exchangeFixture.authed_user.scope.split(","),
      );
    });

    it("reads the user token, never the top-level (bot) slot", async () => {
      // A both-tokens response: top level carries a bot token. A wrongly
      // top-level-reading mapping returns the bot token here instead of the
      // nested user token.
      const result = await exchangeSlackCode({
        code: "test-auth-code",
        redirectUri: "http://localhost:8787/callback/slack",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, {
          ...exchangeFixture,
          access_token: "scrubbed-bot-access-token",
          token_type: "bot",
          expires_in: 99999,
          refresh_token: "scrubbed-bot-refresh-token",
        }),
      });

      expect(result.access_token).toBe(
        exchangeFixture.authed_user.access_token,
      );
      expect(result.refresh_token).toBe(
        exchangeFixture.authed_user.refresh_token,
      );
    });

    it("throws on ok:false (Slack reports errors as HTTP 200)", async () => {
      await expect(
        exchangeSlackCode({
          code: "redeemed-code",
          redirectUri: "http://localhost:8787/callback/slack",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, { ok: false, error: "invalid_code" }),
        }),
      ).rejects.toThrow("Slack token exchange failed: invalid_code");
    });

    it("throws when authed_user.access_token is missing", async () => {
      // e.g. an app wrongly authorized with bot scope only.
      await expect(
        exchangeSlackCode({
          code: "test-code",
          redirectUri: "http://localhost:8787/callback/slack",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, {
            ok: true,
            access_token: "scrubbed-bot-access-token",
            token_type: "bot",
            authed_user: { id: "U0000000000" },
          }),
        }),
      ).rejects.toThrow("missing authed_user.access_token");
    });

    it("throws when rotation fields are absent (rotation not enabled)", async () => {
      // A non-rotating user token has no expires_in/refresh_token; storing it
      // would leave a never-expiring secret — fail loud at the exchange.
      await expect(
        exchangeSlackCode({
          code: "test-code",
          redirectUri: "http://localhost:8787/callback/slack",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, {
            ok: true,
            authed_user: {
              id: "U0000000000",
              scope: "chat:write",
              access_token: "scrubbed-non-rotating-user-token",
              token_type: "user",
            },
          }),
        }),
      ).rejects.toThrow("is token rotation enabled?");
    });

    it("sends correct parameters — and no code_verifier", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      const capturingFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify(exchangeFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await exchangeSlackCode({
        code: "my-code",
        redirectUri: "http://localhost/callback/slack",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      expect(capturedUrl).toBe("https://slack.com/api/oauth.v2.access");
      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("my-code");
      expect(params.get("redirect_uri")).toBe("http://localhost/callback/slack");
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
      // Slack gets no PKCE proof: beginAuth sent no code_challenge, so the
      // exchange must not send a verifier.
      expect(params.get("code_verifier")).toBeNull();
    });
  });

  describe("refreshSlackToken (flat top-level shape)", () => {
    it("maps the flat fields onto StoredCredential, including the NEW refresh token", async () => {
      const result = await refreshSlackToken({
        refreshToken: "scrubbed-user-refresh-token-exchange",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, refreshFixture),
      });

      // Flat reads: authed_user does not exist on this leg. A copy of the
      // exchange mapping would find no access token here and throw.
      expect(result.access_token).toBe(refreshFixture.access_token);
      expect(result.access_token).not.toBe("");
      // Single-use rotation: the credential must carry the NEW refresh token,
      // not echo the one just spent.
      expect(result.refresh_token).toBe(refreshFixture.refresh_token);
      expect(result.refresh_token).not.toBe(
        "scrubbed-user-refresh-token-exchange",
      );
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.scopes).toEqual(refreshFixture.scope.split(","));
    });

    it("throws on ok:false", async () => {
      await expect(
        refreshSlackToken({
          refreshToken: "spent-refresh-token",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, { ok: false, error: "invalid_refresh_token" }),
        }),
      ).rejects.toThrow("Slack token refresh failed: invalid_refresh_token");
    });

    it("sends grant_type=refresh_token with the old refresh token", async () => {
      let capturedBody = "";
      const capturingFetch = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify(refreshFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await refreshSlackToken({
        refreshToken: "old-refresh-token",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("old-refresh-token");
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
      expect(params.get("code")).toBeNull();
    });
  });
});
