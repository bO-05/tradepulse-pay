// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { ChangeOrderDetail } from "./ChangeOrderDetail";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

type Kind = "residential" | "commercial";

function changeOrder({ kind = "residential", status = "paid", invoiceStatus = "PAID", payer = true }: { kind?: Kind; status?: string; invoiceStatus?: string | null; payer?: boolean } = {}) {
  return {
    _id: "co_lopez",
    scope: "prime",
    number: 1,
    label: "PCO #1",
    title: "Add under-cabinet lighting",
    description: "Owner-requested under-cabinet lighting circuits and LED fixtures in the kitchen.",
    amountCents: 120_000,
    scheduleDays: null,
    status,
    projectId: "project_lopez",
    agreementId: null,
    agreementNumber: null,
    subcontractorName: null,
    requestedByParty: "gc",
    rejectionReason: null,
    sovLineId: null,
    sovLineNo: null,
    linkedChangeOrderId: null,
    linkedLabel: null,
    createdAt: 1_794_156_060_000,
    submittedAt: 1_794_156_142_106,
    approvedAt: 1_794_156_258_987,
    rejectedAt: null,
    judgeDemoApproval: null,
    paypalInvoiceId: "INV2-RCJ4-Z8GD-4A33-TDJC",
    paypalInvoiceStatus: invoiceStatus,
    payerViewUrl: payer ? "https://www.sandbox.paypal.com/invoice/payerView/details/INV2-RCJ4-Z8GD-4A33-TDJC" : null,
    recipientEmail: "owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com",
    error: null,
    invoicedAt: 1_794_156_263_507,
    paidAt: status === "paid" ? 1_794_156_460_680 : null,
    editBlockedReason: "This settled reference is read-only.",
    canEdit: false,
    canDelete: false,
    canSubmit: false,
    canWithdraw: false,
    canApprove: false,
    canReject: false,
    invoice: { show: false, enabled: false, reason: null },
    canRefresh: false,
    projectKind: kind,
    approvalPreview: null,
  };
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function primaryCount(html: string): number {
  return (html.match(/bg-accent text-accent-fg/g) ?? []).length;
}

beforeEach(() => {
  vi.mocked(useQuery).mockReturnValue(changeOrder() as never);
});

describe("change-order invoice screen", () => {
  test("uses the page header, cards, Money and StatusPill with the amount large", () => {
    const html = renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />);
    expect(html).toContain("<h1");
    expect(html).toContain("PCO #1 · Add under-cabinet lighting");
    expect(html).toContain('data-testid="change-order-amount"');
    expect(html).toMatch(/class="[^"]*text-3xl[^"]*"[^>]*data-testid="change-order-amount"/);
    expect(html).toContain("$1,200.00");
    expect(html).toContain('data-status="paid"');
    expect(html).toContain('data-testid="change-order-paid-state"');
    const rendered = text(html);
    expect(rendered).toContain("Paid Nov 8, 2026");
    expect(rendered).toContain("Amount");
    expect(rendered).toContain("Details");
    expect(rendered).toContain("Timeline");
    expect(rendered).toContain("PayPal invoice");
    expect(rendered).toContain("Contract change order");
  });

  test("a stored legacy run prefix is removed from the rendered title only", () => {
    vi.mocked(useQuery).mockReturnValue({ ...changeOrder(), title: "Judge demo: Add under-cabinet lighting" } as never);
    const rendered = text(renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />));
    expect(rendered).toContain("PCO #1 · Add under-cabinet lighting");
    expect(rendered).not.toContain("Judge demo");
  });

  test("the paid change order's PayPal receipt link is the primary button and the only primary action", () => {
    const html = renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />);
    expect(html).toContain('data-testid="change-order-invoice-link"');
    expect(primaryCount(html)).toBe(1);
    expect(text(html)).toContain("Open the PayPal receipt");
    expect(text(html)).not.toContain("Open the PayPal invoice");
    const linkTag = html.slice(html.indexOf('data-testid="change-order-invoice-link"') - 500, html.indexOf('data-testid="change-order-invoice-link"'));
    expect(linkTag).toContain("<a ");
    expect(linkTag).toContain("bg-accent text-accent-fg");
    expect(linkTag).toContain("min-h-touch");
    expect(linkTag).toContain('target="_blank"');
    expect(html).toContain("https://www.sandbox.paypal.com/invoice/payerView/details/INV2-RCJ4-Z8GD-4A33-TDJC");
  });

  test("statuses are plain words, never the raw code", () => {
    const html = renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />);
    const rendered = text(html);
    expect(rendered).toContain("Paid");
    expect(html).toContain('data-status="paid"');
    expect(rendered).not.toContain("PAID");
    expect(html).not.toContain(">paid<");
    expect(rendered).not.toContain("owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com");
    expect(rendered).toContain("[demo inbox]@example.com");
  });

  test("keeps the agreement, payment-recorded UTC date and invoice id", () => {
    vi.mocked(useQuery).mockReturnValue(changeOrder({ status: "paid" }) as never);
    const rendered = text(renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />));
    expect(rendered).toContain("Project-level change order");
    expect(rendered).toContain("Payment recorded");
    expect(rendered).toContain("UTC");
    expect(rendered).toContain("INV2-RCJ4-Z8GD-4A33-TDJC");
  });

  test("an approved but un-invoiced change order has no primary action", () => {
    vi.mocked(useQuery).mockReturnValue(changeOrder({ status: "invoiced", invoiceStatus: "SENT", payer: false }) as never);
    const html = renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />);
    expect(html).not.toContain('data-testid="change-order-invoice-link"');
    expect(primaryCount(html)).toBe(0);
    const rendered = text(html);
    expect(rendered).toContain("Invoiced");
    expect(rendered).toContain("Invoice sent");
    expect(rendered).not.toContain("SENT");
  });

  test("a commercial change order keeps AIA wording and the reference badge", () => {
    vi.mocked(useQuery).mockReturnValue(changeOrder({ kind: "commercial" }) as never);
    const rendered = text(renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />));
    expect(rendered).toContain("Prime contract change order");
    expect(rendered).toContain("Commercial reference job");
  });

  test("a missing change order stays on the shared not-found state", () => {
    vi.mocked(useQuery).mockReturnValue(null as never);
    const html = renderToStaticMarkup(<ChangeOrderDetail changeOrderId="co_lopez" />);
    expect(html).toContain('data-testid="not-found"');
    expect(html).toContain("does not exist or you");
  });
});
