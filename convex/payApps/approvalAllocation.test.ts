import { describe, expect, test } from "vitest";
import { allocateApprovedTotal, type AllocationLine } from "./approvalAllocation";

const line = (lineNo: number, recommendedCents: number, capCents: number, excludedScope = false): AllocationLine => ({
  sovLineId: `L${lineNo}`,
  lineNo,
  excludedScope,
  recommendedCents,
  capCents,
});

function cents(r: ReturnType<typeof allocateApprovedTotal>) {
  if (!r.ok) throw new Error(r.message);
  return r.lines.map((l) => l.approvedCents);
}

describe("allocateApprovedTotal", () => {
  test("an unedited total keeps the review recommendation per line", () => {
    expect(cents(allocateApprovedTotal([line(1, 30_000, 40_000), line(2, 70_000, 90_000)], 100_000))).toEqual([30_000, 70_000]);
  });

  test("a downward edit scales the recommendations and puts the rounding remainder on the last base-scope line", () => {
    const r = cents(allocateApprovedTotal([line(1, 1, 10), line(2, 1, 10), line(3, 1, 10)], 2));
    expect(r).toEqual([0, 1, 1]);
    const r2 = cents(allocateApprovedTotal([line(1, 33_333, 50_000), line(2, 33_333, 50_000), line(3, 33_334, 50_000)], 10_001));
    expect(r2.reduce((a, b) => a + b, 0)).toBe(10_001);
    expect(r2).toEqual([3_333, 3_333, 3_335]);
  });

  test("a downward edit never raises a line above its recommendation", () => {
    const r = cents(allocateApprovedTotal([line(1, 99, 1000), line(2, 1, 1000)], 50));
    expect(r[0]).toBeLessThanOrEqual(99);
    expect(r[1]).toBeLessThanOrEqual(1);
    expect(r[0] + r[1]).toBe(50);
  });

  test("an upward edit spreads the extra over base-scope headroom and never exceeds a line's cap", () => {
    const lines = [line(1, 10_000, 20_000), line(2, 0, 5_000, true), line(3, 20_000, 30_000)];
    const r = cents(allocateApprovedTotal(lines, 45_000));
    expect(r).toEqual([17_500, 0, 27_500]);
    expect(cents(allocateApprovedTotal(lines, 50_000))).toEqual([20_000, 0, 30_000]);
  });

  test("a total past what the lines can bill is refused with the maximum", () => {
    const r = allocateApprovedTotal([line(1, 10_000, 20_000), line(2, 0, 5_000, true)], 20_001);
    expect(r).toMatchObject({ ok: false, maxCents: 20_000 });
    if (!r.ok) expect(r.message).toMatch(/\$200\.00/);
  });

  test("recommendations above the remaining value are clamped to the cap", () => {
    expect(cents(allocateApprovedTotal([line(1, 50_000, 30_000), line(2, 10_000, 10_000)], 40_000))).toEqual([30_000, 10_000]);
  });

  test("an upward edit from a zero recommendation is split by headroom", () => {
    expect(cents(allocateApprovedTotal([line(1, 0, 3), line(2, 0, 3)], 5))).toEqual([2, 3]);
  });

  test("non-integer or negative totals are refused", () => {
    expect(allocateApprovedTotal([line(1, 10, 10)], 1.5).ok).toBe(false);
    expect(allocateApprovedTotal([line(1, 10, 10)], -1).ok).toBe(false);
  });

  test("large amounts stay exact", () => {
    const r = cents(allocateApprovedTotal([line(1, 4_000_000_000_00, 9_000_000_000_00), line(2, 3_000_000_000_01, 9_000_000_000_00)], 7_000_000_000_00));
    expect(r[0] + r[1]).toBe(7_000_000_000_00);
  });
});
