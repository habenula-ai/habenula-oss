// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { OAuthProviderStrategy } from "../types.js";

/**
 * Entra ID (Microsoft identity platform) v2.0 endpoints under the `common`
 * tenant, so both work/school and personal Microsoft accounts can connect
 * (`organizations` would exclude consumers).
 */
export const MICROSOFT_AUTH_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

type FetchFn = typeof globalThis.fetch;

export interface MicrosoftTokenExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

export interface MicrosoftTokenRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

/**
 * The fields both token-endpoint legs parse. `ext_expires_in` (a resilience
 * window for Entra outages) is read and discarded — StoredCredential has no
 * field for it. `scope` carries the granted set; Entra's form varies between
 * fully-qualified (`https://graph.microsoft.com/Mail.Read`) and short
 * (`Mail.Read`), which is why every stored scope runs through
 * normalizeGraphScope.
 */
interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  ext_expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Canonicalize one granted scope: strip a leading
 * `https://graph.microsoft.com/` and lowercase. Resource-less scopes
 * (`offline_access`) pass through intact. The scope gate (user-agent.ts) is
 * an exact string-membership check, so the provider stores every granted
 * scope in this canonical form and the capability map
 * (OUTLOOK_MAIL_CAPABILITY_SCOPES) declares the same form — both sides of
 * the comparison are Microsoft-owned code, self-consistent whatever form
 * Entra returns.
 */
export function normalizeGraphScope(scope: string): string {
  const lower = scope.toLowerCase();
  const prefix = "https://graph.microsoft.com/";
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
}

/** Split a granted `scope` string and canonicalize every entry. */
function normalizeScopes(scope: string): string[] {
  return scope.split(" ").filter(Boolean).map(normalizeGraphScope);
}

/**
 * Guard the rotating refresh token on both token-endpoint legs (modeled on
 * github/provider.ts's assertRotatingToken). Microsoft rotates the refresh
 * token on every refresh and invalidates the old one, and `offline_access`
 * guarantees one at the exchange — so a missing field is an anomaly to fail
 * loud on, never a signal to reuse the old token: a
 * `data.refresh_token ?? old` fallback (Google's rule, correct only because
 * Google legitimately omits the field) would silently persist the token
 * Entra just invalidated and brick the connection on the next refresh.
 */
function assertRotatingToken<T extends { refresh_token?: string }>(
  leg: string,
  fields: T,
): asserts fields is T & { refresh_token: string } {
  if (!fields.refresh_token) {
    throw new Error(
      `Microsoft ${leg} response missing refresh_token — is offline_access in the requested scopes?`,
    );
  }
}

/**
 * One POST to Entra's token endpoint. Entra reports failures with real HTTP
 * status codes (unlike GitHub's 200-with-error-body), so the non-OK check
 * covers the error shapes; the body text carries Entra's error JSON for the
 * thrown message.
 */
async function microsoftTokenCall(
  leg: string,
  body: URLSearchParams,
  fetchFn: FetchFn,
): Promise<MicrosoftTokenResponse> {
  const res = await fetchFn(MICROSOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft ${leg} failed (${String(res.status)}): ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

/** Map a validated token response onto the stored credential shape. */
function toStoredCredential(
  data: MicrosoftTokenResponse & { refresh_token: string },
  scopes: string[],
): StoredCredential {
  const expiresIn =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in
      : 3600;
  return {
    access_token: data.access_token!,
    // The rotated token, stored directly — never `?? old` (see
    // assertRotatingToken).
    refresh_token: data.refresh_token,
    expiry_unix: Math.floor(Date.now() / 1000) + expiresIn,
    scopes,
  };
}

/**
 * Exchange an authorization code for access + refresh tokens. Entra verifies
 * the PKCE code_verifier against the code_challenge sent during
 * authorization. The rotating-token guard runs on this leg too: with
 * `offline_access` requested a refresh token is guaranteed, so its absence
 * signals a misconfigured scope set and must fail loud rather than store a
 * non-refreshable credential.
 */
export async function exchangeMicrosoftCode(
  params: MicrosoftTokenExchangeParams,
): Promise<StoredCredential> {
  const data = await microsoftTokenCall(
    "token exchange",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code_verifier: params.codeVerifier,
    }),
    params.fetchFn ?? globalThis.fetch,
  );

  if (!data.access_token) {
    throw new Error("Microsoft token response missing access_token");
  }
  assertRotatingToken("token exchange", data);
  return toStoredCredential(data, normalizeScopes(data.scope ?? ""));
}

/**
 * Refresh the access token. Microsoft rotates: the response's refresh_token
 * replaces the old one, asserted present and stored directly (GitHub's rule
 * for a rotating provider, not Google's preserve-old). Scopes are preserved
 * from the old credential when the response omits `scope` (RFC 6749 §5.1),
 * normalized when present.
 */
export async function refreshMicrosoftToken(
  params: MicrosoftTokenRefreshParams,
  /** Original scopes to preserve when the response omits scope. */
  originalScopes?: string[],
): Promise<StoredCredential> {
  const data = await microsoftTokenCall(
    "token refresh",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }),
    params.fetchFn ?? globalThis.fetch,
  );

  if (!data.access_token) {
    throw new Error("Microsoft refresh response missing access_token");
  }
  assertRotatingToken("token refresh", data);
  return toStoredCredential(
    data,
    data.scope ? normalizeScopes(data.scope) : (originalScopes ?? []),
  );
}

/**
 * The microsoft provider strategy: Entra ID auth-code with PKCE under the
 * `common` tenant. The OAuth machinery every
 * Microsoft service (outlook_mail today; Teams, OneDrive, Calendar later)
 * shares — services differ only in the scopes their `connect` arm
 * contributes.
 */
export const microsoftProvider: OAuthProviderStrategy = {
  callbackPath: "/callback/microsoft",
  requiredEnv: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],

  beginAuth(env, init) {
    const authorizeUrl = new URL(MICROSOFT_AUTH_URL);
    authorizeUrl.searchParams.set("client_id", env.MICROSOFT_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", init.redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", init.scopes.join(" "));
    // Account chooser under the `common` tenant: a user with both a
    // work/school and a personal Microsoft account picks explicitly. No
    // `include_granted_scopes` / `access_type` — those are Google parameters
    // with no Microsoft equivalent (the refresh token covers the full
    // consented set regardless).
    authorizeUrl.searchParams.set("prompt", "select_account");
    authorizeUrl.searchParams.set("state", init.state);
    authorizeUrl.searchParams.set("code_challenge", init.codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    // Entra's authorization server issues the code — nothing minted here.
    return { authorizeUrl: authorizeUrl.toString(), authCode: null };
  },

  exchangeCode(env, { query, state, redirectUri }) {
    // The `scopes` arm the shared callback passes is unused — like Google,
    // the granted set is read from the token response (then canonicalized).
    return exchangeMicrosoftCode({
      // The shared callback rejects a missing `code` before calling here.
      code: query.get("code")!,
      codeVerifier: state.code_verifier,
      redirectUri,
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
    });
  },

  // Refresh against the same token endpoint with grant_type=refresh_token.
  refresh: (old, env) =>
    refreshMicrosoftToken(
      {
        refreshToken: old.refresh_token,
        clientId: env.MICROSOFT_CLIENT_ID,
        clientSecret: env.MICROSOFT_CLIENT_SECRET,
      },
      old.scopes,
    ),
};
