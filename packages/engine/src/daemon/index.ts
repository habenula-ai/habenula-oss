#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Loopback daemon entry — the `npx @habenula-ai/engine` path
 * binds 127.0.0.1 and exposes no input that could
 * widen the bind. The shebang is load-bearing: this file is the package's
 * `bin` target, tsc copies a leading shebang into the emit but never adds
 * one, and without it the kernel runs the compiled output as a shell script.
 *
 * The persist fallback is one path on every platform (~/.habenula), so a bare
 * `npx` run from two directories reads one store instead of quietly creating
 * two. HABENULA_PERSIST_ROOT stays the override.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { startDaemon } from "./start.js";

await startDaemon("127.0.0.1", join(homedir(), ".habenula"));
