import { describe, expect, test } from "vitest";
import { termsForKind } from "./terms";

const BANNED = [
  "Materials stored",
  "Less previous certificates for payment",
  "certificates for payment",
  "Prime continuation sheet",
  "Prime",
  "G702",
  "G703",
  "AIA",
  "CSI",
  "CSI MasterFormat",
  "Div 26",
  "tranche",
];

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("residential vocabulary", () => {
  const terms = termsForKind("residential");

  test("names the draw, its sheets, trades, signing and funded milestones", () => {
    expect(terms.kind).toBe("residential");
    expect(terms.ownerBill).toBe("Draw");
    expect(terms.ownerBills).toBe("Draws");
    expect(terms.breakdown).toBe("Draw breakdown");
    expect(terms.summary).toBe("Draw summary");
    expect(terms.trades).toBe("Trades");
    expect(terms.trade).toBe("Trade");
    expect(terms.signed).toBe("Signed");
    expect(terms.fundedMilestone).toBe("Funded milestone");
    expect(terms.fundedMilestones).toBe("Funded milestones");
    expect(terms.moneyStrip).toEqual({
      collected: "Collected from homeowner",
      subRetainage: "Retainage you hold",
      ownerRetainage: "Retainage held from you",
      description: "Collected from the homeowner, paid to subs, both retainage directions and owed this week.",
    });
    expect(terms.ledger).toEqual({
      ownerInvoicesUnpaid: "Owner change-order invoices unpaid (project income)",
      ownerIncomePaid: "Owner change-order income paid (not this subcontract)",
      ownerIncomeNote:
        "Statuses are recorded from PayPal webhooks/API responses at the time shown; this page does not re-query PayPal. Owner change-order income belongs to the project, not this subcontract's scope or balance.",
    });
    expect(terms.primePrefix).toBe("");
    expect(terms.commercialBadge).toBe(false);
  });

  test("uses four draw columns and no stored-materials row", () => {
    expect(terms.drawColumns).toEqual({
      workCompleted: "Work completed",
      previouslyPaid: "Previously paid",
      thisDraw: "This draw",
      retainage: "Retainage",
    });
    expect(terms.materialsStored).toBe("");
    expect(terms.previousCertificates).toBe("Previously paid");
  });

  test("never contains a banned commercial or AIA string", () => {
    const rendered = strings(terms);
    for (const phrase of BANNED) {
      expect(rendered.filter((value) => value.includes(phrase)), phrase).toEqual([]);
    }
  });
});

describe("commercial vocabulary", () => {
  const terms = termsForKind("commercial");

  test("keeps the pre-mission AIA wording exactly", () => {
    expect(terms.kind).toBe("commercial");
    expect(terms.ownerBill).toBe("Owner pay app");
    expect(terms.ownerBills).toBe("Owner pay apps");
    expect(terms.breakdown).toBe("Continuation sheet (G703)");
    expect(terms.summary).toBe("Application summary (G702)");
    expect(terms.materialsStored).toBe("Materials stored");
    expect(terms.previousCertificates).toBe("Less previous certificates for payment");
    expect(terms.drawColumns).toEqual({
      workCompleted: "Work completed",
      previouslyPaid: "Less previous certificates for payment",
      thisDraw: "Current payment due",
      retainage: "Retainage",
    });
    expect(terms.trades).toBe("Trade packages");
    expect(terms.signed).toBe("Executed");
    expect(terms.fundedMilestone).toBe("Tranche");
    expect(terms.fundedMilestones).toBe("Funding tranches");
    expect(terms.moneyStrip).toEqual({
      collected: "Collected from owner",
      subRetainage: "Retainage held",
      ownerRetainage: "Retainage held from you",
      description: "Collected from the owner, paid to subs, retainage held and owed this week.",
    });
    expect(terms.ledger).toEqual({
      ownerInvoicesUnpaid: "Owner prime CO invoices unpaid (project income)",
      ownerIncomePaid: "Owner prime CO income paid (not this subcontract)",
      ownerIncomeNote:
        "Statuses are recorded from PayPal webhooks/API responses at the time shown; this page does not re-query PayPal. Owner prime change-order income belongs to the project, not this subcontract's scope or balance.",
    });
    expect(terms.primePrefix).toBe("Prime ");
    expect(terms.commercialBadge).toBe(true);
    expect(terms.commercialBadgeLabel).toBe("Commercial reference job");
  });

  test("a missing kind is commercial, so a pre-mission project never flips vocabulary", () => {
    expect(termsForKind(undefined)).toEqual(terms);
    expect(termsForKind(null)).toEqual(terms);
  });
});
