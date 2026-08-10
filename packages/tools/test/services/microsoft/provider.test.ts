import { describe, it, expect } from "vitest";
import {
  exchangeMicrosoftCode,
  refreshMicrosoftToken,
  normalizeGraphScope,
  MICROSOFT_TOKEN_URL,
} from "../../../src/services/microsoft/provider";
import exchangeFixture from "./fixtures/oauth-exchange.json";
import refreshFixture from "./fixtures/oauth-refresh.json";

/**
 * Both OAuth legs are asserted against the checked-in fixtures (see
 * fixtures/README.md for provenance). The two provider-specific hazards
 * pinned here: the rotating refresh token — assert-and-replace, throw on a
 * missing rotated token, never a silent preserve of the spent one — and
 * scope canonicalization, since the fixtures carry Entra's fully-qualified
 * mixed-case scope form and the scope gate matches exact strings.
 */

/** Create a mock fetch that returns the given JSON response. */
function mockFetch(status: number, body: Record<string, unknown>) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("normalizeGraphScope", () => {
  it("strips the Graph resource prefix and lowercases", () => {
    expect(normalizeGraphScope("https://graph.microsoft.com/Mail.Read")).toBe(
      "mail.read",
    );
    expect(
      normalizeGraphScope("https://graph.microsoft.com/Mail.ReadWrite"),
    ).toBe("mail.readwrite");
  });

  it("lowercases a short-form scope", () => {
    expect(normalizeGraphScope("Mail.Send")).toBe("mail.send");
    expect(normalizeGraphScope("mail.read")).toBe("mail.read");
  });

  it("leaves resource-less scopes intact", () => {
    expect(normalizeGraphScope("offline_access")).toBe("offline_access");
  });
});

describe("Microsoft OAuth", () => {
  describe("exchangeMicrosoftCode", () => {
    it("populates all four StoredCredential fields from the fixture", async () => {
      const result = await exchangeMicrosoftCode({
        code: "test-auth-code",
        codeVerifier: "test-verifier",
        redirectUri: "http://localhost:8787/callback/microsoft",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, exchangeFixture),
      });

      expect(result.access_token).toBe(exchangeFixture.access_token);
      expect(result.access_token).not.toBe("");
      expect(result.refresh_token).toBe(exchangeFixture.refresh_token);
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // The fixture's fully-qualified mixed-case scopes store canonicalized —
      // the exact strings the scope gate will compare against the capability
      // map's declared form.
      expect(result.scopes).toEqual(["mail.read", "mail.send"]);
    });

    it("rejects a response missing refresh_token (misconfigured scope set)", async () => {
      // offline_access guarantees a refresh token at the exchange; its
      // absence would store a credential the refresher can't maintain —
      // every Microsoft service silently becomes re-connect-on-expiry.
      const { refresh_token: _r, ...noRefresh } = exchangeFixture;
      await expect(
        exchangeMicrosoftCode({
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/microsoft",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, noRefresh),
        }),
      ).rejects.toThrow("offline_access");
    });

    it("rejects a response missing access_token", async () => {
      const { access_token: _a, ...noAccess } = exchangeFixture;
      await expect(
        exchangeMicrosoftCode({
          code: "test-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/microsoft",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, noAccess),
        }),
      ).rejects.toThrow("missing access_token");
    });

    it("throws on a non-2xx with Entra's error body in the message", async () => {
      // Entra reports failures with real HTTP status codes; the body is its
      // error JSON (error, error_description, error_codes, …).
      await expect(
        exchangeMicrosoftCode({
          code: "redeemed-code",
          codeVerifier: "test-verifier",
          redirectUri: "http://localhost:8787/callback/microsoft",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(400, {
            error: "invalid_grant",
            error_description:
              "AADSTS70008: The provided authorization code is expired.",
            error_codes: [70008],
          }),
        }),
      ).rejects.toThrow("Microsoft token exchange failed (400)");
    });

    it("sends the code_verifier form-urlencoded to the common-tenant token URL", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedContentType = "";

      const capturingFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = (init?.body as string) ?? "";
        capturedContentType =
          new Headers(init?.headers).get("Content-Type") ?? "";
        return new Response(JSON.stringify(exchangeFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      await exchangeMicrosoftCode({
        code: "my-code",
        codeVerifier: "my-verifier",
        redirectUri: "http://localhost/callback/microsoft",
        clientId: "my-client-id",
        clientSecret: "my-secret",
        fetchFn: capturingFetch,
      });

      expect(capturedUrl).toBe(MICROSOFT_TOKEN_URL);
      expect(capturedUrl).toContain("/common/oauth2/v2.0/token");
      expect(capturedContentType).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(capturedBody);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("my-code");
      // PKCE proof — beginAuth sent the S256 challenge.
      expect(params.get("code_verifier")).toBe("my-verifier");
      expect(params.get("redirect_uri")).toBe(
        "http://localhost/callback/microsoft",
      );
      expect(params.get("client_id")).toBe("my-client-id");
      expect(params.get("client_secret")).toBe("my-secret");
    });
  });

  describe("refreshMicrosoftToken", () => {
    it("REPLACES the refresh token with the rotated one from the response", async () => {
      const result = await refreshMicrosoftToken({
        refreshToken: "scrubbed-ms-refresh-token-exchange",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        fetchFn: mockFetch(200, refreshFixture),
      });

      expect(result.access_token).toBe(refreshFixture.access_token);
      expect(result.access_token).not.toBe("");
      // Single-use rotation: the credential must carry the newly issued
      // token, never echo the one just spent — Google's `?? old` fallback
      // here would silently persist the token Entra just invalidated and
      // brick the connection on the next refresh.
      expect(result.refresh_token).toBe(refreshFixture.refresh_token);
      expect(result.refresh_token).not.toBe(
        "scrubbed-ms-refresh-token-exchange",
      );
      expect(Number.isFinite(result.expiry_unix)).toBe(true);
      expect(result.expiry_unix).toBeGreaterThan(Math.floor(Date.now() / 1000));
      // Canonicalized on this leg too.
      expect(result.scopes).toEqual(["mail.read", "mail.send"]);
    });

    it("THROWS when the response omits the rotated refresh token — never preserves the old one", async () => {
      // The rotating-token guard: for an always-rotating provider a missing
      // field is an anomaly, not a signal to reuse the spent token.
      const { refresh_token: _r, ...noRotated } = refreshFixture;
      await expect(
        refreshMicrosoftToken({
          refreshToken: "scrubbed-ms-refresh-token-exchange",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, noRotated),
        }),
      ).rejects.toThrow("missing refresh_token");
    });

    it("preserves the original scopes when the response omits scope (RFC 6749 §5.1)", async () => {
      const { scope: _s, ...noScope } = refreshFixture;
      const result = await refreshMicrosoftToken(
        {
          refreshToken: "scrubbed-ms-refresh-token-exchange",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(200, noScope),
        },
        ["mail.read", "mail.send", "offline_access"],
      );

      expect(result.scopes).toEqual(["mail.read", "mail.send", "offline_access"]);
    });

    it("throws on an Entra error response (e.g. an expired refresh token)", async () => {
      // Entra invalidates refresh tokens on rotation and expires idle ones;
      // the reactive handling is this throw propagating to dispatch's
      // credential-resolution catch — never a silent success.
      await expect(
        refreshMicrosoftToken({
          refreshToken: "scrubbed-ms-refresh-token-spent",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          fetchFn: mockFetch(400, {
            error: "invalid_grant",
            error_description:
              "AADSTS700082: The refresh token has expired or is invalid.",
            error_codes: [700082],
          }),
        }),
      ).rejects.toThrow("Microsoft token refresh failed (400)");
    });

    it("sends grant_type=refresh_token with the old token", async () => {
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

      await refreshMicrosoftToken({
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
