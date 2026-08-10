// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The process entry, and nothing else — the one module whose evaluation starts
 * the CLI. It exists so src/index.ts does not: test/cli.test.ts and
 * test/cli-doc-drift.test.ts import that module for `createProgram`, and a
 * module-scope `main()` there means importing the CLI runs the CLI. Under the
 * config-file layer that is not a stray banner but an exit — a developer whose
 * real ~/.habenula/config holds one refused line would lose the vitest worker
 * mid-import, on their machine only, with nothing naming the cause.
 *
 * esbuild bundles this file to dist/index.js (build.mjs), so the published
 * `bin` path is unchanged.
 */
import { main } from "./index";

main().then((code) => process.exit(code));
