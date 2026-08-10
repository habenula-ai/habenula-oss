// Bundle the CLI to a single Node-runnable entry.
//
// The published `habenula` bin can no longer be `src/bin.ts` under a Bun
// shebang — Node cannot execute TypeScript directly. esbuild bundles the whole
// source tree (plus the workspace-local @habenula-ai/audit, whose hash,
// verify-chain, and decision-closure code the CLI value-imports and which ships
// as .ts, so it MUST be transpiled; @habenula-ai/contracts is consumed
// type-only and is erased) into dist/index.js, stamped with a `#!/usr/bin/env node` shebang
// and marked executable. Node built-ins stay external. Dev still runs from
// source via `tsx src/bin.ts` (the `dev` recipe); this bundle is what `bin`
// points at and what npm publishing ships.
//
// The build also inlines the workspace engine's exact version as
// __HBN_ENGINE_VERSION__ (an esbuild define) for `habenula up`'s npx
// resolution. A define rather than a dependency, deliberately: declaring
// @habenula-ai/engine in dependencies would put a workerd binary into every
// CLI install, including the ones that only talk to a remote engine. A failed
// read fails this build, so the bundle never ships a placeholder.

import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const OUTFILE = "dist/index.js";

const enginePkgUrl = new URL("../engine/package.json", import.meta.url);
const engineVersion = JSON.parse(readFileSync(enginePkgUrl, "utf8")).version;
if (typeof engineVersion !== "string" || engineVersion.length === 0) {
  throw new Error(
    `build.mjs: no version in ${enginePkgUrl.pathname} — refusing to bundle without the exact engine pin`,
  );
}

await build({
  // src/bin.ts, not src/index.ts: the entry is the only module that calls
  // main(), so importing index.ts (as two test files do) never starts the CLI.
  // The outfile is unchanged, so `bin` still points at dist/index.js.
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: OUTFILE,
  define: { __HBN_ENGINE_VERSION__: JSON.stringify(engineVersion) },
  // Shebang, plus a createRequire shim: commander is CommonJS and calls
  // require() internally. In an ESM bundle esbuild's __require helper throws
  // unless a real `require` is in scope — createRequire(import.meta.url)
  // supplies one, and __require delegates to it. import.meta.url stays native
  // (the presence-helper path anchor depends on it).
  //
  // The license line is load-bearing, not decoration. This bundle inlines
  // @habenula-ai/audit, which is MIT rather than AGPL, and the MIT terms
  // require its notice to accompany copies of that code. esbuild only
  // preserves comments it recognises as legal (`//!`, or `@license` /
  // `@preserve`), so the plain `// Copyright` headers in the audit sources do
  // not survive bundling — the banner and the shipped NOTICE carry the notice
  // instead. Do not drop either without moving the notice somewhere else.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "//! Habenula CLI — AGPL-3.0-only. Bundles @habenula-ai/audit (MIT).",
      "//! Full notices: the NOTICE file shipped alongside this bundle.",
      'import { createRequire as __hbnCreateRequire } from "node:module";',
      "const require = __hbnCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Keep any legal comments esbuild does recognise, rather than minifying them
  // away, so a `//!`-headed source file keeps its notice in the bundle.
  legalComments: "eof",
  logLevel: "info",
});

// The shebang is inert unless the file is executable.
chmodSync(OUTFILE, 0o755);
