// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import { generateCodeChallenge } from "../../oauth/pkce.js";
import { parseOAuthState, randomHex } from "../../oauth/state.js";
import type { OAuthStateData } from "../../oauth/types.js";
import type { OAuthProviderStrategy } from "../types.js";

/**
 * The mock's in-process authorization-server path. Single source of truth: the
 * router registers this route, and `beginAuth` points the authorize URL at it.
 * Mock-internal — the real strategy interface carries only `callbackPath`,
 * because a real provider's authorize server lives off-origin.
 */
export const MOCK_AUTHORIZE_PATH = "/oauth/mock/authorize";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateMockAuthCode(): string {
  return `mock_authcode_${randomHex(16)}`;
}

/**
 * Mint a mock credential. The scopes come from the connecting service's
 * declared `connect.scopes` (threaded through `exchangeCode`), so the catalog
 * is the single source — `scopes` is required, with no default copy to drift
 * from it.
 */
export function generateMockTokens(scopes: string[]): StoredCredential {
  return {
    access_token: `mock_access_${randomHex(16)}`,
    refresh_token: `mock_refresh_${randomHex(16)}`,
    expiry_unix: Math.floor(Date.now() / 1000) + 3600,
    scopes,
  };
}

/**
 * Refresh a mock credential entirely in-process — the mock service's analogue
 * of Google's token endpoint. Mints a fresh mock_access_* token and preserves
 * the existing refresh token and scopes. Makes no network call, so a mock_*
 * token is never sent to Google's real token endpoint. This lets the mock
 * exercise the same resolve-and-refresh path as a real service.
 */
export function refreshMockToken(old: StoredCredential): StoredCredential {
  return {
    access_token: `mock_access_${randomHex(16)}`,
    refresh_token: old.refresh_token,
    expiry_unix: Math.floor(Date.now() / 1000) + 3600,
    scopes: old.scopes,
  };
}

export function renderConsentPage(params: {
  service: string;
  scopes: string[];
  callbackUrl: string;
  state: string;
  code: string;
}): string {
  const approveUrl = `${params.callbackUrl}?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`;
  // The deny link echoes `state` exactly as Google does on a denial — that
  // echo is what lets the callback's error branch find and stamp the flow, so
  // the deny path is testable in-runtime.
  const denyUrl = `${params.callbackUrl}?error=access_denied&state=${encodeURIComponent(params.state)}`;
  // The declared scopes drive the page; a second mock-provider service renders
  // its own name and scopes rather than hardcoded email copy.
  const scopeList = params.scopes
    .map((s) => `<div class="scope">${escapeHtml(s)}</div>`)
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Habenula Mock Authorization</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4em; }
    .service { font-weight: bold; }
    .scope { background: #f0f0f0; padding: 8px 12px; border-radius: 6px; margin: 16px 0; }
    .approve { display: inline-block; background: #2563eb; color: #fff; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 16px; }
    .approve:hover { background: #1d4ed8; }
    .deny { display: inline-block; color: #666; padding: 12px 24px; text-decoration: none; font-weight: 600; margin-top: 16px; margin-left: 8px; }
    .deny:hover { color: #1a1a1a; }
    .note { color: #666; font-size: 0.85em; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Authorize Habenula</h1>
  <p>Habenula wants to access your <span class="service">${escapeHtml(params.service)}</span> account.</p>
  ${scopeList}
  <a class="approve" href="${escapeHtml(approveUrl)}">Approve</a>
  <a class="deny" href="${escapeHtml(denyUrl)}">Deny</a>
  <p class="note">This is a mock authorization for onboarding. No real account is connected.</p>
</body>
</html>`;
}

/**
 * The mock provider strategy. The mock simulates the authorization server
 * Google hosts off-origin, so its authorize URL is the in-process consent
 * page (`/oauth/mock/authorize`) and its code exchange is local — a mock_*
 * token never reaches a real endpoint. The strategy surface stays symmetric
 * with google's; the simulated-server pieces (consent page, authorize
 * handler) are mock-internal, not part of the strategy interface.
 */
export const mockProvider: OAuthProviderStrategy = {
  callbackPath: "/callback/mock",
  // No registered client to configure: the mock's authorization server is this
  // Worker and its tokens are minted in process, so onboarding against it works
  // on a deployment that has no provider credentials at all.
  requiredEnv: [],

  beginAuth(_env, init) {
    // The consent page is served by this Worker, so resolve it against the
    // same origin the callback resolves against. Only `state` rides the URL —
    // the PKCE challenge travels via DO state (stored by the connect entry,
    // verified in `exchangeCode`), so the mock authorize URL never carries a
    // `code_challenge` the consent handler would ignore.
    const authorizeUrl = new URL(MOCK_AUTHORIZE_PATH, init.redirectUri);
    authorizeUrl.searchParams.set("state", init.state);
    // Mint the code the consent page's approve link will echo back — the
    // simulated authorization server's half of the code exchange.
    return {
      authorizeUrl: authorizeUrl.toString(),
      authCode: generateMockAuthCode(),
    };
  },

  async exchangeCode(_env, { query, state, scopes }) {
    // `redirectUri` is unused: the mock's exchange is in-process and sends no
    // redirect_uri, so only the google path exercises that thread.
    const code = query.get("code");
    if (!state.auth_code || state.auth_code !== code) {
      throw new Error("Invalid authorization code");
    }
    // PKCE verification: S256(code_verifier) must match the stored challenge
    const computedChallenge = await generateCodeChallenge(state.code_verifier);
    if (computedChallenge !== state.code_challenge) {
      throw new Error("PKCE verification failed");
    }
    // Mint with the connecting service's declared scopes (from the catalog).
    return generateMockTokens(scopes);
  },

  // The mock refreshes in-process — a mock_* token never reaches Google.
  refresh: (old) => Promise.resolve(refreshMockToken(old)),
};

/**
 * Resolve a state's service to the scopes its consent page should show, or
 * null if the service is not one this mock authorizer serves. Supplied by the
 * router (`index.ts`) so the catalog lookup stays there — the mock module does
 * not import the assembler and so avoids the provider → catalog cycle.
 */
export type MockServiceResolver = (
  service: string,
) => { scopes: string[] } | null;

/**
 * Load a user's stored OAuth state by its random key, or null if absent or
 * expired. Supplied by the router (`index.ts`), which owns the DO stub — the
 * mock module reads the state through this callback so it touches no
 * Cloudflare binding, exactly as `MockServiceResolver` keeps the catalog
 * lookup out of it.
 */
export type OAuthStateLoader = (
  userId: string,
  stateKey: string,
) => Promise<OAuthStateData | null>;

/**
 * Build a CORS'd JSON error response. Injected by the router (`index.ts`) so
 * the CORS policy and the `json` helper stay at the engine's composition root —
 * this leaf produces the mock authorizer's error bodies without owning the
 * engine's transport policy (its 20 real routes define it, not this handler's
 * three 400s).
 */
export type JsonResponder = (data: unknown, status?: number) => Response;

/**
 * The mock's simulated authorization server: the consent page Google hosts
 * off-origin, served in-process at GET /oauth/mock/authorize. Mock-internal —
 * not part of the strategy interface, exactly as Google's consent page is not
 * part of its. Loads (does not consume) the OAuth state so the approve link
 * can echo the minted auth_code back to the callback.
 */
export async function handleMockAuthorize(
  request: Request,
  resolveMockService: MockServiceResolver,
  loadOAuthState: OAuthStateLoader,
  json: JsonResponder,
): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseOAuthState(url.searchParams.get("state"));
  if (!parsed) {
    return json({ error: "Missing or invalid state parameter" }, 400);
  }
  const { userId, randomPart } = parsed;
  const fullState = url.searchParams.get("state")!;

  const stateData = await loadOAuthState(userId, randomPart);
  if (!stateData) {
    return json({ error: "Invalid or expired OAuth state" }, 400);
  }

  // Only render for a state minted by a service this authorizer serves. A
  // state for another provider (e.g. gmail, whose auth_code is null) has no
  // business here: rendering it would produce a bogus approve link that, once
  // clicked, consumes and strands that pending connect. The callback makes the
  // symmetric check; the per-route handlers used to make both structural.
  const resolved = resolveMockService(stateData.service);
  if (!resolved || !stateData.auth_code) {
    return json({ error: "OAuth state does not match this authorizer" }, 400);
  }

  const callbackUrl = new URL(mockProvider.callbackPath, request.url).toString();
  const html = renderConsentPage({
    // Renders the raw internal id (e.g. `mock_email`) until a later change adds a
    // display-label field to the catalog; the friendly label lands there.
    service: stateData.service,
    scopes: resolved.scopes,
    callbackUrl,
    state: fullState,
    code: stateData.auth_code,
  });

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
