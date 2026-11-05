import { describe, expect, test } from "vitest";
import {
  QUICK_START_MAX_LINES,
  emptyQuickStartRows,
  parsePastedSov,
  quickStartBidDeadline,
  quickStartSovErrors,
  quickStartSovTotalCents,
  quickStartSubErrors,
  type QuickStartSub,
} from "./quickStartPlan";

const SUB: QuickStartSub = {
  companyName: "Eastbay Electric",
  contactName: "Nora Patel",
  email: "nora@eastbay-electric.example",
  csiDivision: "26 00 00",
  phone: "(510) 555-0142",
  licenseNumber: "C10-123456",
};

describe("quick start SOV planning", () => {
  test("three lines with a positive total are valid; the total is exact cents", () => {
    const rows = emptyQuickStartRows();
    rows[0].description = "Rough-in";
    rows[0].amountCents = 2_200_000;
    rows[1].description = "Trim-out";
    rows[1].amountCents = 1_950_000;
    rows[2].description = "Closeout";
    rows[2].amountCents = 825_000;
    expect(quickStartSovTotalCents(rows)).toBe(4_975_000);
    expect(quickStartSovErrors(rows)).toEqual({ rows: {} });
  });

  test("requires 3-8 lines and at least $1,000.00", () => {
    const one = emptyQuickStartRows().slice(0, 1);
    one[0].description = "Mobilization";
    one[0].amountCents = 50_000;
    const errors = quickStartSovErrors(one);
    expect(errors.count).toMatch(/at least 3/);
    expect(errors.total).toBeUndefined();

    const nine = Array.from({ length: QUICK_START_MAX_LINES + 1 }, (_, i) => ({
      ...emptyQuickStartRows()[0],
      id: String(i),
      description: `Line ${i}`,
      amountCents: 100_000,
    }));
    expect(quickStartSovErrors(nine).count).toMatch(/up to 8/);

    const small = emptyQuickStartRows().map((row, i) => ({ ...row, description: `Line ${i}`, amountCents: 20_000 }));
    expect(quickStartSovErrors(small).total).toMatch(/at least \$1,000\.00/);
  });

  test("reports blank descriptions and missing or non-positive amounts by row", () => {
    const rows = emptyQuickStartRows();
    rows[0].description = " ";
    rows[1].amountCents = 0;
    const errors = quickStartSovErrors(rows);
    expect(errors.rows[0]?.description).toMatch(/Describe/);
    expect(errors.rows[1]?.amountCents).toMatch(/greater than \$0\.00/);
    expect(errors.rows[2]?.amountCents).toMatch(/Enter an amount/);
  });
});

describe("paste parser", () => {
  test("accepts tab, pipe and comma rows with dollar signs and commas", () => {
    const parsed = parsePastedSov("Rough-in\t$22,000.00\nTrim-out | 19,500\nCloseout, 8,250.50");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { description: "Rough-in", amountCents: 2_200_000 },
      { description: "Trim-out", amountCents: 1_950_000 },
      { description: "Closeout", amountCents: 825_050 },
    ]);
  });

  test("skips a header row and strips surrounding quotes", () => {
    const parsed = parsePastedSov('Description, Amount\n"Rough-in", "22000"\nTrim-out, 19500\nCloseout, 8250');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.description)).toEqual(["Rough-in", "Trim-out", "Closeout"]);
  });

  test("refuses malformed rows, bad amounts, and more than eight rows", () => {
    expect(parsePastedSov("Rough-in\nTrim-out, 19500\nCloseout, 8250").errors[0]).toMatch(/Description, amount/);
    expect(parsePastedSov("Rough-in, 0\nTrim-out, 19500\nCloseout, 8250").errors[0]).toMatch(/greater than \$0\.00/);
    const nine = Array.from({ length: 9 }, (_, i) => `Line ${i}, 1000`).join("\n");
    expect(parsePastedSov(nine).errors[0]).toMatch(/up to 8/);
  });
});

describe("sub validation and bid deadline", () => {
  test("a complete sub passes; a bad trade and email fail with field-tagged messages", () => {
    expect(quickStartSubErrors(SUB)).toEqual({});
    const errors = quickStartSubErrors({ ...SUB, csiDivision: "99 00 00", email: "not-an-email" });
    expect(errors.csiDivision).toBeTruthy();
    expect(errors.email).toBeTruthy();
  });

  test("the bid deadline is a UTC date two weeks out", () => {
    expect(quickStartBidDeadline(new Date("2026-11-05T23:30:00Z"))).toBe("2026-11-19");
    expect(quickStartBidDeadline(new Date("2026-12-28T01:00:00Z"))).toBe("2027-01-11");
  });
});
