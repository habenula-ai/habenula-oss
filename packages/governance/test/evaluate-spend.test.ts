import { describe, it, expect } from "vitest";
import {
  evaluateSpend,
  DEFAULT_MONTHLY_LIMIT_CENTS,
  DEFAULT_SESSION_LIMIT_CENTS,
} from "../src/evaluate-spend";
import type { SpendCheckInput } from "../src/evaluate-spend";

function makeInput(overrides?: Partial<SpendCheckInput>): SpendCheckInput {
  return {
    amountCents: 1500,
    limits: {
      sessionLimitCents: DEFAULT_SESSION_LIMIT_CENTS,
      monthLimitCents: DEFAULT_MONTHLY_LIMIT_CENTS,
    },
    totals: { sessionSpentCents: 0, monthSpentCents: 0 },
    ...overrides,
  };
}

describe("evaluateSpend", () => {
  it("an amount within both windows is within", () => {
    expect(evaluateSpend(makeInput())).toEqual({ result: "within" });
  });

  it("an amount exactly reaching a limit is within — the cap is a ceiling, not a step below it", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 2000,
        totals: { sessionSpentCents: 0, monthSpentCents: 0 },
      }),
    );
    expect(result).toEqual({ result: "within" });
  });

  it("one cent over the session limit breaches the session window", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 2001,
        totals: { sessionSpentCents: 0, monthSpentCents: 0 },
      }),
    );
    expect(result).toEqual({
      result: "exceeds",
      breaches: [
        { window: "session", limitCents: 2000, spentCents: 0 },
      ],
    });
  });

  it("prior session spend counts toward the window", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 600,
        totals: { sessionSpentCents: 1500, monthSpentCents: 1500 },
      }),
    );
    expect(result).toEqual({
      result: "exceeds",
      breaches: [
        { window: "session", limitCents: 2000, spentCents: 1500 },
      ],
    });
  });

  it("the month window breaches independently of the session window", () => {
    // Fresh session (nothing spent in it), but the month is nearly exhausted.
    const result = evaluateSpend(
      makeInput({
        amountCents: 600,
        totals: { sessionSpentCents: 0, monthSpentCents: 4800 },
      }),
    );
    expect(result).toEqual({
      result: "exceeds",
      breaches: [{ window: "month", limitCents: 5000, spentCents: 4800 }],
    });
  });

  it("both windows can breach at once, session reported first", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 3000,
        totals: { sessionSpentCents: 1500, monthSpentCents: 4500 },
      }),
    );
    expect(result).toEqual({
      result: "exceeds",
      breaches: [
        { window: "session", limitCents: 2000, spentCents: 1500 },
        { window: "month", limitCents: 5000, spentCents: 4500 },
      ],
    });
  });

  it("null totals are unavailable — never within, never exceeds", () => {
    expect(evaluateSpend(makeInput({ totals: null }))).toEqual({
      result: "unavailable",
    });
  });

  it("a zero-cent amount against zero limits is within — zero spend never breaches", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 0,
        limits: { sessionLimitCents: 0, monthLimitCents: 0 },
        totals: { sessionSpentCents: 0, monthSpentCents: 0 },
      }),
    );
    expect(result).toEqual({ result: "within" });
  });

  it("any positive amount against a zero limit breaches", () => {
    const result = evaluateSpend(
      makeInput({
        amountCents: 1,
        limits: { sessionLimitCents: 0, monthLimitCents: 0 },
        totals: { sessionSpentCents: 0, monthSpentCents: 0 },
      }),
    );
    expect(result.result).toBe("exceeds");
  });

  describe("fail-closed on malformed input (mirrors evaluatePolicy's posture)", () => {
    // 12.5 pins the integer-minor-units invariant: fractional cents
    // are malformed, not a smaller unit. 2^53 pins the safe-integer boundary —
    // past it the spent+amount addition itself loses precision.
    const malformedAmounts = [NaN, Infinity, -Infinity, -1, 12.5, 2 ** 53];
    for (const amount of malformedAmounts) {
      it(`amountCents=${amount} is unavailable, never ranked`, () => {
        expect(evaluateSpend(makeInput({ amountCents: amount }))).toEqual({
          result: "unavailable",
        });
      });
    }

    it("a fractional total is unavailable — sums are integers by construction, so drift is corruption", () => {
      expect(
        evaluateSpend(
          makeInput({
            totals: { sessionSpentCents: 10.5, monthSpentCents: 0 },
          }),
        ),
      ).toEqual({ result: "unavailable" });
    });

    it("a non-finite limit is unavailable", () => {
      expect(
        evaluateSpend(
          makeInput({
            limits: { sessionLimitCents: NaN, monthLimitCents: 5000 },
          }),
        ),
      ).toEqual({ result: "unavailable" });
    });

    it("a negative total is unavailable", () => {
      expect(
        evaluateSpend(
          makeInput({
            totals: { sessionSpentCents: -100, monthSpentCents: 0 },
          }),
        ),
      ).toEqual({ result: "unavailable" });
    });
  });

  it("shipped defaults are the documented values ($50 month, $20 session)", () => {
    expect(DEFAULT_MONTHLY_LIMIT_CENTS).toBe(5000);
    expect(DEFAULT_SESSION_LIMIT_CENTS).toBe(2000);
  });
});
