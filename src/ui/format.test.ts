import { describe, expect, test } from "vitest";
import { formatBps, formatCents, formatDate, formatDateTime } from "./format";

describe("formatCents", () => {
  test("formats integer cents as $1,234.56", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(6000000)).toBe("$60,000.00");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  test("negatives use a leading minus", () => {
    expect(formatCents(-125000)).toBe("-$1,250.00");
    expect(formatCents(-1)).toBe("-$0.01");
  });

  test("optional plus sign and missing values", () => {
    expect(formatCents(997500, { showPlus: true })).toBe("+$9,975.00");
    expect(formatCents(null)).toBe("—");
    expect(formatCents(Number.NaN)).toBe("—");
  });

  test("does not drift on large values", () => {
    expect(formatCents(900719925474099)).toBe("$9,007,199,254,740.99");
  });
});

describe("formatDate / formatDateTime", () => {
  const oct8 = Date.UTC(2026, 9, 8, 21, 39, 12);

  test("dates read Oct 8, 2026", () => {
    expect(formatDate(oct8, { timeZone: "UTC" })).toBe("Oct 8, 2026");
    expect(formatDate("2026-10-08")).toBe("Oct 8, 2026");
    expect(formatDate("2026-01-31")).toBe("Jan 31, 2026");
  });

  test("calendar dates do not shift with the viewer's time zone", () => {
    expect(formatDate("2026-10-08", { timeZone: "America/Los_Angeles" })).toBe("Oct 8, 2026");
  });

  test("timestamps add the time without seconds or a zone", () => {
    expect(formatDateTime(oct8, { timeZone: "UTC" })).toBe("Oct 8, 2026, 9:39 PM");
    expect(formatDateTime(oct8, { timeZone: "America/Los_Angeles" })).toBe("Oct 8, 2026, 2:39 PM");
  });

  test("missing or invalid values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });
});

describe("formatBps", () => {
  test("basis points to percent", () => {
    expect(formatBps(500)).toBe("5%");
    expect(formatBps(750)).toBe("7.5%");
    expect(formatBps(1225)).toBe("12.25%");
    expect(formatBps(1000)).toBe("10%");
  });
});
