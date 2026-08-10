import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { respond } from "../src/respond";
import { CORS_HEADERS } from "../src/http";

/**
 * respond() is the producer-side contract binding.
 * The load-bearing property pinned here is log-and-pass: validation runs
 * AFTER the handler's side effect has applied, so a contract violation must
 * surface as telemetry only — the original body ships unchanged, at the
 * original status, never rejected, never replaced by the parse output (a
 * strict schema's parse would strip the very key the violation is about).
 */

const Shape = z.strictObject({ ok: z.boolean() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("respond()", () => {
  it("returns the body as JSON with the given status and CORS headers", async () => {
    const res = respond(Shape, { ok: true }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      CORS_HEADERS["Access-Control-Allow-Origin"],
    );
    expect(await res.json()).toEqual({ ok: true });
  });

  it("defaults to status 200 and logs nothing on a conforming body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = respond(Shape, { ok: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("log-and-pass: a violating body ships unchanged at its status, with one telemetry line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Bypass the compile-time guard the way a real engine bug would: the
    // value diverges from the schema (extra key + missing key).
    const bad = { okk: true } as unknown as z.infer<typeof Shape>;

    const res = respond(Shape, bad, 200);

    // Never rejected, never stripped: the exact original value ships — the
    // extra key survives (strict parse output would have dropped it) and no
    // status rewrite happens.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ okk: true });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "response contract violation",
      expect.objectContaining({ status: 200 }),
    );
  });
});
