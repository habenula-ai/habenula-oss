import { env } from "cloudflare:workers";
import { describe, it, expect, vi } from "vitest";
import { importEncryptionKey } from "../src/crypto";
import {
  loadCredential,
  storeCredential,
  type CredentialRowStore,
} from "../src/credential-store";
import {
  SingleFlightRefresher,
  CredentialNotFoundError,
} from "../src/token-refresh";
import {
  makeExpiredCredential,
  makeStoredCredential,
} from "./helpers/seed-credential";

/**
 * In-memory row store standing in for a `connected_services` row, so the
 * refresher's load/store targets a real injected accessor — the same shape
 * the DO builds over its SQLite — without a mock platform primitive.
 */
function makeRowStore(): CredentialRowStore {
  const rows = new Map<string, string>();
  return {
    read: (service) => rows.get(service) ?? null,
    write: (service, ciphertext, expectedCiphertext) => {
      // Compare-and-swap when an expected ciphertext is given: land only if the
      // row still holds it (models the engine's UPDATE ... AND credential = ?).
      // Without one, an unconditional set (initial store / seeding).
      if (
        expectedCiphertext !== undefined &&
        (rows.get(service) ?? null) !== expectedCiphertext
      ) {
        return false;
      }
      rows.set(service, ciphertext);
      return true;
    },
  };
}

describe("SingleFlightRefresher", () => {
  it("returns valid credential without calling refreshFn", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const credential = makeStoredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", credential);

    const refresher = new SingleFlightRefresher();
    const refreshFn = vi.fn();

    const result = await refresher.getValidCredential({
      store,
      encKey,
      userId: "user-valid",
      service: "gmail",
      refreshFn,
    });

    expect(result).toEqual(credential);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("refreshes expired credential and stores the updated one", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    const refreshed = makeStoredCredential({
      access_token: "ya29.new-token",
    });
    const refreshFn = vi.fn().mockResolvedValue(refreshed);

    const refresher = new SingleFlightRefresher();
    const result = await refresher.getValidCredential({
      store,
      encKey,
      userId: "user-expired",
      service: "gmail",
      refreshFn,
    });

    expect(result).toEqual(refreshed);
    expect(refreshFn).toHaveBeenCalledOnce();
    expect(refreshFn).toHaveBeenCalledWith(expired);
  });

  it("a reconnect during refresh does not clobber the new credential (CAS on ciphertext)", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    // Mid-refresh — during the provider-fetch await, the DO delivers the OAuth
    // callback for a reconnect/re-consent, which upserts a fresh credential.
    const reconnected = makeStoredCredential({
      access_token: "ya29.reconnected-account",
    });
    const staleRefresh = makeStoredCredential({
      access_token: "ya29.from-pre-reconnect-grant",
    });
    const refreshFn = vi.fn().mockImplementation(async () => {
      await storeCredential(store, encKey, "gmail", reconnected); // no expected → replaces the row
      return staleRefresh;
    });

    const refresher = new SingleFlightRefresher();
    // The write-back's compare-and-swap fails (the row's ciphertext changed), so
    // the stale refresh is rejected rather than handed to the tool call.
    await expect(
      refresher.getValidCredential({
        store,
        encKey,
        userId: "user-reconnect",
        service: "gmail",
        refreshFn,
      }),
    ).rejects.toThrow(CredentialNotFoundError);

    // The just-reconnected credential survives untouched — the stale token never
    // overwrote it, and its refresh_token was not destroyed.
    const survivor = await loadCredential(store, encKey, "gmail");
    expect(survivor).toEqual(reconnected);
  });

  it("3 concurrent calls on expired credential → exactly 1 refresh", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    const refreshed = makeStoredCredential({
      access_token: "ya29.concurrent-refreshed",
    });

    let callCount = 0;
    const refreshFn = vi.fn().mockImplementation(async () => {
      callCount++;
      // Artificial delay to ensure concurrency
      await new Promise((resolve) => setTimeout(resolve, 50));
      return refreshed;
    });

    const refresher = new SingleFlightRefresher();
    const params = {
      store,
      encKey,
      userId: "user-concurrent",
      service: "gmail",
      refreshFn,
    };

    const [r1, r2, r3] = await Promise.all([
      refresher.getValidCredential(params),
      refresher.getValidCredential(params),
      refresher.getValidCredential(params),
    ]);

    expect(callCount).toBe(1);
    expect(r1).toEqual(refreshed);
    expect(r2).toEqual(refreshed);
    expect(r3).toEqual(refreshed);
  });

  it("failed refresh propagates error to all concurrent callers", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    const refreshFn = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("refresh token revoked");
    });

    const refresher = new SingleFlightRefresher();
    const params = {
      store,
      encKey,
      userId: "user-fail",
      service: "gmail",
      refreshFn,
    };

    const results = await Promise.allSettled([
      refresher.getValidCredential(params),
      refresher.getValidCredential(params),
    ]);

    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("rejected");
    expect(
      (results[0] as PromiseRejectedResult).reason.message,
    ).toBe("refresh token revoked");
    expect(
      (results[1] as PromiseRejectedResult).reason.message,
    ).toBe("refresh token revoked");
    expect(refreshFn).toHaveBeenCalledOnce();
  });

  it("rejects a refreshed credential with an empty access_token — fail loud, not stored", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    // A provider refresh mapping that read the wrong response field yields an
    // empty access_token. Without the guard this becomes a silent 401 at the
    // first API call; with it, doRefresh fails loud (same as the decrypt path).
    const bad = makeStoredCredential({ access_token: "" });
    const refreshFn = vi.fn().mockResolvedValue(bad);

    const refresher = new SingleFlightRefresher();
    await expect(
      refresher.getValidCredential({
        store,
        encKey,
        userId: "user-bad-refresh",
        service: "gmail",
        refreshFn,
      }),
    ).rejects.toThrow(/not a valid StoredCredential/i);

    // The malformed token must never be persisted — the row still decrypts to
    // the original credential, not the empty-token garbage.
    const stillStored = await loadCredential(store, encKey, "gmail");
    expect(stillStored).toEqual(expired);
  });

  it("inflight cleared after failure — subsequent call retries", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const expired = makeExpiredCredential();
    const store = makeRowStore();
    await storeCredential(store, encKey, "gmail", expired);

    const refreshed = makeStoredCredential({
      access_token: "ya29.retry-success",
    });

    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce(refreshed);

    const refresher = new SingleFlightRefresher();
    const params = {
      store,
      encKey,
      userId: "user-retry",
      service: "gmail",
      refreshFn,
    };

    // First call fails
    await expect(refresher.getValidCredential(params)).rejects.toThrow(
      "transient failure",
    );

    // Second call retries (inflight was cleared)
    const result = await refresher.getValidCredential(params);
    expect(result).toEqual(refreshed);
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it("throws CredentialNotFoundError for missing credential", async () => {
    const encKey = await importEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY);
    const refresher = new SingleFlightRefresher();

    await expect(
      refresher.getValidCredential({
        store: makeRowStore(),
        encKey,
        userId: "nonexistent",
        service: "slack",
        refreshFn: vi.fn(),
      }),
    ).rejects.toThrow(CredentialNotFoundError);
  });
});
