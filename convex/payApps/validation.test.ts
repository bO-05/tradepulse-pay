import { describe, expect, test } from "vitest";
import { priorBillingByLine, validatePayApp, type SovLineContext } from "./validation";

const sov: SovLineContext[] = [
  { _id: "s1", lineNo: 1, description: "Rough-in", scheduledValueCents: 100_000, previouslyBilledCents: 0 },
  { _id: "s2", lineNo: 2, description: "Trim", scheduledValueCents: 50_000, previouslyBilledCents: 40_000 },
];
const line = (over: Partial<{ sovLineId: string; pctCompleteThisPeriod: number; pctCompleteToDate: number; requestedCents: number }> = {}) => ({
  sovLineId: "s1",
  pctCompleteThisPeriod: 10,
  pctCompleteToDate: 10,
  requestedCents: 10_000,
  ...over,
});
const base = { periodLabel: "Oct 2026", notes: "" };

describe("validatePayApp", () => {
  test("accepts a valid app and sums integer cents", () => {
    const r = validatePayApp({ ...base, lines: [line(), line({ sovLineId: "s2", requestedCents: 10_000 })] }, sov);
    expect(r.errors).toEqual([]);
    expect(r.requestedTotalCents).toBe(20_000);
    expect(r.lines).toHaveLength(2);
  });

  test("drops all-zero lines", () => {
    const r = validatePayApp(
      { ...base, lines: [line(), line({ sovLineId: "s2", pctCompleteThisPeriod: 0, pctCompleteToDate: 0, requestedCents: 0 })] },
      sov,
    );
    expect(r.lines.map((l) => l.sovLineId)).toEqual(["s1"]);
  });

  test.each([
    ["to date above 100", line({ pctCompleteToDate: 101 }), /to date must be between 0 and 100/],
    ["to date below 0", line({ pctCompleteToDate: -1, pctCompleteThisPeriod: 0 }), /to date must be between 0 and 100/],
    ["this period above 100", line({ pctCompleteThisPeriod: 120 }), /this period must be between 0 and 100/],
    ["to date below this period", line({ pctCompleteThisPeriod: 20, pctCompleteToDate: 10 }), /cannot be less than/],
    ["negative request", line({ requestedCents: -1 }), /cannot be negative/],
    ["fractional cents", line({ requestedCents: 10.5 }), /whole number of cents/],
    ["NaN request", line({ requestedCents: Number.NaN }), /whole number of cents/],
    ["over remaining", line({ sovLineId: "s2", requestedCents: 10_001 }), /remaining scheduled value of \$100\.00/],
    ["unknown SOV line", line({ sovLineId: "other" }), /does not belong/],
  ])("rejects %s", (_name, bad, message) => {
    const r = validatePayApp({ ...base, lines: [bad] }, sov);
    expect(r.errors.map((e) => e.message).join(" ")).toMatch(message);
  });

  test("requires a period label", () => {
    const r = validatePayApp({ ...base, periodLabel: "   ", lines: [line()] }, sov);
    expect(r.errors).toEqual([{ field: "periodLabel", message: "Period label is required." }]);
  });

  test("requires at least one line with a non-zero request", () => {
    expect(validatePayApp({ ...base, lines: [] }, sov).errors[0].message).toMatch(/at least one line/);
    const zero = validatePayApp({ ...base, lines: [line({ requestedCents: 0 })] }, sov);
    expect(zero.errors[0].message).toMatch(/at least one line/);
  });

  test("rejects duplicate lines", () => {
    const r = validatePayApp({ ...base, lines: [line(), line()] }, sov);
    expect(r.errors[0].message).toMatch(/more than once/);
  });
});

describe("priorBillingByLine", () => {
  test("counts open and approved apps, ignores withdrawn and rejected, prefers approved cents", () => {
    const l = (sovLineId: string, requestedCents: number, pctCompleteToDate = 10) => ({ sovLineId, requestedCents, pctCompleteToDate });
    const m = priorBillingByLine([
      { status: "submitted", lines: [l("s1", 1_000)] },
      { status: "withdrawn", lines: [l("s1", 5_000, 90)] },
      { status: "rejected", lines: [l("s1", 5_000, 90)] },
      { status: "approved", lines: [l("s1", 3_000, 30)], review: { lines: [{ sovLineId: "s1", approvedCents: 2_000 }] } },
    ]);
    expect(m.get("s1")).toEqual({ billedCents: 3_000, pctToDate: 30 });
  });
});
