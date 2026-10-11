import { describe, expect, test } from "vitest";
import {
  DECIDED_EDIT_MESSAGE,
  SUBMITTED_EDIT_MESSAGE,
  buildInvoiceBody,
  canMoveChangeOrder,
  changeOrderEditBlock,
  changeOrderFieldErrors,
  changeOrderLabel,
  changeOrderScopeOf,
  changeOrderStatusFromInvoice,
  contractSumBreakdown,
  deductiveFloorProblem,
  invoiceIdFromCreateResponse,
  payerViewUrlFor,
} from "./changeOrderMath";

describe("change order math", () => {
  test("labels: CO #n for subcontract, PCO #n for prime; rows without a scope are prime", () => {
    expect(changeOrderLabel(1)).toBe("CO #1");
    expect(changeOrderLabel(12, "subcontract")).toBe("CO #12");
    expect(changeOrderLabel(1, "prime")).toBe("PCO #1");
    expect(changeOrderScopeOf({})).toBe("prime");
    expect(changeOrderScopeOf({ scope: "subcontract" })).toBe("subcontract");
  });

  test("invoice statuses map to change order statuses", () => {
    expect(changeOrderStatusFromInvoice("PAID")).toBe("paid");
    expect(changeOrderStatusFromInvoice("MARKED_AS_PAID")).toBe("paid");
    expect(changeOrderStatusFromInvoice("CANCELLED")).toBe("cancelled");
    expect(changeOrderStatusFromInvoice("SENT")).toBe("invoiced");
    expect(changeOrderStatusFromInvoice("PARTIALLY_PAID")).toBe("invoiced");
    expect(changeOrderStatusFromInvoice("DRAFT")).toBeNull();
    expect(changeOrderStatusFromInvoice("REFUNDED")).toBeNull();
    expect(changeOrderStatusFromInvoice(undefined)).toBeNull();
  });

  test("lifecycle: draft ⇄ submitted → approved | rejected; only approved COs are invoiced; decided COs are terminal", () => {
    expect(canMoveChangeOrder("draft", "submitted")).toBe(true);
    expect(canMoveChangeOrder("submitted", "draft")).toBe(true);
    expect(canMoveChangeOrder("submitted", "approved")).toBe(true);
    expect(canMoveChangeOrder("submitted", "rejected")).toBe(true);
    expect(canMoveChangeOrder("approved", "invoiced")).toBe(true);
    expect(canMoveChangeOrder("invoiced", "paid")).toBe(true);
    expect(canMoveChangeOrder("draft", "invoiced")).toBe(false);
    expect(canMoveChangeOrder("submitted", "invoiced")).toBe(false);
    expect(canMoveChangeOrder("rejected", "approved")).toBe(false);
    expect(canMoveChangeOrder("approved", "draft")).toBe(false);
    expect(canMoveChangeOrder("paid", "invoiced")).toBe(false);
    expect(canMoveChangeOrder("paid", "cancelled")).toBe(false);
    expect(canMoveChangeOrder("cancelled", "paid")).toBe(false);
    expect(canMoveChangeOrder("invoiced", "invoiced")).toBe(false);
  });

  test("edit blocks: drafts edit freely, submitted must be withdrawn, decided are immutable", () => {
    expect(changeOrderEditBlock("draft")).toBeNull();
    expect(changeOrderEditBlock("submitted")).toBe(SUBMITTED_EDIT_MESSAGE);
    expect(changeOrderEditBlock("approved")).toBe("Approved change orders cannot be edited – create a new change order");
    expect(changeOrderEditBlock("invoiced")).toBe(DECIDED_EDIT_MESSAGE.approved);
    expect(changeOrderEditBlock("paid")).toBe(DECIDED_EDIT_MESSAGE.approved);
    expect(changeOrderEditBlock("rejected")).toBe(DECIDED_EDIT_MESSAGE.rejected);
  });

  test("field checks: title required, non-zero whole cents, negative allowed", () => {
    expect(changeOrderFieldErrors({ title: "", description: "", amountCents: 875_000 }).title).toBe("Enter a title for the change order.");
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: 0 }).amountCents).toMatch(/\$0\.00/);
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: 10.5 }).amountCents).toMatch(/whole cents/);
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: null }).amountCents).toBeDefined();
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: -120_000 })).toEqual({});
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: 1, scheduleDays: 1.5 }).scheduleDays).toBeDefined();
    expect(changeOrderFieldErrors({ title: "x", description: "", amountCents: 1, scheduleDays: 3 })).toEqual({});
  });

  test("worked example: CO #1 +$8,750.00 takes $172,400.00 to $181,150.00; CO #2 −$1,200.00 to $179,950.00", () => {
    expect(contractSumBreakdown(17_240_000, [875_000])).toEqual({
      originalCents: 17_240_000,
      additionsCents: 875_000,
      deductionsCents: 0,
      netChangeCents: 875_000,
      toDateCents: 18_115_000,
    });
    expect(contractSumBreakdown(17_240_000, [875_000, -120_000])).toEqual({
      originalCents: 17_240_000,
      additionsCents: 875_000,
      deductionsCents: -120_000,
      netChangeCents: 755_000,
      toDateCents: 17_995_000,
    });
    expect(contractSumBreakdown(124_000_000, [997_500]).toDateCents).toBe(124_997_500);
  });

  test("deductive floor: a CO may not take the contract sum to date below the amount already billed", () => {
    expect(deductiveFloorProblem({ contractSumToDateCents: 17_995_000, amountCents: 875_000, billedCents: 9_043_750 })).toBeNull();
    expect(deductiveFloorProblem({ contractSumToDateCents: 18_115_000, amountCents: -120_000, billedCents: 9_043_750 })).toBeNull();
    const problem = deductiveFloorProblem({ contractSumToDateCents: 17_995_000, amountCents: -9_000_000, billedCents: 9_043_750 });
    expect(problem).toContain("$89,950.00");
    expect(problem).toContain("$90,437.50");
  });

  test("deductive floor: the contract sum never goes below $0.00, even when the billed amount is a net credit", () => {
    const problem = deductiveFloorProblem({ contractSumToDateCents: 123_880_000, amountCents: -123_930_000, billedCents: -120_000 });
    expect(problem).toContain("-$500.00");
    expect(problem).toContain("$0.00");
    expect(deductiveFloorProblem({ contractSumToDateCents: 123_880_000, amountCents: -123_880_000, billedCents: -120_000 })).toBeNull();
  });

  test("invoice id is read from the self link of the 201 body", () => {
    expect(
      invoiceIdFromCreateResponse({
        rel: "self",
        href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-ABCD-EFGH-IJKL-MNOP",
        method: "GET",
      }),
    ).toBe("INV2-ABCD-EFGH-IJKL-MNOP");
    expect(
      invoiceIdFromCreateResponse({ links: [{ rel: "self", href: "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-X" }] }),
    ).toBe("INV2-X");
    expect(invoiceIdFromCreateResponse({ id: "INV2-Y" })).toBe("INV2-Y");
    expect(invoiceIdFromCreateResponse({})).toBeNull();
    expect(invoiceIdFromCreateResponse(null)).toBeNull();
  });

  test("payer view url prefers recipient_view_url", () => {
    expect(payerViewUrlFor("INV2-A", "https://www.sandbox.paypal.com/invoice/p/#ABC")).toBe(
      "https://www.sandbox.paypal.com/invoice/p/#ABC",
    );
    expect(payerViewUrlFor("INV2-A")).toBe("https://www.sandbox.paypal.com/invoice/p/#INV2-A");
    expect(payerViewUrlFor("INV2-A", "javascript:alert(1)")).toBe("https://www.sandbox.paypal.com/invoice/p/#INV2-A");
  });

  test("invoice body bills the owner the exact amount of the prime change order", () => {
    const body = buildInvoiceBody({
      label: "PCO #1",
      title: "Dental chair circuits incl. GC markup",
      description: "Six dedicated 20A circuits",
      amountCents: 997_500,
      recipientEmail: "owner@sandbox.test",
      agreementNumber: null,
      projectTitle: "Harbor Point Dental Office TI",
    });
    expect(body.primary_recipients[0].billing_info.email_address).toBe("owner@sandbox.test");
    expect(body.detail.currency_code).toBe("USD");
    expect(body.detail.reference).toBe("Harbor Point Dental Office TI PCO #1");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: "Change order PCO #1: Dental chair circuits incl. GC markup",
      description: "Six dedicated 20A circuits",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "9975.00" },
    });
    expect(body).not.toHaveProperty("invoicer");
  });
});
