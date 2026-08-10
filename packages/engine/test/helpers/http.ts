import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";

/**
 * HTTP-entry test seam. Behavior whose correctness depends on the
 * handler↔DO marshaling gets at least one test that enters here, not only a
 * `runInDurableObject()` one — a DO-method test is structurally blind to a
 * wiring defect in the boundary above it, which is how the per-request
 * session re-mint reached `main` with the DO logic correct and well covered.
 *
 * The DO reached through these helpers is always the by-name stub, because
 * `index.ts` derives it with `idFromName(userId)`. Seed credentials and inject
 * a mock LLM on `stubFor(userId)` — a `newUniqueId()` stub is unreachable from
 * the routes.
 */

/** Drive one request through the real Worker fetch handler. */
export async function workerFetch(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A JSON POST to an engine route. */
export function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A GET to an engine route; `query` is appended as the search string. */
export function get(path: string, query: Record<string, string> = {}): Request {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), { method: "GET" });
}

/** The DO the routes reach for this user (same derivation as `index.ts`). */
export function stubFor(userId: string) {
  return env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
}

/** POST a route and parse the JSON body in one step. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await workerFetch(post(path, body));
  return (await res.json()) as T;
}
