import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StoredCredential } from "@habenula-ai/credentials";
import { SERVICES, toolName } from "@habenula-ai/tools";
import {
  makeExpiredCredential,
  seedCiphertext,
} from "../helpers/seed-credential";

/**
 * The two non-obvious success properties, plus the
 * mock's full-lifecycle fidelity — iterated over the catalog so a new
 * service re-runs them for free:
 *
 *  - Routing reads no token: every service's DISPATCH decrypts the
 *    credential exactly once (auth only) and resolves only its own
 *    credential. A tool that declares requiredScopes adds exactly one more
 *    decrypt — the pre-policy scope precondition's decrypt-only read
 *    (the accepted double-decrypt) — also confined to
 *    its own service.
 *  - Provider isolation: only a google-provider service's dispatch touches a
 *    Google endpoint; a mock-provider call never does.
 *  - Mock refresh stays in-process: an expired mock_email credential refreshes
 *    against the in-process refreshMockToken, rotating to a fresh mock_* token
 *    and calling no Google endpoint.
 *
 * Decrypts are counted on the single primitive loadCredential (the seam from
 * the credentials/decrypt-seam test), which resolveCredential reaches through
 * getValidCredential. The spy delegates to the real implementation, so no
 * platform primitive is mocked.
 */
const { loadCredentialSpy } = vi.hoisted(() => ({ loadCredentialSpy: vi.fn() }));

vi.mock("@habenula-ai/credentials/credential-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@habenula-ai/credentials/credential-store")
    >();
  return {
    ...actual,
    loadCredential: loadCredentialSpy.mockImplementation(actual.loadCredential),
  };
});

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

const baseExec = {
  agentId: "agent-1",
  epochId: "2026-04-08",
  timestamp: "2026-04-08T12:00:00Z",
};

// Params each service's first tool accepts — the iterated invariants dispatch
// a real execution, so the params must fit that service's vocabulary (email
// tools take a label, slack tools a channel matching the canned fetch below).
const EXEC_PARAMS: Record<string, Record<string, unknown>> = {
  gmail: { label: "INBOX", maxResults: 1 },
  mock_email: { label: "INBOX", maxResults: 1 },
  slack: { channel: "general", limit: 1 },
  // primary short-circuits name resolution; the canned fetch's gmail-shaped
  // fallback body has no `items`, which lists as zero events — a success.
  google_calendar: {
    calendar: "primary",
    timeMin: "2026-04-08T00:00:00Z",
    timeMax: "2026-04-09T00:00:00Z",
    maxResults: 1,
  },
  // owner is optional: the default listing pages /user/repos (canned below).
  github: {},
  // Browse everything: in-process seeded data, no external fetch at all.
  mock_delivery: {},
  // Outlook's vocabulary is lowercase Graph well-known folder names.
  outlook_mail: { label: "inbox", maxResults: 1 },
};

describe("dispatch isolation + decrypt count", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchedUrls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchedUrls = [];
    loadCredentialSpy.mockClear();
    // Records every URL and serves canned Gmail list/detail and Slack
    // channel-resolution/history responses.
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      if (url.includes("slack.com/api/conversations.list")) {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [{ id: "C123", name: "general" }],
            response_metadata: { next_cursor: "" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("slack.com/api/conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [{ user: "U1", text: "hi", ts: "1700000000.000100" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.github.com/user/repos")) {
        // One short page — a natural end, so github_list succeeds untruncated.
        return new Response(
          JSON.stringify([
            {
              name: "engine",
              full_name: "habenula-ai/engine",
              private: false,
              description: "agent runtime",
              owner: { login: "habenula-ai" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("graph.microsoft.com")) {
        // A Graph folder list: one projected row, no nextLink. Checked
        // before the generic /messages matcher below (the Graph list URL
        // also contains /messages but speaks { value: [...] }).
        return new Response(
          JSON.stringify({
            value: [
              {
                subject: "Hi",
                from: { emailAddress: { address: "a@example.com" } },
                receivedDateTime: "2026-04-08T10:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/messages") && !url.match(/\/messages\/\w/)) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          payload: {
            headers: [
              { name: "Subject", value: "Hi" },
              { name: "From", value: "a@example.com" },
              { name: "Date", value: "2026-04-08T10:00:00Z" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function hitGoogle(): boolean {
    return fetchedUrls.some(
      (u) =>
        u.includes("googleapis.com") ||
        u.includes("oauth2.googleapis.com") ||
        u.includes("accounts.google.com"),
    );
  }

  for (const service of SERVICES.filter((s) => s.connect.type === "oauth")) {
    const provider =
      service.connect.type === "oauth" ? service.connect.provider : null;
    const tool = service.tools[0]!;
    const toolParams = EXEC_PARAMS[service.service]!;

    it(`[${service.service}] decrypts once per seam (dispatch + scope gate), resolves only its own credential`, async () => {
      const userId = `single-decrypt-${service.service}`;
      // Fresh, unexpired credential ⇒ no refresh ⇒ deterministic single
      // decrypt. Per-service token so the injected credential is verifiable.
      const seededToken = `mock_access_isolated_${service.service}`;
      // Seed scopes that satisfy this tool's scope precondition when it
      // declares one (slack gates on channel-history scopes the default
      // gmail-shaped fixture lacks); tools with no requiredScopes keep the
      // default fixture. Any-of coverage, so the full requiredScopes list is
      // sufficient for every service.
      const ciphertext = await seedCiphertext(
        tool.requiredScopes
          ? { access_token: seededToken, scopes: tool.requiredScopes }
          : { access_token: seededToken },
      );

      const stub = getStub();
      await runInDurableObject(stub, (instance) => {
        instance.connectService(service.service, ciphertext);
        const sessionId = instance.resolveActiveSession({
          userId,
          agentId: baseExec.agentId,
        });
        instance.createSessionGrant(
          service.service,
          tool.verb,
          tool.nounExtractor(toolParams),
          sessionId,
        );
      });

      loadCredentialSpy.mockClear();
      const result = await runInDurableObject(stub, (instance) =>
        instance.executeTool({
          ...baseExec,
          toolName: toolName(tool),
          toolParams,
          userId,
        }),
      );

      expect(result.execution!.success).toBe(true);
      // One decrypt per seam: the dispatch-time resolve, plus — only when the
      // tool declares requiredScopes — the pre-policy scope precondition's
      // decrypt-only read. Never more, and every one for
      // this service and no other. `?.length` matches the gate's own
      // predicate (executeTool skips an empty declaration).
      const expectedDecrypts = tool.requiredScopes?.length ? 2 : 1;
      expect(loadCredentialSpy).toHaveBeenCalledTimes(expectedDecrypts);
      for (const call of loadCredentialSpy.mock.calls) {
        expect(call[2]).toBe(service.service);
      }
      // The credential injected into the executor is the one seeded for this
      // service (the last load is the dispatch-time resolve).
      const resolved = (await loadCredentialSpy.mock.results.at(-1)!
        .value) as StoredCredential;
      expect(resolved.access_token).toBe(seededToken);
      // Only a google-provider service authenticates against Google; every
      // other provider's dispatch must not touch a Google endpoint.
      expect(hitGoogle()).toBe(provider === "google");
    });
  }

  it("expired mock_email credential refreshes in-process (no Google call)", async () => {
    const userId = "mock-refresh";
    const original = "mock_access_expired";
    // Expired, so resolve triggers a refresh.
    const ciphertext = await seedCiphertext(
      makeExpiredCredential({
        access_token: original,
        refresh_token: "mock_refresh_kept",
      }),
    );

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({
        userId,
        agentId: baseExec.agentId,
      });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });

    const result = await runInDurableObject(stub, (instance) =>
      instance.executeTool({
        ...baseExec,
        toolName: "mock_email_list",
        toolParams: EXEC_PARAMS.mock_email!,
        userId,
      }),
    );

    expect(result.execution!.success).toBe(true);
    // Refresh minted a fresh mock_* token in-process and wrote it back to the
    // row. Read it back through resolveCredential — now unexpired, so it
    // returns the rotated credential without triggering another refresh.
    const rotated = await runInDurableObject(stub, (instance) =>
      instance.resolveCredential(userId, "mock_email", async (c) => c),
    );
    expect(rotated.access_token).not.toBe(original);
    expect(rotated.access_token.startsWith("mock_access_")).toBe(true);
    expect(rotated.refresh_token).toBe("mock_refresh_kept");
    // The mock refresh never reaches Google's token endpoint.
    expect(hitGoogle()).toBe(false);
  });
});
