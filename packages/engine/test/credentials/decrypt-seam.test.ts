import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Observation seam for the decrypt-count assertions (single-decrypt elimination
 * and mock isolation). loadCredential (credential-store.ts) is the single
 * decrypt primitive; resolveCredential reaches it through
 * getValidCredential (token-refresh.ts), so one spy on loadCredential observes
 * every decrypt on every service's path.
 *
 * The spy delegates to the real implementation — real DO-SQLite row read, real
 * AES-256-GCM decrypt — so no platform primitive is mocked (Hard Invariant 5).
 * It only counts and records the arguments of each call, so one spy observes
 * every decrypt on every service's path.
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

import { seedCiphertext } from "../helpers/seed-credential";

function getStub() {
  const id = env.USER_AGENT.newUniqueId();
  return env.USER_AGENT.get(id);
}

describe("decrypt observation seam (loadCredential spy)", () => {
  beforeEach(() => {
    loadCredentialSpy.mockClear();
  });

  it("intercepts the loadCredential call made through resolveCredential", async () => {
    const userId = "decrypt-seam-resolve";
    const ciphertext = await seedCiphertext({ access_token: "seam-token" });

    // Seed on the same stub the resolve runs against — the row-backed store
    // resolves by service within the DO. connectService writes the ciphertext
    // directly, so it never calls loadCredential and never moves the count.
    const stub = getStub();
    await runInDurableObject(stub, (instance) =>
      instance.connectService("gmail", ciphertext),
    );

    // Ignore any decrypts during setup; count only the resolve path.
    loadCredentialSpy.mockClear();

    const resolved = await runInDurableObject(stub, (instance) =>
      // Fresh, unexpired credential ⇒ refreshFn is never invoked.
      instance.resolveCredential(userId, "gmail", async (c) => c),
    );

    expect(resolved.access_token).toBe("seam-token");
    expect(loadCredentialSpy).toHaveBeenCalledTimes(1);
    expect(loadCredentialSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "gmail",
    );
  });
});
