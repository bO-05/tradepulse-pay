import { describe, expect, test } from "vitest";
import { fromDollars } from "../lib/money";
import { computeLedgerTotals } from "./ledgerTotals";
import {
  DEFAULT_MILESTONES,
  allocateCents,
  buildSovLines,
  planMilestoneDates,
  sovSourceFingerprint,
  splitMilestoneAmounts,
} from "./sovMath";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateCents", () => {
  test("splits proportionally and puts the remainder on the last entry", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocateCents(1001, [1, 2, 7])).toEqual([100, 200, 701]);
  });

  test("always sums exactly to the total", () => {
    for (const total of [0, 1, 7, 99_999, 122_500_000, 123_456_789_01]) {
      const shares = allocateCents(total, [3, 7, 11, 13, 17]);
      expect(sum(shares)).toBe(total);
      expect(shares.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
    }
  });

  test("all-zero weights split evenly", () => {
    expect(allocateCents(10, [0, 0, 0])).toEqual([3, 3, 4]);
  });

  test("rejects fractional or negative totals", () => {
    expect(() => allocateCents(10.5, [1])).toThrow();
    expect(() => allocateCents(-1, [1])).toThrow();
  });
});

describe("buildSovLines", () => {
  const rosendinItems = [
    { item: "1600A Main Switchboard & Transformers", totalCost: 450000 },
    { item: "Emergency Lighting & Inverters", totalCost: 185000 },
    { item: "Branch Conduit & Wire Feeder Runs", totalCost: 432000 },
    { item: "Crane Hoisting", totalCost: 38000 },
    { item: "Firestopping", totalCost: 20000 },
    { item: "Seismic Bracing", totalCost: 100000 },
  ];

  test("bid line items become SOV lines that sum to the contract sum", () => {
    const lines = buildSovLines({
      contractSumCents: 122_500_000,
      lineItems: rosendinItems,
      exclusions: [],
      csiDivision: "26 00 00",
      tradeName: "Electrical",
    });
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.scheduledValueCents)).toEqual([
      45_000_000, 18_500_000, 43_200_000, 3_800_000, 2_000_000, 10_000_000,
    ]);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines.every((l) => !l.excludedScope)).toBe(true);
  });

  test("leveled exclusions become excluded-scope lines carrying their plug", () => {
    const lines = buildSovLines({
      contractSumCents: fromDollars(1_100_000 + 45_000 + 22_000 + 15_000),
      lineItems: [
        { item: "Switchboard", totalCost: 420000 },
        { item: "Lighting", totalCost: 170000 },
        { item: "Feeders", totalCost: 408000 },
        { item: "Site", totalCost: 102000 },
      ],
      exclusions: [
        { description: "Crane hoisting excluded", costImpact: 45000, isWaived: false },
        { description: "Firestop excluded", costImpact: 22000 },
        { description: "Temp power excluded", costImpact: 9000, isWaived: true },
      ],
      tradeName: "Electrical",
    });
    const excluded = lines.filter((l) => l.excludedScope);
    expect(excluded.map((l) => l.scheduledValueCents)).toEqual([4_500_000, 2_200_000, 0]);
    expect(excluded[0].description).toMatch(/^Excluded scope: Crane/);
    expect(excluded[2].description).toMatch(/waived/);
    expect(sum(lines.map((l) => l.scheduledValueCents))).toBe(fromDollars(1_182_000));
  });

  test("odd-cent contract sums put the rounding remainder on the last base-scope line", () => {
    const lines = buildSovLines({
      contractSumCents: 100_001,
      lineItems: [
        { item: "A", totalCost: 1 },
        { item: "B", totalCost: 1 },
        { item: "C", totalCost: 1 },
      ],
      exclusions: [{ description: "X", costImpact: 10 }],
      tradeName: "T",
    });
    expect(lines.map((l) => l.scheduledValueCents)).toEqual([33_000, 33_000, 33_001, 1_000]);
    expect(sum(lines.map((l) => l.scheduledValueCents))).toBe(100_001);
  });

  test("the remainder lands on the last base-scope line while exclusions keep their exact plugs", () => {
    const lines = buildSovLines({
      contractSumCents: 1_000_000_07,
      lineItems: [
        { item: "A", totalCost: 300 },
        { item: "B", totalCost: 300 },
        { item: "C", totalCost: 300 },
      ],
      exclusions: [
        { description: "X", costImpact: 1234.57 },
        { description: "Y", costImpact: 99.99 },
      ],
      tradeName: "T",
    });
    const base = lines.filter((l) => !l.excludedScope);
    const excluded = lines.filter((l) => l.excludedScope);
    expect(excluded.map((l) => l.scheduledValueCents)).toEqual([123_457, 9_999]);
    const baseTotal = 1_000_000_07 - 123_457 - 9_999;
    const floor = Math.floor(baseTotal / 3);
    expect(base.map((l) => l.scheduledValueCents)).toEqual([floor, floor, baseTotal - 2 * floor]);
    expect(baseTotal % 3).not.toBe(0);
    expect(lines[lines.length - 1].excludedScope).toBe(true);
    expect(sum(lines.map((l) => l.scheduledValueCents))).toBe(1_000_000_07);
  });

  test("plugs larger than the contract sum are scaled so the total still matches", () => {
    const lines = buildSovLines({
      contractSumCents: 5_000,
      lineItems: [{ item: "A", totalCost: 100 }],
      exclusions: [{ description: "X", costImpact: 100 }],
      tradeName: "T",
    });
    expect(sum(lines.map((l) => l.scheduledValueCents))).toBe(5_000);
  });

  test("a bid without line items gets a single base-scope line", () => {
    const lines = buildSovLines({ contractSumCents: 12_345, lineItems: [], exclusions: [], tradeName: "HVAC" });
    expect(lines).toEqual([
      expect.objectContaining({ lineNo: 1, scheduledValueCents: 12_345, excludedScope: false }),
    ]);
  });
});

describe("sovSourceFingerprint", () => {
  const base = {
    bidId: "bid1",
    contractSumCents: 100_000,
    lineItems: [{ item: "A", totalCost: 1000 }],
    exclusions: [{ description: "Crane", costImpact: 450 }],
    leadWeeks: 8,
  };

  test("is stable for the same inputs and changes when scope or lead time changes at the same total", () => {
    expect(sovSourceFingerprint(base)).toBe(sovSourceFingerprint({ ...base }));
    expect(sovSourceFingerprint({ ...base, exclusions: [] })).not.toBe(sovSourceFingerprint(base));
    expect(
      sovSourceFingerprint({ ...base, exclusions: [{ description: "Crane", costImpact: 450, isWaived: true }] }),
    ).not.toBe(sovSourceFingerprint(base));
    expect(sovSourceFingerprint({ ...base, leadWeeks: 12 })).not.toBe(sovSourceFingerprint(base));
    expect(sovSourceFingerprint({ ...base, bidId: "bid2" })).not.toBe(sovSourceFingerprint(base));
  });
});

describe("default milestones", () => {
  test("four milestones in order whose amounts sum exactly to the contract sum", () => {
    expect(DEFAULT_MILESTONES.map((m) => m.name)).toEqual(["Mobilization", "Rough-in", "Trim-out", "Closeout"]);
    for (const total of [0, 1, 3, 122_500_000, 123_456_789]) {
      const amounts = splitMilestoneAmounts(total);
      expect(amounts).toHaveLength(4);
      expect(sum(amounts)).toBe(total);
    }
    expect(splitMilestoneAmounts(122_500_000)).toEqual([12_250_000, 49_000_000, 42_875_000, 18_375_000]);
    expect(splitMilestoneAmounts(3)).toEqual([0, 1, 1, 1]);
  });

  test("planned dates are increasing and respect lead weeks", () => {
    const start = Date.UTC(2026, 9, 1);
    const executed = Date.UTC(2026, 9, 7, 15);
    const dates = planMilestoneDates({ projectStartMs: start, executedAtMs: executed, leadWeeks: 10, durationWeeks: 40 });
    const week = 7 * 86_400_000;
    expect(dates[0]).toBe(Date.UTC(2026, 9, 15));
    expect(dates[1]).toBe(dates[0] + 10 * week);
    expect(dates[2]).toBe(start + 30 * week);
    expect(dates[3]).toBe(start + 40 * week);
    for (let i = 1; i < 4; i++) expect(dates[i]).toBeGreaterThan(dates[i - 1]);
  });

  test("an old project start never schedules mobilization before execution", () => {
    const executed = Date.UTC(2026, 9, 7);
    const dates = planMilestoneDates({
      projectStartMs: Date.UTC(2024, 0, 1),
      executedAtMs: executed,
      leadWeeks: 0,
      durationWeeks: 0,
    });
    expect(dates[0]).toBeGreaterThan(executed);
    for (let i = 1; i < 4; i++) expect(dates[i]).toBeGreaterThan(dates[i - 1]);
  });
});

describe("computeLedgerTotals", () => {
  const ZERO = {
    billedCents: 0,
    fundedCents: 0,
    capturedCents: 0,
    capturedNotPaidCents: 0,
    paidCents: 0,
    retainageHeldCents: 0,
    retainageReleasedCents: 0,
    changeOrdersInvoicedCents: 0,
    changeOrdersPaidCents: 0,
  };

  test("a new agreement has nothing billed, funded, paid or held and the full balance", () => {
    expect(computeLedgerTotals({ contractSumCents: 122_500_000, payApps: [], payments: [], retainage: [] })).toEqual({
      ...ZERO,
      contractSumCents: 122_500_000,
      balanceCents: 122_500_000,
    });
  });

  test("counts approved pay apps, successful payouts and the retainage balance; balance = contract − (paid + held)", () => {
    const totals = computeLedgerTotals({
      contractSumCents: 1_000_000,
      payApps: [
        { status: "approved", finalApproval: { totalCents: 250_000 } },
        { status: "paid", finalApproval: { totalCents: 100_000 } },
        { status: "submitted" },
      ],
      payments: [
        { kind: "payout", status: "success", netCents: 90_000 },
        { kind: "payout", status: "pending", netCents: 5_000 },
        { kind: "funding", status: "captured", netCents: 400_000 },
      ],
      retainage: [{ deltaCents: 10_000 }, { deltaCents: 25_000 }, { deltaCents: -10_000 }],
    });
    expect(totals).toEqual({
      ...ZERO,
      contractSumCents: 1_000_000,
      billedCents: 350_000,
      paidCents: 90_000,
      retainageHeldCents: 25_000,
      balanceCents: 1_000_000 - (90_000 + 25_000),
    });
  });

  test("funded, captured, captured-not-paid (including a retried payout), retainage released and change orders", () => {
    const totals = computeLedgerTotals({
      contractSumCents: 10_000_000,
      payApps: [],
      payments: [
        {
          _id: "f1",
          kind: "funding",
          status: "voided",
          grossCents: 11_900_000,
          netCents: 11_900_000,
          capturedCents: 2_010_000,
          captures: [
            { amountCents: 1_000_000, status: "COMPLETED", releasePaymentId: "r1" },
            { amountCents: 1_000_000, status: "COMPLETED", releasePaymentId: "r2" },
            { amountCents: 10_000, status: "COMPLETED", releasePaymentId: "r3" },
          ],
        },
        { _id: "f2", kind: "funding", status: "partially_captured", grossCents: 500_000, netCents: 500_000, capturedCents: 100_000, captures: [{ amountCents: 100_000, status: "COMPLETED", releasePaymentId: "r4" }] },
        { _id: "f3", kind: "funding", status: "authorized", grossCents: 300_000, netCents: 300_000 },
        { _id: "f4", kind: "funding", status: "expired", grossCents: 700_000, netCents: 700_000 },
        // r1 failed then its retry r1b succeeded; r2 paid; r3 unclaimed; r4 pending.
        { _id: "r1", kind: "payout", status: "failed", grossCents: 1_000_000, netCents: 900_000 },
        { _id: "r1b", kind: "payout", status: "success", grossCents: 1_000_000, netCents: 900_000, retryOfPaymentId: "r1" },
        { _id: "r2", kind: "payout", status: "success", grossCents: 1_000_000, netCents: 900_000 },
        { _id: "r3", kind: "payout", status: "unclaimed", grossCents: 10_000, netCents: 9_000 },
        { _id: "r4", kind: "payout", status: "pending", grossCents: 100_000, netCents: 90_000 },
        { _id: "rr1", kind: "retainage_release", status: "success", grossCents: 50_000, netCents: 50_000 },
      ],
      retainage: [
        { deltaCents: 100_000, paymentId: "r1b" },
        { deltaCents: 100_000, paymentId: "r2" },
        { deltaCents: 1_000, paymentId: "r3" },
        { deltaCents: 10_000, paymentId: "r4" },
        { deltaCents: -50_000, paymentId: "rr1" },
      ],
      changeOrders: [
        { status: "invoiced", amountCents: 250_000 },
        { status: "paid", amountCents: 100_000 },
        { status: "draft", amountCents: 999 },
      ],
    });
    expect(totals).toEqual({
      contractSumCents: 10_000_000,
      billedCents: 0,
      fundedCents: 400_000 + 300_000,
      capturedCents: 2_110_000,
      capturedNotPaidCents: 10_000 + 100_000,
      paidCents: 900_000 + 900_000 + 50_000,
      retainageHeldCents: 161_000,
      retainageReleasedCents: 50_000,
      changeOrdersInvoicedCents: 250_000,
      changeOrdersPaidCents: 100_000,
      balanceCents: 10_000_000 - (1_850_000 + 161_000),
    });
  });
});
