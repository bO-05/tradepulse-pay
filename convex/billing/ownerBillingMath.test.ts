import { describe, expect, test } from "vitest";
import {
  canMoveOwnerPayApp,
  changeOrderLineLabel,
  gcEntryErrors,
  ownerG702,
  ownerInvoiceReference,
  ownerLineFigures,
  ownerPayAppReadyTitle,
  ownerStatusFromInvoice,
  pendingSubPayAppsNote,
  tradeLineFromToDate,
  tradeLineLabel,
  type OwnerLine,
} from "./ownerBillingMath";

const line = (over: Partial<OwnerLine>): OwnerLine => ({
  key: "k",
  kind: "gc",
  description: "Line",
  scheduledValueCents: 0,
  previousWorkCents: 0,
  previousStoredCents: 0,
  workThisPeriodCents: 0,
  storedCents: 0,
  retainageBps: 500,
  ...over,
});

describe("owner pay app 1 of the worked example", () => {
  const electrical = line({
    key: "trade:a",
    kind: "trade",
    description: tradeLineLabel("Electrical", "26 00 00", "Eastbay Electric"),
    scheduledValueCents: 17_240_000,
    ...tradeLineFromToDate({ toDateCents: 4_341_260, storedToDateCents: 1_800_000, previousWorkCents: 0, previousStoredCents: 0 }),
  });
  const lines = [
    electrical,
    line({ key: "gc:1", description: "General conditions", scheduledValueCents: 9_600_000, workThisPeriodCents: 800_000 }),
    line({ key: "gc:2", description: "GC fee", scheduledValueCents: 6_000_000 }),
    line({ key: "gc:3", description: "Insurance", scheduledValueCents: 1_200_000 }),
  ];

  test("the Electrical line is rolled up as E 25,412.60, F 18,000.00, G 43,412.60 with retainage 2,170.63", () => {
    expect(electrical.description).toBe("Electrical (26 00 00) – Eastbay Electric");
    expect(electrical.workThisPeriodCents).toBe(2_541_260);
    expect(electrical.storedCents).toBe(1_800_000);
    const f = ownerLineFigures(electrical);
    expect(f.totalCents).toBe(4_341_260);
    expect(f.retainageCents).toBe(217_063);
  });

  test("G702 totals are exact to the cent", () => {
    const s = ownerG702(lines, { originalContractSumCents: 124_000_000, netChangeOrdersCents: 0, previousCertificatesCents: 0 });
    expect(s).toMatchObject({
      originalContractSumCents: 124_000_000,
      netChangeOrdersCents: 0,
      contractSumToDateCents: 124_000_000,
      completedAndStoredCents: 5_141_260,
      retainageCents: 257_063,
      earnedLessRetainageCents: 4_884_197,
      previousCertificatesCents: 0,
      currentPaymentDueCents: 4_884_197,
      balanceToFinishInclRetainageCents: 119_115_803,
    });
  });

  test("owner pay app 2 carries D from app 1 and the approved prime CO into the contract sum", () => {
    const pco = line({ key: "pco:1", kind: "change_order", description: changeOrderLineLabel(1, "Dental chair circuits incl. GC markup"), scheduledValueCents: 997_500 });
    const electrical2 = line({
      ...electrical,
      ...tradeLineFromToDate({ toDateCents: 9_043_750, storedToDateCents: 1_550_000, previousWorkCents: 2_541_260, previousStoredCents: 1_800_000 }),
    });
    expect(electrical2.workThisPeriodCents).toBe(9_043_750 - 1_550_000 - 2_541_260);
    const s = ownerG702([electrical2, pco], { originalContractSumCents: 124_000_000, netChangeOrdersCents: 997_500, previousCertificatesCents: 4_884_197 });
    expect(pco.description).toBe("PCO #1 – Dental chair circuits incl. GC markup");
    expect(s.contractSumToDateCents).toBe(124_997_500);
    expect(s.previousCertificatesCents).toBe(4_884_197);
  });
});

describe("GC line entry", () => {
  test("an amount above the line's remaining balance is refused like a sub line", () => {
    const errors = gcEntryErrors(
      [line({ key: "gc:1", scheduledValueCents: 100_000, previousWorkCents: 60_000, workThisPeriodCents: 50_000 })],
      () => 1,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/^Line 1: at most \$400\.00 remains; this is \$100\.00 over 100% of the scheduled value\.$/);
  });

  test("negative and fractional cents are refused; trade lines are never checked as GC entries", () => {
    expect(gcEntryErrors([line({ scheduledValueCents: 100, workThisPeriodCents: -1 })], () => 2)[0].message).toMatch(/cannot be negative/);
    expect(gcEntryErrors([line({ scheduledValueCents: 100, workThisPeriodCents: 1.5 })], () => 2)[0].message).toMatch(/whole cents/);
    expect(gcEntryErrors([line({ kind: "trade", scheduledValueCents: 100, workThisPeriodCents: 500 })], () => 1)).toEqual([]);
  });
});

describe("labels and lifecycle", () => {
  test("texts", () => {
    expect(pendingSubPayAppsNote(0)).toBeNull();
    expect(pendingSubPayAppsNote(1)).toBe("1 sub pay app not yet approved");
    expect(pendingSubPayAppsNote(2)).toBe("2 sub pay apps not yet approved");
    expect(ownerInvoiceReference("Harbor Point Dental Office TI", 1)).toBe("Harbor Point Dental Office TI – Application #1");
    expect(ownerPayAppReadyTitle(1, 4_884_197)).toBe("Owner pay app #1 ready – $48,841.97");
  });

  test("invoice statuses only move forward", () => {
    expect(ownerStatusFromInvoice("SENT")).toBe("approved_invoiced");
    expect(ownerStatusFromInvoice("MARKED_AS_PAID")).toBe("paid");
    expect(ownerStatusFromInvoice("DRAFT")).toBeNull();
    expect(canMoveOwnerPayApp("approved", "approved_invoiced")).toBe(true);
    expect(canMoveOwnerPayApp("paid", "approved_invoiced")).toBe(false);
    expect(canMoveOwnerPayApp("draft", "approved")).toBe(false);
    expect(canMoveOwnerPayApp("changes_requested", "submitted_to_owner")).toBe(true);
  });
});
