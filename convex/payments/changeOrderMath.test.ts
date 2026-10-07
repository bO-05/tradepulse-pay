import { describe, expect, test } from "vitest";
import {
  buildInvoiceBody,
  canMoveChangeOrder,
  changeOrderLabel,
  changeOrderStatusFromInvoice,
  invoiceIdFromCreateResponse,
  payerViewUrlFor,
} from "./changeOrderMath";

describe("change order math", () => {
  test("labels pad the number", () => {
    expect(changeOrderLabel(1)).toBe("CO-001");
    expect(changeOrderLabel(42)).toBe("CO-042");
    expect(changeOrderLabel(1234)).toBe("CO-1234");
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

  test("paid and cancelled are terminal", () => {
    expect(canMoveChangeOrder("invoiced", "paid")).toBe(true);
    expect(canMoveChangeOrder("draft", "invoiced")).toBe(true);
    expect(canMoveChangeOrder("paid", "invoiced")).toBe(false);
    expect(canMoveChangeOrder("paid", "cancelled")).toBe(false);
    expect(canMoveChangeOrder("cancelled", "paid")).toBe(false);
    expect(canMoveChangeOrder("invoiced", "invoiced")).toBe(false);
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

  test("invoice body bills the owner the exact amount", () => {
    const body = buildInvoiceBody({
      number: 1,
      description: "Add 4 floor boxes",
      amountCents: 250_000,
      recipientEmail: "owner@sandbox.test",
      agreementNumber: "SA-0001",
      projectTitle: "Domain Tower B",
      subcontractorName: "Rosendin Electric, Inc.",
    });
    expect(body.primary_recipients[0].billing_info.email_address).toBe("owner@sandbox.test");
    expect(body.detail.currency_code).toBe("USD");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      name: "Change order CO-001",
      description: "Add 4 floor boxes",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "2500.00" },
    });
    expect(body).not.toHaveProperty("invoicer");
  });
});
