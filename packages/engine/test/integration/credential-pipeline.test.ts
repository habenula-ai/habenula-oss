import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import type { EncryptedPayload } from "@habenula-ai/credentials";
import {
  encryptCredentialForRow,
  makeExpiredCredential,
  makeStoredCredential,
  seedCiphertext,
} from "../helpers/seed-credential";

describe("Credential pipeline integration", () => {
  function getStub() {
    const id = env.USER_AGENT.newUniqueId();
    return env.USER_AGENT.get(id);
  }

  it("resolveCredential retrieves and decrypts the credential from the row", async () => {
    const credential = makeStoredCredential({
      access_token: "ya29.pipeline-test-token",
      refresh_token: "1//pipeline-refresh-token",
    });
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      credential,
    );

    const stub = getStub();
    const result = await runInDurableObject(stub, async (instance) => {
      instance.connectService("gmail", ciphertext);
      const refreshFn = vi.fn();
      return instance.resolveCredential("user-pipeline", "gmail", refreshFn);
    });

    expect(result.access_token).toBe("ya29.pipeline-test-token");
    expect(result.refresh_token).toBe("1//pipeline-refresh-token");
    expect(result.scopes).toEqual([
      "email.read",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  // A reconnect — a second `connectService` for
  // an already-connected service — must REPLACE the credential via the upsert's
  // `ON CONFLICT DO UPDATE`, while leaving `connected_at` at its first-connect
  // value. This is the regression guard for that behavior: a revert to
  // `INSERT OR IGNORE` (which would keep the stale credential) or an ON CONFLICT
  // that also rewrote `connected_at` would otherwise pass silently.
  it("reconnect overwrites the credential and preserves connected_at", async () => {
    const first = await seedCiphertext({ access_token: "ya29.first-token" });
    const second = await seedCiphertext({ access_token: "ya29.second-token" });

    const stub = getStub();

    const connectedAtAfterFirst = await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", first);
      return instance.listConnectedServices()[0]!.connected_at;
    });

    const { resolved, services } = await runInDurableObject(
      stub,
      async (instance) => {
        instance.connectService("gmail", second);
        const refreshFn = vi.fn();
        const resolved = await instance.resolveCredential(
          "user-overwrite",
          "gmail",
          refreshFn,
        );
        return { resolved, services: instance.listConnectedServices() };
      },
    );

    // Credential replaced — the live read path returns the second token (the
    // credential is non-expired, so refreshFn is never consulted).
    expect(resolved.access_token).toBe("ya29.second-token");
    // Still one row, connected_at unchanged from the first connect.
    expect(services).toHaveLength(1);
    expect(services[0]!.connected_at).toBe(connectedAtAfterFirst);
  });

  // TOCTOU guard: if a `disconnectService` lands while a refresh is in its
  // network await, the refreshed credential must NOT reach the caller. The DO
  // is single-threaded, so the only interleave point is the `await` inside the
  // refresher — we reproduce it deterministically by disconnecting synchronously
  // from within the mock refreshFn. The write-back then matches zero rows and
  // `resolveCredential` must throw rather than hand back a live token for a
  // service the user just revoked.
  it("disconnect during refresh rejects the refreshed credential", async () => {
    const expired = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      makeExpiredCredential({ access_token: "ya29.about-to-refresh" }),
    );

    const stub = getStub();
    await expect(
      runInDurableObject(stub, async (instance) => {
        instance.connectService("gmail", expired);
        const refreshFn = vi.fn().mockImplementation(async () => {
          // The disconnect wins the race during the refresh's await.
          instance.disconnectService("gmail");
          return makeStoredCredential({ access_token: "ya29.refreshed-too-late" });
        });
        return instance.resolveCredential("user-toctou", "gmail", refreshFn);
      }),
    ).rejects.toThrow("No credential found for service: gmail");
  });

  // Success metric: the credential lives on the row, not
  // KV — verified by reading the column directly and confirming it is opaque
  // ciphertext, never the plaintext token.
  it("the credential column holds opaque ciphertext, never the plaintext token", async () => {
    const credential = makeStoredCredential({
      access_token: "ya29.opaque-check-token",
      refresh_token: "1//opaque-check-refresh",
    });
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      credential,
    );

    const stub = getStub();
    const stored = await runInDurableObject(stub, (instance) => {
      instance.connectService("gmail", ciphertext);
      return [...instance.sql<{ credential: string | null }>`
        SELECT credential FROM connected_services WHERE service = 'gmail'
      `][0]!.credential;
    });

    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as EncryptedPayload;
    expect(parsed).toHaveProperty("ct");
    expect(parsed).toHaveProperty("iv");
    expect(stored).not.toContain("ya29.opaque-check-token");
    expect(stored).not.toContain("1//opaque-check-refresh");
  });

  it("plaintext token never lands in the audit log", async () => {
    const mockCred = makeStoredCredential({
      access_token: "mock_access_no_leak",
      refresh_token: "mock_refresh_no_leak",
    });
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      mockCred,
    );

    const stub = getStub();
    await runInDurableObject(stub, (instance) => {
      instance.connectService("mock_email", ciphertext);
      const sessionId = instance.resolveActiveSession({ userId: "user-no-leak", agentId: "agent-1" });
      instance.createSessionGrant("mock_email", "list", "INBOX", sessionId);
    });
    await runInDurableObject(stub, async (instance) => {
      return instance.executeTool({
        toolName: "mock_email_list",
        toolParams: { label: "INBOX" },
        userId: "user-no-leak",
        agentId: "agent-1",
        epochId: "2026-04-08",
        timestamp: "2026-04-08T12:00:00Z",
      });
    });

    // Scan all audit_log rows for any token substring.
    const rows = await runInDurableObject(stub, (instance) => {
      return instance.sql<Record<string, string | null>>`
        SELECT * FROM audit_log
      `;
    });

    const joined = rows
      .flatMap((row) => Object.values(row).map((v) => String(v ?? "")))
      .join("|");

    expect(joined).not.toContain("mock_access_no_leak");
    expect(joined).not.toContain("mock_refresh_no_leak");
  });

  // Success metric: revocation is strongly consistent —
  // a disconnect makes the credential immediately unresolvable in the same DO,
  // with no consistency window.
  it("disconnect makes the credential immediately unresolvable in the same DO", async () => {
    const credential = makeStoredCredential({
      access_token: "ya29.pipeline-test-token",
    });
    const ciphertext = await encryptCredentialForRow(
      env.CREDENTIAL_ENCRYPTION_KEY,
      credential,
    );

    const stub = getStub();

    // Connect + resolve: works.
    await runInDurableObject(stub, async (instance) => {
      instance.connectService("gmail", ciphertext);
      const result = await instance.resolveCredential(
        "user-delete-test",
        "gmail",
        vi.fn(),
      );
      expect(result.access_token).toBe("ya29.pipeline-test-token");
    });

    // Disconnect deletes the row and its credential in one operation.
    await runInDurableObject(stub, (instance) => {
      instance.disconnectService("gmail");
    });

    // No consistency window: the next resolve in the same DO throws.
    await expect(
      runInDurableObject(stub, async (instance) => {
        return instance.resolveCredential("user-delete-test", "gmail", vi.fn());
      }),
    ).rejects.toThrow("No credential found for service: gmail");
  });
});
