#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
//
// The engine publishes its own wire contract at `GET /api/dev/contracts`, from
// the hand-maintained table in packages/engine/src/dev-model/contract-descriptors.ts.
// That table sits next to the routing in packages/engine/src/index.ts and is
// kept in step with it by hand, which is exactly the arrangement that drifts:
// four dispatched routes once went unpublished for as long as nothing compared
// the two lists.
//
// So this compares them, in both directions:
//
//   a dispatched route with no row  — uncovered surface that reads as covered.
//     Anything generating from the table (a client, a conformance check, the
//     contract fuzzer) skips the route and reports full coverage of a surface it
//     did not cover.
//   a row naming a route not dispatched — a schema a client can generate
//     against and never successfully call.
//
// Both lists are read from source rather than from a running engine, because
// probing cannot enumerate: an absent route and a route the table forgot answer
// through the same handler set, and telling them apart from outside needs the
// candidate list this check exists to avoid maintaining.
//
// Reading source means a pattern this file cannot parse would go quiet, so the
// third failure is "I could not read this" — an /api/ path literal in the
// routing file that matched no dispatch, or a table row that matched no row
// pattern. A guard that cannot see something says so rather than passing.

const { readFileSync } = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const ENGINE_INDEX = path.join(REPO_ROOT, "packages/engine/src/index.ts");
const DESCRIPTORS = path.join(
  REPO_ROOT,
  "packages/engine/src/dev-model/contract-descriptors.ts",
);

/**
 * The `/api/*` routes the engine dispatches, read out of the routing source.
 *
 * Every dispatch line in the fetch handler is one
 * `url.pathname === "…" && request.method === "…"` pair. A line that stopped
 * matching that shape shows up in `unreadable` instead of vanishing.
 */
function dispatchedApiRoutes(source = readFileSync(ENGINE_INDEX, "utf8")) {
  const pattern =
    /url\.pathname === "(\/api\/[^"]*)"\s*&&\s*request\.method === "(GET|POST|PUT|DELETE|PATCH)"/g;
  const routes = [];
  for (const match of source.matchAll(pattern)) {
    routes.push({ route: match[1], method: match[2] });
  }
  // Every `"/api/…"` string literal in the file, so a dispatch written another
  // way is visible as a discrepancy rather than silence. `"/api/"` itself is the
  // 404 fall-through prefix, not a route.
  const literals = new Set(
    [...source.matchAll(/"(\/api\/[^"]*)"/g)]
      .map((m) => m[1])
      .filter((p) => p !== "/api/"),
  );
  const seen = new Set(routes.map((r) => r.route));
  const unreadable = [...literals].filter((p) => !seen.has(p)).sort();
  return { routes, unreadable };
}

/**
 * The published table, read out of the descriptor source.
 *
 * `unreadable` counts rows the row pattern did not match. The table is one
 * object literal per line by convention, so a row reformatted across lines would
 * otherwise drop out of the comparison and read as "no drift".
 */
function publishedRoutesFromSource(source = readFileSync(DESCRIPTORS, "utf8")) {
  const table = source.slice(
    source.indexOf("const ROUTE_CONTRACTS"),
    source.indexOf("\n];", source.indexOf("const ROUTE_CONTRACTS")),
  );
  const pattern = /\{\s*route: "([^"]+)",\s*method: "(GET|POST|PUT|DELETE|PATCH)"/g;
  const routes = [];
  for (const match of table.matchAll(pattern)) {
    routes.push({ route: match[1], method: match[2] });
  }
  const rowStarts = (table.match(/\{\s*route:/g) || []).length;
  return { routes, unreadable: rowStarts - routes.length };
}

/**
 * Which dispatched routes the table omits, and which rows name a route the
 * engine no longer dispatches.
 *
 * `/connect/{service}` and the two inbound MCP surfaces are out of scope by
 * construction: the first is not under `/api/`, and `/mcp` and `/internal/mcp`
 * speak MCP rather than the Zod wire contract, which is why the table excludes
 * them.
 */
function descriptorDrift(published, dispatched) {
  const publishedKeys = new Set(
    published
      .filter((r) => r.route.startsWith("/api/"))
      .map((r) => `${r.method} ${r.route}`),
  );
  const dispatchedKeys = new Set(dispatched.map((r) => `${r.method} ${r.route}`));
  return {
    undocumented: [...dispatchedKeys].filter((k) => !publishedKeys.has(k)).sort(),
    stale: [...publishedKeys].filter((k) => !dispatchedKeys.has(k)).sort(),
  };
}

function main() {
  const dispatched = dispatchedApiRoutes();
  const published = publishedRoutesFromSource();
  const drift = descriptorDrift(published.routes, dispatched.routes);
  const failures = [];

  if (drift.undocumented.length > 0) {
    failures.push(
      `${drift.undocumented.length} dispatched route(s) publish no descriptor row:\n` +
        drift.undocumented.map((k) => `    ${k}`).join("\n"),
    );
  }
  if (drift.stale.length > 0) {
    failures.push(
      `${drift.stale.length} descriptor row(s) name a route the engine does not dispatch:\n` +
        drift.stale.map((k) => `    ${k}`).join("\n"),
    );
  }
  if (dispatched.unreadable.length > 0) {
    failures.push(
      `${dispatched.unreadable.length} /api/ path literal(s) in src/index.ts that this check could not read as a dispatch:\n` +
        dispatched.unreadable.map((p) => `    ${p}`).join("\n"),
    );
  }
  if (published.unreadable > 0) {
    failures.push(
      `${published.unreadable} descriptor row(s) this check could not read — keep one row per line as \`{ route: "…", method: "…", … }\``,
    );
  }

  if (failures.length > 0) {
    console.error(
      "The published route table and the engine's routing have drifted.\n" +
        "Both live next to each other on purpose: packages/engine/src/index.ts\n" +
        "dispatches, packages/engine/src/dev-model/contract-descriptors.ts publishes.\n",
    );
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log(
    `Contract descriptors: ${dispatched.routes.length} dispatched /api/* route(s), all published.`,
  );
}

module.exports = { dispatchedApiRoutes, publishedRoutesFromSource, descriptorDrift };

if (require.main === module) main();
