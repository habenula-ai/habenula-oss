import { describe, it, expect } from "vitest";
import {
  exchangeCodeForTokens,
  refreshGmailToken,
} from "../../../src/services/google/provider";

/** Create a mock fetch that returns the given JSON response. */
function mockFetch(status: number, body: Record<string, unknown>) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("Google OAuth", () => {
  describe("exchangeCodeForTokens", () => {
    it("exchanges code for tokens on success", async () => {
      const result = await exchangeCodeForTokens({
        code: "4/test-auth-code",
        codeVerifier: "test-verifier-43chars-abcdefghijklmnopqrst",
        redirectUri: "http://localhost:8787/callback/google",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, {
          access_token: "ya29.test-access-token",
          refresh_token: "1//test-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
      });

      expect(result.access_token).toBe("ya29.test-access-token");
      expect(result.refresh_token).toBe("1//test-refresh-token");
      expect(result.expiry_unix).toBeGreaterThan(
        Math.floor(Date.now() / 1000),
      );
      expect(result.scopes).toEqual([
        "https://www.googleapis.com/auth/gmail.readonly",
      ]);
    });

    it("throws on error response from Google", async () => {
      await expect(
        exchangeCodeForTokens({
          code: "4/expired-code",
          codeVerifier: "test-verifier-43chars-abcdefghijklmnopqrst",
          redirectUri: "http://localhost:8787/callback/google",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(400, {
            error: "invalid_grant",
            error_description: "Code has already been redeemed.",
          }),
        }),
      ).rejects.toThrow("Google token exchange failed (400)");
    });

    it("handles missing refresh_token in response", async () => {
      const result = await exchangeCodeForTokens({
        code: "4/test-code",
        codeVerifier: "test-verifier-43chars-abcdefghijklmnopqrst",
        redirectUri: "http://localhost:8787/callback/google",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, {
          access_token: "ya29.no-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
      });

      expect(result.access_token).toBe("ya29.no-refresh");
      expect(result.refresh_token).toBe("");
    });

    it("sends correct parameters to Google token endpoint", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      const capturingFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = (init?.body as string) ?? "";
        return new Response(
          JSON.stringify({
            access_token: "ya29.test",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      await exchangeCodeForTokens({
        code: "4/my-code",
        codeVerifier: "my-verifier",
        redirectUri: "http://localhost/callback/google",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("4/my-code");
      expect(params.get("code_verifier")).toBe("my-verifier");
      expect(params.get("redirect_uri")).toBe(
        "http://localhost/callback/google",
      );
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
    });
  });

  describe("refreshGmailToken", () => {
    it("refreshes token and preserves old refresh_token when not rotated", async () => {
      const result = await refreshGmailToken({
        refreshToken: "1//original-refresh",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, {
          access_token: "ya29.refreshed-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
      });

      expect(result.access_token).toBe("ya29.refreshed-token");
      expect(result.refresh_token).toBe("1//original-refresh");
    });

    it("uses new refresh_token when Google rotates it", async () => {
      const result = await refreshGmailToken({
        refreshToken: "1//old-refresh",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, {
          access_token: "ya29.rotated-access",
          refresh_token: "1//rotated-refresh",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
      });

      expect(result.access_token).toBe("ya29.rotated-access");
      expect(result.refresh_token).toBe("1//rotated-refresh");
    });

    it("throws on error response", async () => {
      await expect(
        refreshGmailToken({
          refreshToken: "1//revoked-token",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(401, {
            error: "invalid_grant",
            error_description: "Token has been revoked.",
          }),
        }),
      ).rejects.toThrow("Google token refresh failed (401)");
    });
  });
});
