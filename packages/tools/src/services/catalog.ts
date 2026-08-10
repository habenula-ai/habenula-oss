// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { github } from "./github/github.js";
import { githubProvider } from "./github/provider.js";
import { habenula } from "./habenula/habenula.js";
import { googleCalendar } from "./google/calendar.js";
import { gmail } from "./google/gmail.js";
import { googleProvider } from "./google/provider.js";
import { microsoftProvider } from "./microsoft/provider.js";
import { outlookMail } from "./microsoft/outlook-mail.js";
import { mockDelivery } from "./mock/mock-delivery.js";
import { mockEmail } from "./mock/mock-email.js";
import { mockProvider } from "./mock/provider.js";
import { slack } from "./slack/slack.js";
import { slackProvider } from "./slack/provider.js";
import type {
  OAuthProviderId,
  OAuthProviderStrategy,
  ServiceDefinition,
  ServiceRefreshFn,
} from "./types.js";

export type {
  AuthInit,
  OAuthProviderId,
  OAuthProviderStrategy,
  ServiceConnect,
  ServiceDefinition,
  ServiceRefreshFn,
} from "./types.js";

/**
 * The service catalog. Keyed by the internal underscore name — the same name
 * the `connected_services` row, every tool's `service`, and the
 * `${service}_${verb}` tool name use. Seven OAuth services plus `habenula`, the
 * control-plane service (`connect: { type: "none" }` — no OAuth, no
 * credential; its tools operate the local DO and are dispatch-special-cased).
 * This module is a thin assembler: each service is defined in its provider's
 * directory and imported here.
 */
export const SERVICES: ServiceDefinition[] = [
  gmail,
  mockEmail,
  mockDelivery,
  slack,
  googleCalendar,
  github,
  outlookMail,
  habenula,
];

/**
 * provider → OAuth strategy. Owns the OAuth machinery a provider's services
 * share (begin-flow, code exchange, refresh, callback path); a service's
 * `connect` arm names its provider and the connect entry and shared callback
 * resolve everything else here. A consistency test asserts every OAuth
 * service's provider is a registered key.
 */
export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderStrategy> = {
  google: googleProvider,
  mock: mockProvider,
  slack: slackProvider,
  github: githubProvider,
  microsoft: microsoftProvider,
};

/** Resolve an internal service name to its catalog entry, or null. */
export function lookupService(name: string): ServiceDefinition | null {
  return SERVICES.find((s) => s.service === name) ?? null;
}

/**
 * service → refresh function, derived once at module load by resolving each
 * OAuth entry through its provider strategy. Entries stay env-agnostic; `env`
 * is bound at the dispatch site (`resolveServiceCredential` in
 * agent/user-agent.ts), so no per-DO-instance closure is needed. A
 * consistency test asserts every OAuth service's tools resolve a refresh
 * entry and every `none` service's tools resolve none.
 */
export const REFRESH_FNS: Record<string, ServiceRefreshFn> = Object.fromEntries(
  // The tuple return annotation keeps fromEntries on its typed overload — a
  // malformed entry (swapped or dropped element) would otherwise fall through
  // to the untyped overload and satisfy the Record annotation silently.
  SERVICES.flatMap((s): [string, ServiceRefreshFn][] =>
    s.connect.type === "oauth"
      ? [[s.service, OAUTH_PROVIDERS[s.connect.provider].refresh]]
      : [],
  ),
);
