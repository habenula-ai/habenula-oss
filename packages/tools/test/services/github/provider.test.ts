import { describe, it, expect } from "vitest";
import {
  exchangeGithubCode,
  refreshGithubToken,
} from "../../../src/services/github/provider";

/**
 * Hand-authored token-endpoint fixtures of the documented shape (unlike
 * Slack's live-captured ones — GitHub's response is flat and unambiguous, so
 * a live capture buys nothing and would only risk committing a real token).
 * Every token value is an obvious non-secret placeholder. `scope` is always
 * "" for a GitHub App user token; `refresh_token_expires_in` is present in
 * the response but deliberately unstored.
 */
const exchangeFixture = {
  access_token: "ghu_placeholder-user-access-token-exchange",
  expires_in: 28800,
  refresh_token: "ghr_placeholder-refresh-token-exchange",
  refresh_token_expires_in: 15811200,
  token_type: "bearer",
  scope: "",
};

const refreshFixture = {
  access_token: "ghu_placeholder-user-access-token-refreshed",
  expires_in: 28800,
  refresh_token: "ghr_placeholder-refresh-token-rotated",
  refresh_token_expires_in: 15811200,
  token_type: "bearer",
  scope: "",
};

/** Create a mock fetch that returns the given JSON response. */
function mockFetch(status: number, body: Record<string, unknown>) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("GitHub OAuth", () => {
  describe("exchangeGithubCode", () => {
    it("maps ghu_/ghr_/expires_in onto StoredCredential with scopes: []", async () => {
      const result = await exchangeGithubCode({
        code: "test-auth-code",
        codeVerifier: "test-verifier",
        redirectUri: "http://localhost:8787/callback/github",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, exchangeFixture),
      });

      expect(result.access_token).toBe(exchangeFixture.access_token);
      expect(result.access_token).not.toBe("");
      expect(result.refresh_token).toBe(exchangeFixture.refresh_token);
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // Always empty: a GitHub App user token reports no classic scopes —
      // its reach lives in the App's fine-grained permissions.
      expect(result.scopes).toEqual([]);
    });

    it("rejects a response missing expires_in (misconfigured App)", async () => {
      // The signature of a GitHub App with "Expire user authorization
      // tokens" off: a non-expiring token with no refresh token — the one
      // shape the harness cannot maintain. Fail loud at the exchange.
      const { expires_in: _e, refresh_token: _r, ...nonExpiring } =
        exchangeFixture;
      await expect(
        exchangeGithubCode({
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/github",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, nonExpiring),
        }),
      ).rejects.toThrow("Expire user authorization tokens");
    });

    it("rejects a response missing refresh_token (misconfigured App)", async () => {
      const { refresh_token: _r, ...noRefresh } = exchangeFixture;
      await expect(
        exchangeGithubCode({
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/github",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, noRefresh),
        }),
      ).rejects.toThrow("Expire user authorization tokens");
    });

    it("throws on an error body (GitHub reports some failures as HTTP 200)", async () => {
      await expect(
        exchangeGithubCode({
          code: "redeemed-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/github",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, {
            error: "bad_verification_code",
            error_description: "The code passed is incorrect or expired.",
          }),
        }),
      ).rejects.toThrow("bad_verification_code");
    });

    it("throws on a non-2xx with the body text", async () => {
      await expect(
        exchangeGithubCode({
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/github",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: async () =>
            new Response("Not Found", { status: 404 }),
        }),
      ).rejects.toThrow("GitHub token exchange failed (404)");
    });

    it("sends the code_verifier and Accept: application/json", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedAccept = "";

      const capturingFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = (init?.body as string) ?? "";
        capturedAccept = new Headers(init?.headers).get("Accept") ?? "";
        return new Response(JSON.stringify(exchangeFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await exchangeGithubCode({
        code: "my-code",
        codeVerifier: "my-verifier",
        redirectUri: "http://localhost/callback/github",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      expect(capturedUrl).toBe("https://github.com/login/oauth/access_token");
      // Without this header GitHub answers form-encoded, not JSON.
      expect(capturedAccept).toBe("application/json");
      const params = new URLSearchParams(capturedBody);
      expect(params.get("code")).toBe("my-code");
      // PKCE proof — beginAuth sent the S256 challenge (unlike Slack).
      expect(params.get("code_verifier")).toBe("my-verifier");
      expect(params.get("redirect_uri")).toBe(
        "http://localhost/callback/github",
      );
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
    });
  });

  describe("refreshGithubToken", () => {
    it("maps the flat response and returns the NEW refresh token", async () => {
      const result = await refreshGithubToken({
        refreshToken: "ghr_placeholder-refresh-token-exchange",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, refreshFixture),
      });

      expect(result.access_token).toBe(refreshFixture.access_token);
      expect(result.access_token).not.toBe("");
      // Single-use rotation: the credential must carry the newly issued
      // ghr_, never echo the one just spent — Google's `?? old` fallback
      // here would brick the connection on the next refresh.
      expect(result.refresh_token).toBe(refreshFixture.refresh_token);
      expect(result.refresh_token).not.toBe(
        "ghr_placeholder-refresh-token-exchange",
      );
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(result.scopes).toEqual([]);
    });

    it("rejects a refresh response missing the rotation fields", async () => {
      const { expires_in: _e, refresh_token: _r, ...nonRotating } =
        refreshFixture;
      await expect(
        refreshGithubToken({
          refreshToken: "ghr_placeholder-any",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, nonRotating),
        }),
      ).rejects.toThrow("Expire user authorization tokens");
    });

    it("throws on an error body (e.g. a lapsed refresh token)", async () => {
      // GitHub expires an unused ghr_ after six months; the reactive
      // handling is this throw propagating to dispatch's credential-
      // resolution catch — never a silent success.
      await expect(
        refreshGithubToken({
          refreshToken: "ghr_placeholder-lapsed",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, { error: "bad_refresh_token" }),
        }),
      ).rejects.toThrow("bad_refresh_token");
    });

    it("sends grant_type=refresh_token with the old token and Accept header", async () => {
      let capturedBody = "";
      let capturedAccept = "";
      const capturingFetch = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedBody = (init?.body as string) ?? "";
        capturedAccept = new Headers(init?.headers).get("Accept") ?? "";
        return new Response(JSON.stringify(refreshFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await refreshGithubToken({
        refreshToken: "old-refresh-token",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      expect(capturedAccept).toBe("application/json");
      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("old-refresh-token");
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
      expect(params.get("code")).toBeNull();
    });
  });
});
