// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { OAuthProviderStrategy } from "../types.js";

export const GOOGLE_AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type FetchFn = typeof globalThis.fetch;

export interface TokenExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

export interface TokenRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Google's token endpoint verifies the PKCE code_verifier against
 * the code_challenge sent during authorization.
 */
export async function exchangeCodeForTokens(
  params: TokenExchangeParams,
): Promise<StoredCredential> {
  const doFetch = params.fetchFn ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!data.access_token) {
    throw new Error("Google token response missing access_token");
  }

  const expiresIn =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in
      : 3600;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? "",
    expiry_unix: Math.floor(Date.now() / 1000) + expiresIn,
    scopes: data.scope ? data.scope.split(" ") : [],
  };
}

/**
 * Refresh an expired access token using the refresh token.
 * Google may or may not return a new refresh token — if omitted,
 * the caller should preserve the old one.
 */
export async function refreshGmailToken(
  params: TokenRefreshParams,
  /** Original scopes to preserve when Google omits scope in refresh response. */
  originalScopes?: string[],
): Promise<StoredCredential> {
  const doFetch = params.fetchFn ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await doFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!data.access_token) {
    throw new Error("Google refresh response missing access_token");
  }

  const expiresIn =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in
      : 3600;

  return {
    access_token: data.access_token,
    // Preserve old refresh token if Google doesn't return a new one
    refresh_token: data.refresh_token ?? params.refreshToken,
    expiry_unix: Math.floor(Date.now() / 1000) + expiresIn,
    // Preserve original scopes if Google omits scope in refresh response (RFC 6749 §5.1)
    scopes: data.scope ? data.scope.split(" ") : (originalScopes ?? []),
  };
}

/**
 * The google provider strategy: the OAuth machinery every Google service
 * (gmail today, e.g. google_calendar later) shares. Services differ only in
 * the scopes their `connect` arm contributes.
 */
export const googleProvider: OAuthProviderStrategy = {
  callbackPath: "/callback/google",
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],

  beginAuth(env, init) {
    const authorizeUrl = new URL(GOOGLE_AUTH_URL);
    authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", init.redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", init.scopes.join(" "));
    // Per-service consent: include_granted_scopes is
    // deliberately NOT set, so each Google service's consent returns a
    // credential scoped to exactly that service's requested scopes — never
    // the union of every scope the user has granted this OAuth client. A
    // Calendar consent yields a Calendar-only token; re-consenting one Google
    // service never widens another's stored credential. The token exchange
    // stores the *actually granted* scope string — the scope precondition
    // reads that, never this request list.
    //
    // INVARIANT this rests on: every Google service's connect threads its
    // COMPLETE `connect.scopes` set into beginAuth — never a delta. Without
    // include_granted_scopes, a consent grants exactly what it requests, so
    // a delta request (only the newly needed scope) would drop every
    // previously granted scope from that service's next credential. Also
    // recorded in packages/engine/docs/footguns.md.
    authorizeUrl.searchParams.set("access_type", "offline");
    authorizeUrl.searchParams.set("prompt", "select_account consent");
    authorizeUrl.searchParams.set("state", init.state);
    authorizeUrl.searchParams.set("code_challenge", init.codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    // Google's authorization server issues the code — nothing minted here.
    return { authorizeUrl: authorizeUrl.toString(), authCode: null };
  },

  exchangeCode(env, { query, state, redirectUri }) {
    return exchangeCodeForTokens({
      // The shared callback rejects a missing `code` before calling here.
      code: query.get("code")!,
      codeVerifier: state.code_verifier,
      redirectUri,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    });
  },

  // Google services refresh against Google's token endpoint.
  refresh: (old, env) =>
    refreshGmailToken(
      {
        refreshToken: old.refresh_token,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
      old.scopes,
    ),
};
