// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Container image entry: binds 0.0.0.0 because a
 * published port requires it. The network boundary is the Compose publish
 * scope (127.0.0.1:8787), not the process bind. The
 * engine's LOCALHOST_ONLY Host-header guard stays on as defense-in-depth and
 * passes the forwarded loopback requests.
 *
 * The persist fallback is /data, the image's own HABENULA_PERSIST_ROOT value,
 * so the container's store location is explicit at the entrypoint rather than
 * inherited from the environment alone. Behavior is unchanged.
 */
import { startDaemon } from "./start.js";

await startDaemon("0.0.0.0", "/data");
