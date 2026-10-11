import { describe, expect, test } from "vitest";
import {
  approvedWorkAndStored,
  formatPercentHundredths,
  g702Summary,
  g703Line,
  g703LineErrors,
  lineIncrementCents,
  nextBillingDate,
  nextBillingPeriod,
  previousCertificatesCents,
  retainageOf,
  type G703EntryLine,
  type G703LineInput,
} from "./g703Math";

// The Billing worked example (validation contract): Eastbay Electric, $172,400.00, 5% retainage.
const C = [800_000, 640_000, 3_150_000, 3_820_000, 4_200_000, 2_860_000, 1_270_000, 500_000];
const BPS = 500;
const ORIGINAL = 17_240_000;

function sheet(entries: Record<number, { d?: number; e?: number; f?: number }>, scheduled = C): G703LineInput[] {
  return scheduled.map((c, i) => ({
    scheduledValueCents: c,
    previousWorkCents: entries[i + 1]?.d ?? 0,
    workThisPeriodCents: entries[i + 1]?.e ?? 0,
    storedCents: entries[i + 1]?.f ?? 0,
    retainageBps: BPS,
  }));
}

describe("retainage rounding", () => {
  test("rounds half-up per line: 4,800.10 and 12,612.50 at 5%", () => {
    expect(retainageOf(480_010, 500)).toBe(24_001); // 240.005 → 240.01
    expect(retainageOf(1_261_250, 500)).toBe(63_063); // 630.625 → 630.63 (banker's rounding and truncation give 630.62)
    expect(retainageOf(2_206_250, 500)).toBe(110_313);
  });

  test("a per-line retainageBps override changes only that line", () => {
    const lines = sheet({ 1: { e: 800_000 }, 2: { e: 480_010 } });
    lines[0] = { ...lines[0], retainageBps: 0 };
    lines[1] = { ...lines[1], retainageBps: 1_000 };
    expect(g703Line(lines[0]).retainageCents).toBe(0);
    expect(g703Line(lines[1]).retainageCents).toBe(48_001); // 480.01
    expect(g702Summary(lines, { originalContractSumCents: ORIGINAL, previousCertificatesCents: 0 }).retainageCents).toBe(48_001);
  });

  test("rejects bad inputs instead of guessing", () => {
    expect(() => retainageOf(1.5, 500)).toThrow();
    expect(() => retainageOf(100, 10_001)).toThrow();
  });
});

describe("pay app 1 of the worked example", () => {
  test("version 1 as submitted: G 44,800.10, retainage 2,240.01, due 42,560.09", () => {
    const lines = sheet({ 1: { e: 800_000 }, 2: { e: 480_010 }, 3: { e: 1_400_000 }, 5: { f: 1_800_000 } });
    expect(g703Line(lines[2])).toMatchObject({ totalCents: 1_400_000, percentHundredths: 4444, balanceCents: 1_750_000 });
    expect(g703Line(lines[4])).toMatchObject({ totalCents: 1_800_000, percentHundredths: 4286, balanceCents: 2_400_000, retainageCents: 90_000 });
    expect(formatPercentHundredths(g703Line(lines[2]).percentHundredths)).toBe("44.44%");
    const s = g702Summary(lines, { originalContractSumCents: ORIGINAL, previousCertificatesCents: 0 });
    expect(s).toMatchObject({
      contractSumToDateCents: 17_240_000,
      workThisPeriodCents: 2_680_010,
      storedCents: 1_800_000,
      completedAndStoredCents: 4_480_010,
      balanceToFinishCents: 12_759_990,
      retainageCents: 224_001,
      currentPaymentDueCents: 4_256_009,
    });
  });

  test("approved as noted (line 3 at 12,612.50): the G702 summary is exact", () => {
    const lines = sheet({ 1: { e: 800_000 }, 2: { e: 480_010 }, 3: { e: 1_261_250 }, 5: { f: 1_800_000 } });
    expect(g702Summary(lines, { originalContractSumCents: ORIGINAL, previousCertificatesCents: 0 })).toEqual({
      originalContractSumCents: 17_240_000,
      netChangeOrdersCents: 0,
      contractSumToDateCents: 17_240_000,
      scheduledValueCents: 17_240_000,
      previousWorkCents: 0,
      workThisPeriodCents: 2_541_260,
      storedCents: 1_800_000,
      completedAndStoredCents: 4_341_260,
      balanceToFinishCents: 12_898_740,
      retainageCents: 217_064, // 400.00 + 240.01 + 630.63 + 900.00, not the rounded total 2,170.63
      retainageWorkCents: 127_064,
      retainageStoredCents: 90_000,
      earnedLessRetainageCents: 4_124_196,
      previousCertificatesCents: 0,
      currentPaymentDueCents: 4_124_196,
      balanceToFinishInclRetainageCents: 13_115_804,
    });
  });
});

describe("pay app 2 of the worked example", () => {
  const withCo = [...C, 875_000];
  const previous = [
    { previousTotalCents: 800_000, retainageBps: BPS },
    { previousTotalCents: 480_010, retainageBps: BPS },
    { previousTotalCents: 1_261_250, retainageBps: BPS },
    { previousTotalCents: 1_800_000, retainageBps: BPS },
  ];

  test("previous certificates equal pay app 1's total earned less retainage", () => {
    expect(previousCertificatesCents(previous)).toBe(4_124_196);
  });

  test("stored material carries forward and the summary matches to the cent", () => {
    const lines = sheet(
      {
        1: { d: 800_000 },
        2: { d: 480_010, e: 159_990 },
        3: { d: 1_261_250, e: 945_000 },
        4: { e: 1_910_000 },
        5: { e: 1_500_000, f: 600_000 },
        6: { f: 950_000 },
        9: { e: 437_500 },
      },
      withCo,
    );
    expect(g703Line(lines[4])).toMatchObject({ totalCents: 2_100_000, percentHundredths: 5000, retainageCents: 105_000 });
    expect(g703Line(lines[2])).toMatchObject({ totalCents: 2_206_250, percentHundredths: 7004, retainageCents: 110_313 });
    const s = g702Summary(lines, { originalContractSumCents: ORIGINAL, previousCertificatesCents: 4_124_196 });
    expect(s).toMatchObject({
      netChangeOrdersCents: 875_000,
      contractSumToDateCents: 18_115_000,
      previousWorkCents: 2_541_260,
      workThisPeriodCents: 4_952_490,
      storedCents: 1_550_000,
      completedAndStoredCents: 9_043_750,
      balanceToFinishCents: 9_071_250,
      retainageCents: 452_188,
      retainageWorkCents: 374_688,
      retainageStoredCents: 77_500,
      earnedLessRetainageCents: 8_591_562,
      currentPaymentDueCents: 4_467_366,
      balanceToFinishInclRetainageCents: 9_523_438,
    });
    // Line 5's increment: 15,000.00 + 6,000.00 − 18,000.00 previously stored.
    expect(lineIncrementCents({ workThisPeriodCents: 1_500_000, storedCents: 600_000, previousStoredCents: 1_800_000 })).toBe(300_000);
  });
});

describe("per-line entry rules", () => {
  const entry = (over: Partial<G703EntryLine>): G703EntryLine => ({
    sovLineId: "s",
    lineNo: 1,
    scheduledValueCents: 640_000,
    previousWorkCents: 0,
    previousStoredCents: 0,
    pendingCents: 0,
    workThisPeriodCents: 0,
    storedCents: 0,
    ...over,
  });

  test("more than 100% of a line is refused with the remaining balance and the excess", () => {
    const errors = g703LineErrors([
      entry({ lineNo: 2, previousWorkCents: 480_010, workThisPeriodCents: 160_000 }),
      entry({ lineNo: 1, scheduledValueCents: 800_000, previousWorkCents: 800_000, workThisPeriodCents: 1 }),
      entry({ lineNo: 5, scheduledValueCents: 4_200_000, workThisPeriodCents: 1_500_000, storedCents: 3_000_000 }),
    ]);
    expect(errors.map((e) => e.message)).toEqual([
      "Line 2: at most $1,599.90 remains; this is $0.10 over 100% of the scheduled value.",
      "Line 1: at most $0.00 remains; this is $0.01 over 100% of the scheduled value.",
      "Line 5: at most $42,000.00 remains; this is $3,000.00 over 100% of the scheduled value.",
    ]);
  });

  test("exactly 100% is accepted", () => {
    const l = entry({ lineNo: 2, previousWorkCents: 480_010, workThisPeriodCents: 159_990 });
    expect(g703LineErrors([l])).toEqual([]);
    expect(g703Line({ ...l, retainageBps: BPS }).percentHundredths).toBe(10_000);
  });

  test("negative amounts and non-cent values are refused", () => {
    expect(g703LineErrors([entry({ workThisPeriodCents: -1 })])[0].message).toMatch(/cannot be negative/);
    expect(g703LineErrors([entry({ storedCents: -5 })])[0].message).toMatch(/cannot be negative/);
    expect(g703LineErrors([entry({ workThisPeriodCents: 0.5 })])[0].message).toMatch(/whole cents/);
  });

  test("stored material cannot vanish without being installed", () => {
    const errors = g703LineErrors([
      entry({ lineNo: 5, scheduledValueCents: 4_200_000, previousStoredCents: 1_800_000, storedCents: 600_000, workThisPeriodCents: 0 }),
    ]);
    expect(errors[0].message).toMatch(/cannot drop below the previous application's \$18,000\.00/);
  });

  test("other pending requests count against what remains", () => {
    expect(g703LineErrors([entry({ pendingCents: 600_000, workThisPeriodCents: 50_000 })])[0].message).toMatch(/at most \$400\.00 remains/);
  });
});

describe("approved split into work and stored", () => {
  test("an approved increment keeps stored material first", () => {
    expect(approvedWorkAndStored({ previousStoredCents: 0, workThisPeriodCents: 0, storedCents: 1_800_000 }, 1_800_000)).toEqual({
      workThisPeriodCents: 0,
      storedCents: 1_800_000,
    });
    expect(approvedWorkAndStored({ previousStoredCents: 0, workThisPeriodCents: 1_400_000, storedCents: 0 }, 1_261_250)).toEqual({
      workThisPeriodCents: 1_261_250,
      storedCents: 0,
    });
    expect(approvedWorkAndStored({ previousStoredCents: 1_800_000, workThisPeriodCents: 1_500_000, storedCents: 600_000 }, 300_000)).toEqual({
      workThisPeriodCents: 1_500_000,
      storedCents: 600_000,
    });
  });
});

describe("billing periods", () => {
  test("first period runs from the project start to the billing day", () => {
    expect(nextBillingPeriod({ previousPeriodEnd: null, firstPeriodStart: "2026-10-01", billingDay: 25 })).toEqual({
      periodStart: "2026-10-01",
      periodEnd: "2026-10-25",
      dueDate: "2026-10-25",
    });
  });

  test("the next period starts the day after the previous end, with no gap or overlap", () => {
    expect(nextBillingPeriod({ previousPeriodEnd: "2026-10-25", firstPeriodStart: "2026-10-01", billingDay: 25 })).toEqual({
      periodStart: "2026-10-26",
      periodEnd: "2026-11-25",
      dueDate: "2026-11-25",
    });
    expect(nextBillingPeriod({ previousPeriodEnd: "2026-11-25", firstPeriodStart: "2026-10-01", billingDay: 20 }).dueDate).toBe("2026-12-20");
    expect(nextBillingPeriod({ previousPeriodEnd: "2026-12-25", firstPeriodStart: "2026-10-01", billingDay: 25 })).toMatchObject({
      periodStart: "2026-12-26",
      periodEnd: "2027-01-25",
    });
  });

  test("billing days outside 1-28 are refused", () => {
    expect(() => nextBillingDate("2026-10-01", 0)).toThrow();
    expect(() => nextBillingDate("2026-10-01", 29)).toThrow();
    expect(nextBillingDate("2026-10-28", 28)).toBe("2026-10-28");
  });
});
