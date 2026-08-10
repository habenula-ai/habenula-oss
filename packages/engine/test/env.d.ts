// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The vitest ambient wiring, deliberately under test/ so no devDependency
// reaches the published emit graph (tsconfig.build.json includes src/ only).
// The pool-workers types declare `env: Cloudflare.Env`, so the test tree keeps
// that platform-owned ambient name and points it at the engine's real surface.
import type { HabenulaEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merging alias: the ambient name must exist and equal HabenulaEnv
    interface Env extends HabenulaEnv {}
  }
}
