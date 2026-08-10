import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

/**
 * The VISUAL_MODEL gate and the page route. The gate is
 * fail-closed: only exactly "true" enables, and a gated-off surface is
 * indistinguishable from an absent one (404). The surface ships off by
 * default; the test suite turns it on via the vitest
 * bindings injection, so tests exercise the off states by overriding the
 * env object passed to the fetch handler.
 */

async function fetchWith(
  path: string,
  visualModel: string | undefined,
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, VISUAL_MODEL: visualModel };
  const response = await worker.fetch(
    new Request(`http://localhost${path}`),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const ROUTES = ["/api/dev/model", "/api/dev/contracts", "/dev/model"];

describe("visual model gating", () => {
  it("unset: all three routes 404 (fail-closed)", async () => {
    for (const path of ROUTES) {
      const res = await fetchWith(path, undefined);
      expect(res.status, path).toBe(404);
    }
  });

  it('"false" and non-"true" junk values stay closed', async () => {
    for (const value of ["false", "TRUE", "1", "yes", ""]) {
      const res = await fetchWith("/dev/model", value);
      expect(res.status, `VISUAL_MODEL=${value}`).toBe(404);
    }
  });

  it('"true": snapshot and contracts respond 200 JSON', async () => {
    for (const path of ["/api/dev/model", "/api/dev/contracts"]) {
      const res = await fetchWith(path, "true");
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
    }
  });

  it('"true": the page serves self-contained HTML with the vendored renderer inlined', async () => {
    const res = await fetchWith("/dev/model", "true");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("habenula · visual model");
    // The vendored cytoscape dist is inlined (license header travels with it)…
    expect(html).toContain("The Cytoscape Consortium");
    // …and nothing points off-origin: no external script/style/fetch targets.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
  });

  it("the decided-by edge targets an audit node, never a policy-entry node", async () => {
    // A text assertion is the honest limit: the page is client JavaScript
    // inside a template string that no suite executes — which is exactly how
    // the wrong 'pe-' prefix survived (the edge-pruning pass dropped the
    // edge on every tick, so nothing ever rendered wrong; it just never
    // rendered).
    const res = await fetchWith("/dev/model", "true");
    const html = await res.text();
    expect(html).toContain("'au-' + au.decisionEntryId");
    expect(html).not.toContain("'pe-' + au.decisionEntryId");
  });
});
