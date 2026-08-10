// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { OAuthProviderStrategy } from "../types.js";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

type FetchFn = typeof globalThis.fetch;

export interface GithubTokenExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

export interface GithubTokenRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

/**
 * The fields both token-endpoint legs parse. GitHub only issues `expires_in`
 * and a rotating `refresh_token` when the App has *Expire user authorization
 * tokens* enabled; `scope` is always the empty string for a GitHub App user
 * token (its reach lives in the App's fine-grained permissions), and
 * `refresh_token_expires_in` is read and discarded — StoredCredential has no
 * field for it, and refresh-token expiry is handled reactively when a
 * refresh fails.
 */
interface GithubTokenResponse {
  error?: string;
  error_description?: string;
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Guard the two expiring-token fields. With *Expire user authorization
 * tokens* enabled GitHub always returns both; their absence is the signature
 * of a misconfigured App whose token would never expire and could never be
 * refreshed — a shape we reject — so fail loud at the
 * exchange instead of storing a credential the refresher can't maintain.
 */
function assertRotatingToken<
  T extends { expires_in?: number; refresh_token?: string },
>(
  leg: string,
  fields: T,
): asserts fields is T & { expires_in: number; refresh_token: string } {
  if (typeof fields.expires_in !== "number" || fields.expires_in <= 0) {
    throw new Error(
      `GitHub ${leg} response missing expires_in — is "Expire user ` +
        `authorization tokens" enabled on the GitHub App?`,
    );
  }
  if (!fields.refresh_token) {
    throw new Error(
      `GitHub ${leg} response missing refresh_token — is "Expire user ` +
        `authorization tokens" enabled on the GitHub App?`,
    );
  }
}

/**
 * One POST to GitHub's token endpoint. `Accept: application/json` is
 * required — without it GitHub answers form-encoded. GitHub reports some
 * token failures (e.g. `bad_verification_code`) as HTTP 200 with an `error`
 * field in the body, so both the HTTP status and the error field are
 * checked — like Slack's `ok: false` handling.
 */
async function githubTokenCall(
  leg: string,
  body: URLSearchParams,
  fetchFn: FetchFn,
): Promise<GithubTokenResponse> {
  const res = await fetchFn(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${leg} failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as GithubTokenResponse;
  if (data.error) {
    throw new Error(
      `GitHub ${leg} failed: ${data.error}` +
        (data.error_description ? ` — ${data.error_description}` : ""),
    );
  }
  return data;
}

/** Map a validated token response onto the stored credential shape. */
function toStoredCredential(
  data: GithubTokenResponse & { expires_in: number; refresh_token: string },
): StoredCredential {
  return {
    access_token: data.access_token!,
    refresh_token: data.refresh_token,
    expiry_unix: Math.floor(Date.now() / 1000) + data.expires_in,
    // A GitHub App user token reports no classic scopes — its `scope` field
    // is always "" and its reach is the App's fine-grained permissions.
    scopes: [],
  };
}

/**
 * Exchange an authorization code for the expiring user token (`ghu_`) plus
 * its rotating refresh token (`ghr_`). GitHub verifies the PKCE
 * `code_verifier` against the `code_challenge` beginAuth sent — GitHub
 * supports S256 for GitHub Apps (like Google, unlike Slack).
 */
export async function exchangeGithubCode(
  params: GithubTokenExchangeParams,
): Promise<StoredCredential> {
  const data = await githubTokenCall(
    "token exchange",
    new URLSearchParams({
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    }),
    params.fetchFn ?? globalThis.fetch,
  );

  if (!data.access_token) {
    throw new Error("GitHub token response missing access_token");
  }
  assertRotatingToken("token exchange", data);
  return toStoredCredential(data);
}

/**
 * Refresh the expiring user token. GitHub rotates the refresh token on every
 * refresh and invalidates the prior one, so the credential MUST carry the
 * newly issued `ghr_` for the refresher's write-back to persist — Slack's
 * rule, not Google's. Falling back to the spent token
 * (`data.refresh_token ?? params.refreshToken`) would brick the connection
 * on the next refresh.
 */
export async function refreshGithubToken(
  params: GithubTokenRefreshParams,
): Promise<StoredCredential> {
  const data = await githubTokenCall(
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
    throw new Error("GitHub refresh response missing access_token");
  }
  assertRotatingToken("token refresh", data);
  return toStoredCredential(data);
}

/**
 * The github provider strategy: a GitHub App's user-to-server web flow with
 * PKCE. Repository access is chosen at App install, so no
 * scope parameter is sent anywhere in the flow.
 */
export const githubProvider: OAuthProviderStrategy = {
  callbackPath: "/callback/github",
  requiredEnv: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],

  beginAuth(env, init) {
    const authorizeUrl = new URL(GITHUB_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", init.redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", init.state);
    // PKCE rides the authorize URL as Google's does (S256, supported for
    // GitHub Apps since July 2025); the exchange sends the verifier. No
    // `scope` param: a GitHub App's user flow requests none — the App
    // install's permissions and repository selection bound the token.
    authorizeUrl.searchParams.set("code_challenge", init.codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    // GitHub's authorization server issues the code — nothing minted here.
    return { authorizeUrl: authorizeUrl.toString(), authCode: null };
  },

  exchangeCode(env, { query, state, redirectUri }) {
    // The `scopes` arm the shared callback passes is unused: the stored
    // credential's scopes are always empty for a GitHub App user token.
    return exchangeGithubCode({
      // The shared callback rejects a missing `code` before calling here.
      code: query.get("code")!,
      codeVerifier: state.code_verifier,
      redirectUri,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    });
  },

  // Refresh against the same token endpoint with grant_type=refresh_token.
  refresh: (old, env) =>
    refreshGithubToken({
      refreshToken: old.refresh_token,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
};
