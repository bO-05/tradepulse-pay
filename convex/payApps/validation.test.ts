import { describe, expect, test } from "vitest";
import { approvedPctToDate, priorBillingByLine, sovBaselineByLine, validatePayApp, type SovLineContext } from "./validation";

const sov: SovLineContext[] = [
  { _id: "s1", lineNo: 1, description: "Rough-in", scheduledValueCents: 100_000, previouslyBilledCents: 0, pendingRequestedCents: 0 },
  { _id: "s2", lineNo: 2, description: "Trim", scheduledValueCents: 50_000, previouslyBilledCents: 30_000, pendingRequestedCents: 10_000 },
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
  test("separates approved cents from pending requests and ignores withdrawn and rejected", () => {
    const l = (sovLineId: string, requestedCents: number, pctCompleteToDate = 10) => ({ sovLineId, requestedCents, pctCompleteToDate });
    const m = priorBillingByLine([
      { status: "submitted", lines: [l("s1", 1_000)] },
      { status: "withdrawn", lines: [l("s1", 5_000, 90)] },
      { status: "rejected", lines: [l("s1", 5_000, 90)] },
      { status: "approved", lines: [l("s1", 3_000, 30)], finalApproval: { lines: [{ sovLineId: "s1", approvedCents: 2_000 }] } },
    ]);
    expect(m.get("s1")).toEqual({ approvedCents: 2_000, pendingRequestedCents: 1_000 });
  });

  test("an approved app without a final approval fails closed unless asked for its requested cents", () => {
    const l = (sovLineId: string, requestedCents: number) => ({ sovLineId, requestedCents, pctCompleteToDate: 10 });
    const legacy = [{ status: "paid", lines: [l("s1", 4_000)] }];
    expect(() => priorBillingByLine(legacy)).toThrow(/no recorded final GC-approved amount/);
    expect(priorBillingByLine(legacy, { unresolvedApprovedAs: "requested" }).get("s1")).toEqual({
      approvedCents: 0,
      pendingRequestedCents: 4_000,
    });
  });
});

describe("sovBaselineByLine", () => {
  const sovRows = [{ _id: "s1", scheduledValueCents: 100_000 }];
  const l = (requestedCents: number, pctCompleteToDate: number) => ({ sovLineId: "s1", requestedCents, pctCompleteToDate });

  test("an overbilled request edited down sets the baseline from approved cents, not the claimed percent", () => {
    const b = sovBaselineByLine(
      [{ status: "approved", lines: [l(30_000, 30)], finalApproval: { lines: [{ sovLineId: "s1", approvedCents: 12_345 }] } }],
      sovRows,
    ).get("s1")!;
    expect(b).toEqual({ previouslyBilledCents: 12_345, previousPctToDate: 12.35, pendingRequestedCents: 0, remainingCents: 87_655 });
  });

  test("rejected, withdrawn and pending requests never raise the baseline", () => {
    const b = sovBaselineByLine(
      [
        { status: "rejected", lines: [l(90_000, 90)] },
        { status: "withdrawn", lines: [l(80_000, 80)] },
        { status: "under_review", lines: [l(20_000, 20)] },
      ],
      sovRows,
    ).get("s1")!;
    expect(b).toEqual({ previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 20_000, remainingCents: 80_000 });
  });

  test("a line with no history has a zero baseline and its full scheduled value remaining", () => {
    expect(sovBaselineByLine([], sovRows).get("s1")).toEqual({
      previouslyBilledCents: 0,
      previousPctToDate: 0,
      pendingRequestedCents: 0,
      remainingCents: 100_000,
    });
  });
});

describe("approvedPctToDate", () => {
  test("is approved cents over scheduled value, two decimals, capped at 100", () => {
    expect(approvedPctToDate(25_000, 100_000)).toBe(25);
    expect(approvedPctToDate(1, 300)).toBe(0.33);
    expect(approvedPctToDate(100_000, 100_000)).toBe(100);
    expect(approvedPctToDate(5, 0)).toBe(0);
  });
});
