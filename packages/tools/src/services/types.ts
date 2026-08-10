// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "@habenula-ai/credentials";
import type { OAuthStateData } from "../oauth/types.js";
import type { Tool } from "../tools/types.js";

/**
 * Interface types for the service catalog and the OAuth provider strategies.
 * Extracted from catalog.ts so provider modules can import them without
 * cycling through the assembler (provider → catalog → provider).
 */

/** The OAuth providers with a registered strategy in `OAUTH_PROVIDERS`. */
export type OAuthProviderId = "google" | "mock" | "slack" | "github" | "microsoft";

/**
 * The environment slice provider strategies read: per-provider OAuth client
 * credentials. Declared here rather than referencing the engine's ambient
 * `Cloudflare.Env` so this package typechecks standalone; the engine's env
 * satisfies it structurally and is passed at call time.
 */
export interface ProviderEnv {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
}

/**
 * Refresh a service's stored credential. Declared env-agnostic in the
 * strategy and bound to a concrete env at the DO dispatch site, so the
 * catalog stays a static description with no env captured in it.
 */
export type ServiceRefreshFn = (
  old: StoredCredential,
  env: ProviderEnv,
) => Promise<StoredCredential>;

/**
 * How a service is connected. `oauth` services name their provider and
 * contribute only their own scopes — the OAuth machinery lives on the
 * provider's strategy. `none` services connect without a credential (no
 * entries yet — reserved for sandboxed filesystem, search).
 */
export type ServiceConnect =
  | { type: "oauth"; provider: OAuthProviderId; scopes: string[] }
  | { type: "none" };

/**
 * One connectable service: its concrete name, its connect data, and the tools
 * it exposes. The single source of truth that the tool registry
 * (`listTools`/`lookupTool`), the refresh map (`REFRESH_FNS`), and the
 * connect entry (`POST /connect/{service}`) all derive from — replacing the
 * three lists that used to drift. A consistency test asserts every `oauth`
 * service names a registered provider and every tool's `service` is declared
 * in the catalog.
 */
export interface ServiceDefinition {
  service: string;
  connect: ServiceConnect;
  tools: Tool[];
}

/** What the connect entry hands a provider's begin-flow. */
export interface AuthInit {
  scopes: string[];
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

/**
 * The OAuth machinery a provider's services share. One strategy per provider
 * in `OAUTH_PROVIDERS`; a service's `connect` arm names its provider and the
 * connect entry and the shared callback resolve everything else here. Every
 * method takes `env` as a call-time argument — a strategy is a static
 * description holding no secret and no captured environment.
 */
export interface OAuthProviderStrategy {
  /**
   * The provider's single registered redirect URI path. The connect entry
   * resolves it against the request origin for `beginAuth`, and the router
   * matches callback requests against it.
   */
  callbackPath: string;
  /**
   * The `ProviderEnv` keys this provider's OAuth client cannot run without —
   * its client id and client secret, or an empty list for a provider that
   * needs no registered client (the mock). Declared here so the connect entry
   * can refuse an unconfigured provider before it mints anything, and so a new
   * provider states its own requirement instead of the check growing a
   * per-provider branch.
   *
   * The declaration is load-bearing because `ProviderEnv` types every slot as
   * a required `string`, which is a promise the environment does not keep: an
   * unset binding arrives as `undefined`, `URLSearchParams.set` coerces it to
   * the literal `"undefined"`, and the provider emits a well-formed authorize
   * URL that the authorization server rejects as an opaque `invalid_client`.
   * The secret belongs on the list even though `beginAuth` does not read it —
   * an id-only deployment would pass the begin-flow and then fail just as
   * opaquely at the token exchange.
   */
  requiredEnv: readonly (keyof ProviderEnv)[];
  /**
   * Begin the authorization flow: return the URL the user's browser opens.
   * Modeled as a begin-flow, not a redirect target, because the mock also
   * mints the `auth_code` its in-process consent page will echo back —
   * returned here so the connect entry can store it in the OAuth state.
   * Providers whose authorization server issues the code itself (google)
   * return `authCode: null`.
   */
  beginAuth(
    env: ProviderEnv,
    init: AuthInit,
  ): { authorizeUrl: string; authCode: string | null };
  /**
   * Complete the flow at the callback: validate the returned code against the
   * consumed state and produce the credential. `redirectUri` is the same
   * value `beginAuth` received — Google's token exchange re-sends it and
   * rejects a mismatch (RFC 6749 §4.1.3). `scopes` are the connecting
   * service's declared `connect.scopes`, resolved from the catalog by the
   * shared callback — the mock mints its credential with them so the catalog
   * stays the single source; Google reads its granted scopes from the token
   * response instead. Throws on validation or exchange failure; the shared
   * callback handler maps the throw to a 400.
   */
  exchangeCode(
    env: ProviderEnv,
    params: {
      query: URLSearchParams;
      state: OAuthStateData;
      redirectUri: string;
      scopes: string[];
    },
  ): Promise<StoredCredential>;
  /** Refresh an expired credential. Resolved through `REFRESH_FNS` at dispatch. */
  refresh: ServiceRefreshFn;
}
