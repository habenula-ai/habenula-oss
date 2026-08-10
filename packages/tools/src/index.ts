// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Public surface of @habenula-ai/tools. The engine imports from this barrel;
// its integration tests may reach a service module via the package's
// `./services/*` subpath export. That subpath is the only deep entry point
// exposed. This barrel also re-exports the few cross-package types and OAuth
// utilities the engine needs alongside the tools surface: `StoredCredential`
// from @habenula-ai/credentials, the DDL-derived `OAuthStateData`, the
// `LLMToolInputSchema` type, and the PKCE/state helpers.

// Service catalog — the single source of truth.
export {
  lookupService,
  OAUTH_PROVIDERS,
  REFRESH_FNS,
  SERVICES,
} from "./services/catalog.js";
export { missingProviderEnv } from "./services/provider-env.js";
export type {
  AuthInit,
  OAuthProviderId,
  OAuthProviderStrategy,
  ProviderEnv,
  ServiceConnect,
  ServiceDefinition,
  ServiceRefreshFn,
} from "./services/types.js";

// Tool registry, derived from the catalog.
export { listTools, lookupTool, publishedDataSlots, toolName } from "./tools/registry.js";
export type { ExecuteContext, Tool, ToolExecutionResult, ToolSpend } from "./tools/types.js";

// Mock provider's in-process authorization server, served by the engine router.
export {
  handleMockAuthorize,
  MOCK_AUTHORIZE_PATH,
  mockProvider,
} from "./services/mock/provider.js";
export type {
  JsonResponder,
  MockServiceResolver,
  OAuthStateLoader,
} from "./services/mock/provider.js";

// Shared contracts and OAuth utilities the engine re-exports or consumes.
export type { StoredCredential } from "@habenula-ai/credentials";
export type { OAuthStateData } from "./oauth/types.js";
export type { LLMToolInputSchema } from "./llm/types.js";
export { generateCodeChallenge, generateCodeVerifier } from "./oauth/pkce.js";
export { parseOAuthState, randomHex } from "./oauth/state.js";
