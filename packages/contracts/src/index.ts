// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Barrel: every wire schema and its inferred type. One schema per /api/*
// message is the single definition every producer and consumer binds to.
export * from "./requests/index.js";
export * from "./responses/index.js";
export { ErrorResponse } from "./error.js";
