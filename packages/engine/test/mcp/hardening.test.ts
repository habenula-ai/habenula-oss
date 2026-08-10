/**
 * Worker-wide loopback hardening:
 * non-loopback Host (DNS rebinding) and non-loopback Origin (browser
 * drive-by) are refused 403 before ANY routing — /api/* and /mcp alike.
 * Non-browser clients send no Origin and pass.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ userId: "h-user", message: "hi" }),
  });
}

describe("loopback guard", () => {
  it("treats hostnames case-insensitively (RFC 4343) — LOCALHOST admits", async () => {
    const { rejectNonLocal } = await import("../../src/http");
    const req = new Request("http://localhost/api/session", {
      headers: { host: "LOCALHOST:8787" },
    });
    expect(rejectNonLocal(req)).toBeNull();
  });

  it("admits loopback hosts with no Origin (CLI / MCP clients)", async () => {
    for (const base of ["http://localhost", "http://127.0.0.1:8787"]) {
      const res = await SELF.fetch(`${base}/api/session?userId=h-user`);
      expect(res.status).toBe(200);
    }
  });

  it("rejects a non-loopback Host on every surface — DNS rebinding", async () => {
    for (const path of ["/api/chat", "/mcp", "/api/session/start"]) {
      const res = await post(`http://rebound.attacker.example${path}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "local requests only" });
    }
  });

  it("rejects a non-loopback Origin — browser drive-by", async () => {
    const res = await post("http://localhost/api/chat", {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("admits a loopback Origin and rejects a malformed one", async () => {
    const ok = await SELF.fetch("http://localhost/api/session?userId=h-user", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch("http://localhost/api/session?userId=h-user", {
      headers: { origin: "not-a-url" },
    });
    expect(bad.status).toBe(403);
  });

  it("fails a non-loopback preflight closed (guard precedes OPTIONS)", async () => {
    const res = await SELF.fetch("http://localhost/api/chat", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
