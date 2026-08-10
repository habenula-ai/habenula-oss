// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { StoredCredential } from "./types.js";
import { assertStoredCredential } from "./crypto.js";
import {
  loadCredential,
  storeCredential,
  type CredentialRowStore,
} from "./credential-store.js";

export class CredentialNotFoundError extends Error {
  constructor(service: string) {
    super(`No credential found for service: ${service}`);
    this.name = "CredentialNotFoundError";
  }
}

/**
 * Single-flight token refresh. First caller refreshes, concurrent callers
 * await the same promise. In-memory map — lost on DO hibernation, which is
 * correct: no concurrent callers exist after wake.
 */
export class SingleFlightRefresher {
  private inflight = new Map<string, Promise<StoredCredential>>();

  /**
   * Get a valid credential for the given service. If the token is expired,
   * refresh it via refreshFn (single-flight: first caller refreshes,
   * concurrent callers wait for the result).
   */
  async getValidCredential(params: {
    store: CredentialRowStore;
    encKey: CryptoKey;
    userId: string;
    service: string;
    refreshFn: (credential: StoredCredential) => Promise<StoredCredential>;
  }): Promise<StoredCredential> {
    // The exact ciphertext this refresh is based on, read before any await that
    // could let a reconnect replace the row. The write-back is a compare-and-swap
    // against it, so a refresh only lands on the same connection generation it
    // read from. Read is synchronous and adjacent to loadCredential's own
    // read, so it is the ciphertext that decrypts to `credential`.
    const baselineCiphertext = params.store.read(params.service);
    const credential = await loadCredential(
      params.store,
      params.encKey,
      params.service,
    );
    if (!credential || baselineCiphertext === null) {
      throw new CredentialNotFoundError(params.service);
    }

    // Token still valid (with 60-second buffer)
    const nowUnix = Math.floor(Date.now() / 1000);
    if (credential.expiry_unix > nowUnix + 60) {
      return credential;
    }

    // Token expired — single-flight refresh
    const key = `${params.userId}:${params.service}`;
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.doRefresh(params, credential, baselineCiphertext).finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, refreshPromise);
    return refreshPromise;
  }

  private async doRefresh(
    params: {
      store: CredentialRowStore;
      encKey: CryptoKey;
      userId: string;
      service: string;
      refreshFn: (credential: StoredCredential) => Promise<StoredCredential>;
    },
    oldCredential: StoredCredential,
    baselineCiphertext: string,
  ): Promise<StoredCredential> {
    const updated = await params.refreshFn(oldCredential);
    // Enforce the same loud-failure guard the load/decrypt path applies. A
    // provider refresh mapping that read the wrong response field can return an
    // empty/malformed access_token; without this, doRefresh would store it and
    // hand it straight to the tool call — a silent 401 at the provider, exactly
    // what assertStoredCredential exists to prevent. The load path validates on
    // decrypt; the refresh path returns refreshFn's plaintext directly, so it
    // must validate here too.
    assertStoredCredential(updated);
    // Compare-and-swap the write against the ciphertext the refresh read. It
    // lands only if the row is unchanged — rejecting BOTH a disconnect (row
    // gone) and a reconnect / re-consent that replaced the credential during the
    // refresh's network await. Either way the freshly-minted token — now
    // stale relative to the current connection — never reaches the tool call and
    // never clobbers the new credential; the caller retries and re-reads.
    const written = await storeCredential(
      params.store,
      params.encKey,
      params.service,
      updated,
      baselineCiphertext,
    );
    if (!written) {
      throw new CredentialNotFoundError(params.service);
    }
    return updated;
  }
}
