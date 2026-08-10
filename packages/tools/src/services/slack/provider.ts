// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { OAuthProviderStrategy } from "../types.js";

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

type FetchFn = typeof globalThis.fetch;

export interface SlackTokenExchangeParams {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

export interface SlackTokenRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
}

/**
 * The user-token fields of Slack's code-exchange response. With token
 * rotation enabled and only `user_scope` requested, every field of the user
 * token lives here — the top-level `access_token` belongs to the bot token
 * we do not request, and Slack returns it as an empty string.
 */
interface SlackAuthedUser {
  id?: string;
  scope?: string;
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Guard the two rotation-dependent fields. With rotation enabled Slack always
 * returns both; their absence means rotation is off and the token would never
 * expire — the standing liability we reject — so fail loud
 * at the exchange instead of storing a credential the refresher can't manage.
 */
function assertRotatingToken<
  T extends { expires_in?: number; refresh_token?: string },
>(
  leg: string,
  fields: T,
): asserts fields is T & { expires_in: number; refresh_token: string } {
  if (typeof fields.expires_in !== "number" || fields.expires_in <= 0) {
    throw new Error(
      `Slack ${leg} response missing expires_in — is token rotation enabled?`,
    );
  }
  if (!fields.refresh_token) {
    throw new Error(
      `Slack ${leg} response missing refresh_token — is token rotation enabled?`,
    );
  }
}

/**
 * Exchange an authorization code for the rotating user token.
 *
 * Reads EXCLUSIVELY from `authed_user`: on the exchange leg the user token is
 * nested there, while the top-level `access_token` slot belongs to the bot
 * token and is `""` when no bot scope is requested. Reading the top level is
 * the classic Slack-integration bug — it stores an
 * empty credential that fails only at the first API call. Note the refresh
 * leg below parses a DIFFERENT shape (flat, no `authed_user` wrapper); the
 * two mappings are deliberately written and tested separately.
 */
export async function exchangeSlackCode(
  params: SlackTokenExchangeParams,
): Promise<StoredCredential> {
  const doFetch = params.fetchFn ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    // No code_verifier: Slack authenticates the exchange with client_secret,
    // and beginAuth sends no code_challenge (see slackProvider.beginAuth).
  });

  const res = await doFetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  // Slack reports failures as HTTP 200 with { ok: false, error } — check the
  // ok field, not just the HTTP status.
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    authed_user?: SlackAuthedUser;
  };

  if (!data.ok) {
    throw new Error(
      `Slack token exchange failed: ${data.error ?? "unknown_error"}`,
    );
  }

  const user = data.authed_user;
  if (!user?.access_token) {
    throw new Error(
      "Slack token response missing authed_user.access_token — " +
        "was the app authorized with user_scope?",
    );
  }
  assertRotatingToken("token exchange", user);

  return {
    access_token: user.access_token,
    refresh_token: user.refresh_token,
    expiry_unix: Math.floor(Date.now() / 1000) + user.expires_in,
    // Slack reports the actually-granted scopes comma-separated (vs Google's
    // space-separated).
    scopes: user.scope ? user.scope.split(",") : [],
  };
}

/**
 * Refresh the rotating user token.
 *
 * Reads the refreshed token FLAT at the top level — `{ ok, access_token,
 * token_type: "user", scope, expires_in, refresh_token }`, with no
 * `authed_user` wrapper. Copying the exchange leg's nested mapping here reads
 * a field that does not exist and yields an undefined access token.
 * Slack refresh tokens are single-use: each refresh
 * invalidates the old one and returns a new one, which MUST ride back in the
 * returned credential so the refresher's write-back persists it.
 */
export async function refreshSlackToken(
  params: SlackTokenRefreshParams,
  /** Original scopes to preserve if Slack omits scope in the refresh response. */
  originalScopes?: string[],
): Promise<StoredCredential> {
  const doFetch = params.fetchFn ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const res = await doFetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!data.ok) {
    throw new Error(
      `Slack token refresh failed: ${data.error ?? "unknown_error"}`,
    );
  }

  if (!data.access_token) {
    throw new Error("Slack refresh response missing access_token");
  }
  assertRotatingToken("refresh", data);

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_unix: Math.floor(Date.now() / 1000) + data.expires_in,
    scopes: data.scope ? data.scope.split(",") : (originalScopes ?? []),
  };
}

/**
 * The slack provider strategy: Slack OAuth v2 with token rotation, storing
 * the per-user token (never the workspace bot token).
 */
export const slackProvider: OAuthProviderStrategy = {
  callbackPath: "/callback/slack",
  requiredEnv: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],

  beginAuth(env, init) {
    const authorizeUrl = new URL(SLACK_AUTHORIZE_URL);
    authorizeUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", init.redirectUri);
    // User scopes only — the bot `scope` parameter is deliberately absent
    // (no bot identity is requested). Slack's scope lists are
    // comma-separated.
    authorizeUrl.searchParams.set("user_scope", init.scopes.join(","));
    authorizeUrl.searchParams.set("state", init.state);
    // Deliberately NO code_challenge (unlike googleProvider): Slack
    // authenticates the exchange with client_secret, and a recorded challenge
    // could force a code_verifier this flow does not send — a hard
    // invalid_grant. The verifier the connect entry
    // generated still travels in DO state; Slack just ignores it.
    // Slack's authorization server issues the code — nothing minted here.
    return { authorizeUrl: authorizeUrl.toString(), authCode: null };
  },

  exchangeCode(env, { query, redirectUri }) {
    // The `scopes` arm the shared callback passes is unused: Slack reports
    // the actually-granted scopes in authed_user.scope, which the exchange
    // reads instead — exactly as Google reads its token response.
    return exchangeSlackCode({
      // The shared callback rejects a missing `code` before calling here.
      code: query.get("code")!,
      redirectUri,
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
    });
  },

  // Slack services refresh against oauth.v2.access with grant_type=refresh_token.
  refresh: (old, env) =>
    refreshSlackToken(
      {
        refreshToken: old.refresh_token,
        clientId: env.SLACK_CLIENT_ID,
        clientSecret: env.SLACK_CLIENT_SECRET,
      },
      old.scopes,
    ),
};
