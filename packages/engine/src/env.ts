// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The engine's environment surface, as an ordinary exported interface.
 *
 * Deliberately NOT an ambient `Cloudflare.Env` augmentation: that name is a
 * platform-owned global that every project extends by redeclaration, and
 * TypeScript merges declarations globally — an embedder's own `Cloudflare.Env`
 * would silently gain these required fields and their Worker would stop
 * typechecking. An exported interface parameterizes instead of polluting,
 * which is the shape the platform's own libraries take
 * (`WorkerEntrypoint<Env = Cloudflare.Env>`). The vitest ambient wiring lives
 * in test/env.d.ts, outside the published emit graph.
 */
export interface HabenulaEnv {
  USER_AGENT: DurableObjectNamespace<import("./agent/user-agent").UserAgent>;
  CREDENTIAL_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;
  /**
   * LLM provider seam. Selection is deployment-static;
   * defaults preserve the pre-seam behavior exactly (`anthropic`,
   * `claude-sonnet-4-6`, `ANTHROPIC_API_KEY`).
   */
  /** "anthropic" (default) or "openai-compatible". */
  LLM_PROVIDER?: string;
  /** Model id; required when LLM_PROVIDER=openai-compatible. */
  LLM_MODEL?: string;
  /** Base URL for openai-compatible (e.g. http://localhost:8080/v1). */
  LLM_ENDPOINT?: string;
  /** Credential for the selected provider. For anthropic, ANTHROPIC_API_KEY takes precedence (a stale LLM_API_KEY never reaches Anthropic). Optional for keyless local runtimes. */
  LLM_API_KEY?: string;
  /** Loopback Host/Origin guard. Any value but "false" enforces. */
  LOCALHOST_ONLY?: string;
  /**
   * Shared-secret caller token for the `/internal/mcp` trusted drive surface.
   * A SECRET — synced via the deploy
   * secret path, never `wrangler.toml`. It authenticates the caller; it is
   * not an OAuth credential and never enters the model context (Hard
   * Invariant #1). Unset fails closed: the route 401s every request, so no
   * trusted caller exists until the secret is provisioned.
   */
  INTERNAL_MCP_TOKEN?: string;
  /** Dev visual model gate. Fail-closed: only exactly "true" enables. */
  VISUAL_MODEL?: string;
  /**
   * Debug-mode gate for `POST /api/tools/execute`. Fail-closed: only exactly
   * "true" enables; anything else (unset included) makes the route answer
   * 404, indistinguishable from absent. The route drives a tool call with no
   * conversation behind it — a debugging surface, never an intended feature
   * — so it ships off and only the test harnesses turn it on.
   */
  DEBUG_MODE?: string;
  /**
   * Stable public origin for OAuth redirect URIs. When set, the callback URL
   * is built from this instead of the incoming request URL — decoupling the
   * redirect's scheme/host from how the request arrives (needed behind a
   * tunnel; see docs/connect/slack.md). Only the origin is used. Unset
   * in the hosted deploy, where request.url already carries the real origin.
   *
   * The per-provider forms below take precedence over this global one for
   * their provider, so an override can be scoped to a single provider (e.g.
   * tunnel Slack while leaving Google on http://localhost). Resolution order:
   * OAUTH_REDIRECT_BASE_URL_<PROVIDER> → OAUTH_REDIRECT_BASE_URL → request URL.
   */
  OAUTH_REDIRECT_BASE_URL?: string;
  OAUTH_REDIRECT_BASE_URL_GOOGLE?: string;
  OAUTH_REDIRECT_BASE_URL_SLACK?: string;
  OAUTH_REDIRECT_BASE_URL_MICROSOFT?: string;
  OAUTH_REDIRECT_BASE_URL_GITHUB?: string;
}
