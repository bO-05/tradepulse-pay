// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ToastProvider } from "../ui";
import { OwnerPayAppsPage } from "./OwnerBilling";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
  useMutation: vi.fn(),
  useConvex: vi.fn(() => ({ query: async () => null })),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => null }));

const LOPEZ = "project_lopez";
const COMMERCIAL = "project_commercial";
const DRAW = "draw_1";
type Kind = "residential" | "commercial";
type DrawStatus = "submitted_to_owner" | "paid";

/** The demo owner's portfolio: the commercial guided-demo job is newest, Lopez is residential. */
function projects(portfolio: "mixed" | Kind = "mixed") {
  const commercial = { _id: COMMERCIAL, title: "Demo · TradePulse Pay judge demo 20261108-13", projectKind: "commercial" as const, partyRole: "owner" as const };
  const residential = { _id: LOPEZ, title: "Lopez Kitchen Remodel", projectKind: "residential" as const, partyRole: "owner" as const };
  return portfolio === "commercial" ? [commercial] : [commercial, residential];
}

function list(kind: Kind) {
  return {
    projectId: kind === "residential" ? LOPEZ : COMMERCIAL,
    projectTitle: kind === "residential" ? "Lopez Kitchen Remodel" : "Commercial tower",
    projectKind: kind,
    readOnlyReference: kind === "residential",
    party: "owner" as const,
    retainageBps: 1_000,
    contractValueCents: 8_650_000,
    primeRetainageHeldCents: 40_000,
    create: null,
    rows: [
      {
        _id: DRAW,
        applicationNo: 1,
        periodEnd: "2026-10-15",
        status: "paid" as const,
        currentPaymentDueCents: 360_000,
      },
    ],
  };
}

function draw(kind: Kind, status: DrawStatus) {
  const canDecide = status === "submitted_to_owner";
  const paid = status === "paid";
  return {
    _id: DRAW,
    projectId: kind === "residential" ? LOPEZ : COMMERCIAL,
    projectTitle: kind === "residential" ? "Lopez Kitchen Remodel" : "Commercial tower",
    projectKind: kind,
    readOnlyReference: kind === "residential",
    party: "owner" as const,
    applicationNo: 1,
    status,
    periodEnd: "2026-10-15",
    retainageBps: 1_000,
    percentCompleteHundredths: 462,
    figures: {
      originalContractSumCents: 8_650_000,
      netChangeOrdersCents: 0,
      contractSumToDateCents: 8_650_000,
      completedAndStoredCents: 400_000,
      earnedLessRetainageCents: 360_000,
      previousCertificatesCents: 0,
      retainageCents: 40_000,
      currentPaymentDueCents: 360_000,
      balanceToFinishInclRetainageCents: 8_290_000,
    },
    lines: [],
    controls: {
      edit: false,
      submit: false,
      refresh: false,
      delete: false,
      approve: canDecide,
      requestChanges: canDecide,
      sendInvoice: false,
      refreshStatus: false,
    },
    pendingNote: null,
    refresh: null,
    directlyInvoicedChangeOrders: [],
    history: [
      { status: "submitted_to_owner", at: 1_794_156_000_000, byName: "Bayview Remodeling", comment: null },
      { status: paid ? "paid" : "approved_invoiced", at: 1_794_156_100_000, byName: "Dana Lopez", comment: null },
    ],
    changesRequestedComment: null,
    paypalInvoiceId: paid ? "INV2-5ZNS-USY8-KBFD-L3B9" : null,
    payerViewUrl: paid ? "https://www.sandbox.paypal.com/invoice/payerView/details/INV2-5ZNS-USY8-KBFD-L3B9" : null,
    paypalInvoiceStatus: paid ? "PAID" : null,
    recipientEmail: "owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com",
    invoiceBlockedReason: null,
    error: null,
  } as never;
}

function routeQueries(kind: Kind, status: DrawStatus, portfolio: "mixed" | Kind = "mixed") {
  const projectsQuery = getFunctionName(api.billing.ownerPayApps.ownerBillingProjects);
  const listQuery = getFunctionName(api.billing.ownerPayApps.listOwnerPayApps);
  const detailQuery = getFunctionName(api.billing.ownerPayApps.getOwnerPayApp);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === projectsQuery) return projects(portfolio);
    if (name === listQuery) return list(kind);
    if (name === detailQuery) return draw(kind, status);
    return undefined;
  }) as never);
}

function renderPage() {
  return renderToStaticMarkup(
    <ToastProvider>
      <OwnerPayAppsPage />
    </ToastProvider>,
  );
}

/** Visible words, not `data-status` codes or class names. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function primaryCount(html: string): number {
  return (html.match(/bg-accent text-accent-fg/g) ?? []).length;
}

beforeEach(() => {
  vi.mocked(useAction).mockReturnValue((async () => undefined) as never);
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("owner draw screen", () => {
  test("leads with the Lopez draw even though the commercial demo job is newer", () => {
    routeQueries("residential", "submitted_to_owner");
    const html = renderPage();
    expect(text(html)).toContain("Draws");
    expect(html.indexOf("Lopez Kitchen Remodel")).toBeLessThan(html.indexOf("Demo · TradePulse Pay judge demo 20261108-13"));
  });

  test("shows the money trail and the current payment due as the largest figure", () => {
    routeQueries("residential", "submitted_to_owner");
    const html = renderPage();
    expect(html).toContain('data-testid="owner-draw-money-trail"');
    expect(html).toContain('data-testid="owner-draw-payment-due"');
    expect(html).toMatch(/data-testid="owner-draw-payment-due"[^>]*text-3xl[^>]*>?\$3,600\.00/);
    const rendered = text(html);
    expect(rendered).toContain("Current payment due");
    expect(rendered).toContain("Contract to date");
    expect(rendered).toContain("Work completed");
    expect(rendered).toContain("Retainage held");
    expect(rendered).toContain("Previous draws");
    expect(rendered).toContain("10% on each line");
    expect(rendered).toContain("Waiting for your approval");
  });

  test("a submitted draw has one primary Approve and a secondary Request changes", () => {
    routeQueries("residential", "submitted_to_owner");
    const html = renderPage();
    expect(html).toContain('data-testid="owner-pay-app-approve"');
    expect(html).toContain('data-testid="owner-pay-app-request-changes"');
    expect(primaryCount(html)).toBe(1);
    const approveTag = html.slice(html.indexOf('data-testid="owner-pay-app-approve"') - 400, html.indexOf('data-testid="owner-pay-app-approve"'));
    expect(approveTag).toContain("bg-accent text-accent-fg");
    const requestTag = html.slice(html.indexOf('data-testid="owner-pay-app-request-changes"') - 400, html.indexOf('data-testid="owner-pay-app-request-changes"'));
    expect(requestTag).not.toContain("bg-accent text-accent-fg");
  });

  test("a paid draw states the word Paid and makes the PayPal invoice the one primary action", () => {
    routeQueries("residential", "paid");
    const html = renderPage();
    const rendered = text(html);
    expect(rendered).toContain("Paid");
    expect(html).toContain('data-status="paid"');
    expect(html).not.toContain(">paid<");
    expect(rendered).not.toContain("submitted_to_owner");
    expect(rendered).toContain("Paid by PayPal");
    expect(primaryCount(html)).toBe(1);
    expect(html).toContain('data-testid="owner-invoice-payer-link"');
    const linkTag = html.slice(html.indexOf('data-testid="owner-invoice-payer-link"') - 500, html.indexOf('data-testid="owner-invoice-payer-link"'));
    expect(linkTag).toContain("bg-accent text-accent-fg");
    expect(linkTag).toContain("min-h-touch");
    expect(rendered).not.toContain("owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com");
    expect(rendered).toContain("[demo inbox]@example.com");
  });

  test("the status pill uses words and the invoice status is never the raw code", () => {
    routeQueries("residential", "paid");
    const rendered = text(renderPage());
    expect(rendered).not.toContain("PAID");
    expect(rendered).not.toContain("approved_invoiced");
    expect(rendered).toContain("Draw #1");
  });

  test("a commercial draw keeps its AIA words and shows the reference badge", () => {
    routeQueries("commercial", "submitted_to_owner", "commercial");
    const rendered = text(renderPage());
    expect(rendered).toContain("Owner pay apps");
    expect(rendered).toContain("Completed & stored");
    expect(rendered).toContain("Previous payments");
    expect(rendered).toContain("Commercial reference job");
    expect(rendered).not.toContain("Draw breakdown");
  });
});
