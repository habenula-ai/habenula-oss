//! SPDX-FileCopyrightText: 2026 Habenula, Inc.
//! SPDX-License-Identifier: MIT

// Narrow ambient declaration of the node:crypto surface the hash chain uses.
// The package types against @cloudflare/workers-types (no @types/node), so this
// shim declares exactly the synchronous createHash path hash.ts needs — see
// eslint.config.mjs for why node:crypto (not Web Crypto) is required here.
declare module "node:crypto" {
  interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  function createHash(algorithm: string): Hash;
}
