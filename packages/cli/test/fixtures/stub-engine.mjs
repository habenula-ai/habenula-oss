// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// Zero-dependency stand-in for the habenula-engine daemon, resolved through
// HABENULA_ENGINE_CMD by the command-level tests. It binds 127.0.0.1 on
// HABENULA_PORT, serves /api/health in the real shape, honours
// INTERNAL_MCP_TOKEN on /internal/mcp, and takes its failure modes from its
// own environment:
//
//   STUB_MODE=refuse            print STUB_REFUSAL_LINE to stderr, exit 1 —
//                               the daemon's one-line pre-flight contract
//   STUB_MODE=exit-after-serve  bind and serve, then exit STUB_EXIT_CODE
//                               after STUB_EXIT_AFTER_MS
//   STUB_MODE=bind-never-answer accept connections and never respond
//   STUB_MODE=never-bind        stay alive without ever binding
//   (default)                   bind and serve
//
// VISUAL_MODEL=true additionally serves GET /api/dev/contracts, mirroring the
// engine's fail-closed gate on the dev observability surface.
//
// STUB_ENV_FILE, when set, receives a JSON dump of this process's environment
// at startup, so a test can assert exactly what reached the child.
//
// Written as .mjs so it stays out of the CLI's typecheck program and can use
// node:http without a shim entry.

import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { writeFileSync } from "node:fs";

const port = Number(process.env.HABENULA_PORT ?? "8787");
const mode = process.env.STUB_MODE ?? "serve";
const token = process.env.INTERNAL_MCP_TOKEN;
// The engine's own gate, restated: read at start, fail-closed, and exactly
// "true" — so a stub started without it 404s /api/dev/* the way the real
// engine does, which is the answer `up --visual-model` probes for.
const visualModel = process.env.VISUAL_MODEL === "true";

if (process.env.STUB_ENV_FILE) {
  writeFileSync(process.env.STUB_ENV_FILE, JSON.stringify(process.env));
}

if (mode === "refuse") {
  console.error(process.env.STUB_REFUSAL_LINE ?? "stub-engine: refusing to boot");
  process.exit(1);
}

if (mode === "never-bind") {
  // Stay alive, bind nothing: the readiness bound is what ends the wait.
  setInterval(() => {}, 60_000);
} else if (mode === "bind-never-answer") {
  const server = createTcpServer(() => {
    // Accept and say nothing: the probe's timeout classifies this as a
    // listener, the fail-closed direction.
  });
  server.listen(port, "127.0.0.1");
} else {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", engine: "habenula-engine" }));
      return;
    }
    if (
      visualModel &&
      req.method === "GET" &&
      req.url?.startsWith("/api/dev/contracts")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ routes: [] }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/internal/mcp")) {
      if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let id = null;
        try {
          id = JSON.parse(body).id ?? null;
        } catch {
          // A malformed frame still gets an envelope; the tests never send one.
        }
        const payload = { session: null, grants: [], held: [], auditTail: null };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`stub-engine ready at http://127.0.0.1:${port}/`);
    if (mode === "exit-after-serve") {
      const after = Number(process.env.STUB_EXIT_AFTER_MS ?? "50");
      const code = Number(process.env.STUB_EXIT_CODE ?? "70");
      setTimeout(() => process.exit(code), after);
    }
  });
}
