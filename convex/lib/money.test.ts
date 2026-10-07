import { describe, expect, test } from "vitest";
import {
  assertCents,
  centsToDollarsForDisplay,
  formatCents,
  fromDollars,
  fromPayPalString,
  percentageOfCents,
  splitRetainage,
  sumCents,
  toPayPalString,
} from "./money";

describe("fromDollars", () => {
  test("converts whole and fractional dollars to integer cents", () => {
    expect(fromDollars(1234.56)).toBe(123456);
    expect(fromDollars(12500)).toBe(1250000);
    expect(fromDollars("1234.56")).toBe(123456);
    expect(fromDollars("$1,234.5")).toBe(123450);
  });

  test("rounds half away from zero without float error", () => {
    expect(fromDollars(1.005)).toBe(101);
    expect(fromDollars("1.005")).toBe(101);
    expect(fromDollars(0.125)).toBe(13);
    expect(fromDollars(0.124)).toBe(12);
    expect(fromDollars(0.1 + 0.2)).toBe(30);
    expect(fromDollars(-1.005)).toBe(-101);
  });

  test("handles zero and negatives", () => {
    expect(fromDollars(0)).toBe(0);
    expect(Object.is(fromDollars(-0), 0)).toBe(true);
    expect(Object.is(fromDollars("-0.001"), 0)).toBe(true);
    expect(fromDollars(-42.1)).toBe(-4210);
  });

  test("rejects invalid input", () => {
    expect(() => fromDollars(Number.NaN)).toThrow();
    expect(() => fromDollars(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => fromDollars("abc")).toThrow();
    expect(() => fromDollars("")).toThrow();
  });
});

describe("toPayPalString", () => {
  test("formats cents as PayPal amount strings", () => {
    expect(toPayPalString(123456)).toBe("1234.56");
    expect(toPayPalString(1250000)).toBe("12500.00");
    expect(toPayPalString(5)).toBe("0.05");
    expect(toPayPalString(50)).toBe("0.50");
    expect(toPayPalString(0)).toBe("0.00");
  });

  test("never uses thousands separators or exponent notation", () => {
    expect(toPayPalString(123456789012)).toBe("1234567890.12");
  });

  test("rejects negative and non-integer cents", () => {
    expect(() => toPayPalString(-1)).toThrow(/negative/);
    expect(() => toPayPalString(12.5)).toThrow(/integer/);
  });

  test("round-trips through fromPayPalString", () => {
    for (const c of [0, 1, 99, 100, 123456, 1250000]) {
      expect(fromPayPalString(toPayPalString(c))).toBe(c);
    }
    expect(() => fromPayPalString("1,234.56")).toThrow();
    expect(() => fromPayPalString("1.234")).toThrow();
  });
});

describe("formatCents", () => {
  test("uses two decimals and thousands separators", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(7)).toBe("$0.07");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-250075)).toBe("-$2,500.75");
  });
});

describe("percentageOfCents", () => {
  test("10% retainage on odd cents rounds half up to the nearest cent", () => {
    expect(percentageOfCents(12345, 10)).toBe(1235); // 1234.5
    expect(percentageOfCents(12344, 10)).toBe(1234); // 1234.4
    expect(percentageOfCents(12346, 10)).toBe(1235); // 1234.6
    expect(percentageOfCents(1, 10)).toBe(0);
    expect(percentageOfCents(5, 10)).toBe(1); // 0.5
  });

  test("supports fractional percentages and exact large amounts", () => {
    expect(percentageOfCents(100001, 7.5)).toBe(7500); // 7500.075
    expect(percentageOfCents(333, 33.333333)).toBe(111);
    expect(percentageOfCents(900_719_925_474_099, 10)).toBe(90_071_992_547_410);
  });

  test("zero and negative amounts", () => {
    expect(percentageOfCents(0, 10)).toBe(0);
    expect(percentageOfCents(12345, 0)).toBe(0);
    expect(percentageOfCents(-12345, 10)).toBe(-1235);
    expect(Object.is(percentageOfCents(-1, 10), 0)).toBe(true);
  });

  test("rejects non-integer cents", () => {
    expect(() => percentageOfCents(10.5, 10)).toThrow();
    expect(() => percentageOfCents(100, Number.NaN)).toThrow();
  });
});

describe("splitRetainage and helpers", () => {
  test("retainage plus net always equals gross", () => {
    for (const gross of [0, 1, 12345, 999_999, 1_250_001]) {
      const { retainageCents, netCents } = splitRetainage(gross, 10);
      expect(retainageCents + netCents).toBe(gross);
    }
    expect(splitRetainage(12345, 10)).toEqual({ retainageCents: 1235, netCents: 11110 });
  });

  test("sumCents, assertCents, display dollars", () => {
    expect(sumCents([100, 250, -50])).toBe(300);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([1, 0.5])).toThrow();
    expect(assertCents(42)).toBe(42);
    expect(centsToDollarsForDisplay(123456)).toBe(1234.56);
  });
});
