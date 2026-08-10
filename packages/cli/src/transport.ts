// SPDX-FileCopyrightText: 2026 Habenula, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { FetchFn } from "./api-client";

/**
 * Statuses the `Response` constructor requires a null body for
 * (the fetch spec's null-body statuses).
 */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The CLI's production transport: `node:http(s)` behind the `FetchFn` seam,
 * with NO transport-imposed timeout. Every request the CLI sends is already
 * bounded by a deadline its request core chose and armed as an `AbortSignal`
 * (`CONTROL_DEADLINE_MS` / `CHAT_DEADLINE_MS`), so the one number that bounds
 * a request is the number the CLI chose — the transport adds none of its own.
 *
 * This exists because the global `fetch` it replaces is not neutral: Node's
 * undici dispatcher defaults `headersTimeout` to 300000 ms, so a chat turn
 * whose response headers take longer than five minutes — a model that hangs
 * until the engine's own ten-minute ceiling ends the turn — died with a raw
 * socket error while the CLI's chosen deadline still had five minutes to run.
 * The engine's ceiling could never be observed by the shipped client. A
 * `node:http` request has no default response timeout, which is exactly the
 * contract the request cores were written against.
 *
 * Scope decisions, both deliberate:
 *   - No connection reuse (`agent: false` + `Connection: close`): a fresh
 *     socket per request costs one loopback (or TLS) handshake, nothing at the
 *     CLI's request rate, and removes the keep-alive race where a pooled
 *     socket the server already closed turns the next request into a spurious
 *     connection error.
 *   - No redirect following: the engine API never redirects; a 3xx surfaces
 *     as its status like any other response.
 *
 * The rejection contract matches the global fetch it replaces: an abort
 * rejects with the signal's reason, and a socket-level failure rejects with a
 * `TypeError` carrying the Node error as its `cause` — the shape the
 * engine-lifecycle port classifier reads `ECONNREFUSED` from
 * (`connectionRefused` in `engine/probe.ts`; `up`'s port scan breaks if a
 * refusal ever surfaces bare).
 *
 * The body is buffered before the `Response` resolves — every consumer reads
 * `res.text()` on a JSON payload, and buffering keeps the abort story simple:
 * a deadline that expires mid-body destroys the request and rejects, which the
 * request cores already classify (`timedOut` flag). It also means a transport
 * failure mid-body rejects before any `Response` exists, so the request cores
 * classify it as an availability failure rather than the raw rethrow the
 * streaming fetch forced on them (see the post-`Response` note on
 * `ApiClient.request`).
 */
export const nodeFetch: FetchFn = (input, init) =>
  new Promise((resolve, reject) => {
    const url = new URL(input);
    const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = init?.signal;

    const abortReason = (): Error =>
      (signal?.reason as Error | undefined) ??
      new DOMException("This operation was aborted", "AbortError");

    if (signal?.aborted) {
      reject(abortReason());
      return;
    }

    // Settle-once discipline: an abort destroys the request, which also emits
    // 'error' on the request (and sometimes the response) — without the guard
    // the later event would reject an already-settled promise into the void,
    // and with it the FIRST reason (the abort) is the one reported.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const settleReject = (err: unknown): void => {
      settle(() => reject(err));
    };
    // Socket-level failures reject fetch-shaped — TypeError, Node error as
    // `cause` — per the contract in the module comment. The abort path stays
    // bare (the signal's reason), also matching fetch.
    const settleRejectFetchShaped = (err: unknown): void => {
      settle(() => reject(new TypeError("fetch failed", { cause: err })));
    };
    const onAbort = (): void => {
      const reason = abortReason();
      settleReject(reason);
      req.destroy(reason);
    };

    const body = init?.body;
    const headers: Record<string, string> = {
      ...init?.headers,
      connection: "close",
      ...(body !== undefined
        ? { "content-length": String(Buffer.byteLength(body)) }
        : {}),
    };

    const req = requestFn(
      url,
      { method: init?.method ?? "GET", headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", settleRejectFetchShaped);
        res.on("end", () => {
          // Built before settling so a constructor throw (a status outside
          // the Response range) rejects the promise instead of escaping the
          // event handler as an uncatchable.
          let response: Response;
          try {
            const status = res.statusCode ?? 0;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              responseHeaders.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
            }
            response = new Response(
              // A null-body status must carry null — the Response
              // constructor refuses a body (even an empty one) for these.
              NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks),
              { status, headers: responseHeaders },
            );
          } catch (err) {
            settleReject(err);
            return;
          }
          settle(() => resolve(response));
        });
      },
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", settleRejectFetchShaped);
    if (body !== undefined) req.write(body);
    req.end();
  });
