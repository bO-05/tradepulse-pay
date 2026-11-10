// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ProjectMoneyStrip } from "./ProjectMoneyStrip";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

type Money = FunctionReturnType<typeof api.billing.projectMoney.getProjectMoney>;
type Kind = "residential" | "commercial";
type Scope = "project" | "portfolio";

const PROJECT_ID = "project_lopez";
const AGREEMENT_ID = "agreement_ortiz";
const PAY_APP_ID = "pay_app_ortiz";

function money({
  kind = "residential",
  scope = "project",
  collected = 360_000,
  collectedWithChangeOrders,
  paidToSubs = 380_000,
  retainage = 20_000,
  ownerRetainage = 40_000,
  owed = 0,
  owedReceipt = false,
}: {
  kind?: Kind;
  scope?: Scope;
  collected?: number;
  collectedWithChangeOrders?: number;
  paidToSubs?: number;
  retainage?: number;
  ownerRetainage?: number;
  owed?: number;
  owedReceipt?: boolean;
} = {}): Money {
  const project = {
    projectId: PROJECT_ID,
    projectTitle: "Lopez Kitchen Remodel",
    projectKind: kind,
    ownerRetainageBps: kind === "residential" ? 1_000 : null,
  };
  return {
    scope: {
      kind: scope,
      projectId: scope === "project" ? PROJECT_ID : null,
      projectTitle: scope === "project" ? "Lopez Kitchen Remodel" : null,
      projectKind: scope === "project" ? kind : null,
      projects: [project],
    },
    collectedFromOwnerCents: collected,
    collectedFromOwnerInclChangeOrdersCents: collectedWithChangeOrders ?? collected,
    paidToSubsCents: paidToSubs,
    retainageHeldCents: retainage,
    ownerRetainageHeldCents: ownerRetainage,
    owedThisWeekCents: owed,
    receipts: {
      ownerPayApps: collected
        ? [
            {
              projectId: PROJECT_ID,
              ownerPayAppId: "owner_pay_app_lopez",
              applicationNo: 1,
              amountCents: collected,
              retainageCents: 40_000,
              paypalInvoiceId: "INV2-5ZNS-USY8-KBFD-L3B9",
              paidAt: 1_794_156_104_483,
            },
          ]
        : [],
      payouts: paidToSubs
        ? [
            {
              projectId: PROJECT_ID,
              agreementId: AGREEMENT_ID,
              agreementNumber: "SC-22-ORTIZ-0001",
              paymentId: "payment_ortiz",
              payAppId: PAY_APP_ID,
              kind: "payout" as const,
              payoutBatchId: "BATCH-ORTIZ-1",
              amountCents: paidToSubs,
              paidAt: 1_794_155_000_000,
            },
          ]
        : [],
      retainage: retainage
        ? [
            {
              projectId: PROJECT_ID,
              agreementId: AGREEMENT_ID,
              agreementNumber: "SC-22-ORTIZ-0001",
              payAppId: PAY_APP_ID,
              amountCents: retainage,
              retainageBps: 500,
            },
          ]
        : [],
      owed: owedReceipt
        ? [
            {
              projectId: PROJECT_ID,
              payAppId: PAY_APP_ID,
              agreementId: AGREEMENT_ID,
              agreementNumber: "SC-22-ORTIZ-0001",
              dueDate: "2026-11-14",
              amountCents: owed,
            },
          ]
        : [],
    },
    asOf: 1_794_200_000_000,
    weekEnd: "2026-11-15",
    truncated: false,
  } as unknown as Money;
}

function render(data: Money, projectId: string | undefined, changeOrders: Array<Record<string, unknown>> = []): string {
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  const changeOrdersQuery = getFunctionName(api.billing.changeOrders.listForProject);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === moneyQuery) return data;
    if (name === changeOrdersQuery) return { prime: { changeOrders } };
    return undefined;
  }) as never);
  return renderToStaticMarkup(<ProjectMoneyStrip projectId={projectId} />);
}

function plain(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function labels(html: string): string[] {
  return [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map((match) =>
    match[1].replace(/<[^>]*>/g, "").trim(),
  );
}

function cell(html: string, testId: string): { text: string; href: string | null; openingTag: string } {
  const match = html.match(new RegExp(`<dd[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</dd>`));
  const openingTag = html.match(new RegExp(`<dd[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
  const inner = match?.[1] ?? "";
  return {
    text: inner.replace(/<[^>]*>/g, "").trim(),
    href: /href="([^"]+)"/.exec(inner)?.[1] ?? null,
    openingTag,
  };
}

beforeEach(() => {
  vi.mocked(useQuery).mockReset();
});

describe("the project money strip values", () => {
  test("renders the five directed Lopez buckets from the query cents", () => {
    const html = render(money({ collectedWithChangeOrders: 480_000 }), PROJECT_ID);
    expect(labels(html)).toEqual([
      "Collected from homeowner",
      "Paid to subs",
      "Retainage you hold",
      "Retainage held from you",
      "Owed this week",
    ]);
    expect(cell(html, "project-money-collected").text).toBe("$4,800.00");
    expect(cell(html, "project-money-paid-subs").text).toBe("$3,800.00");
    expect(cell(html, "project-money-retainage").text).toBe("$200.00");
    expect(cell(html, "project-money-retainage-held-from-you").text).toBe("$400.00");
    expect(cell(html, "project-money-owed").text).toBe("$0.00");
    const rendered = plain(html);
    expect(rendered).toContain("5% to the sub");
    expect(rendered).toContain("$400.00 at 10% from the homeowner");
    expect(html).toContain('data-testid="project-money-owner-retainage"');
    expect(cell(html, "project-money-collected").openingTag).toContain("text-2xl");
    expect(cell(html, "project-money-collected").openingTag).toContain("tabular-nums");
    expect(html).toContain('data-testid="project-money-strip"');
    expect(plain(html)).toContain("Money on this job · Lopez Kitchen Remodel");
    expect(plain(html)).toContain("Collected from the homeowner, paid to subs, both retainage directions and owed this week.");
  });
});

describe("residential and commercial wording", () => {
  test("a residential job says Collected from homeowner and Draw in its receipts", () => {
    const html = render(money(), PROJECT_ID);
    expect(labels(html)[0]).toBe("Collected from homeowner");
    expect(plain(html)).toContain("From 1 paid draw.");
    expect(plain(html)).toContain("Draw #1");
    expect(labels(html)).not.toContain("Collected from owner");
  });

  test("a commercial job keeps its existing labels and never uses Draw", () => {
    const html = render(money({ kind: "commercial", collectedWithChangeOrders: 480_000 }), PROJECT_ID);
    expect(labels(html)).toEqual([
      "Collected from owner",
      "Paid to subs",
      "Retainage held",
      "Retainage held from you",
      "Owed this week",
    ]);
    // The additive residential collection field does not change the established commercial bucket.
    expect(cell(html, "project-money-collected").text).toBe("$3,600.00");
    expect(plain(html)).toContain("Money on this job");
    expect(plain(html)).not.toContain("Money on this job · Lopez Kitchen Remodel");
    expect(plain(html)).toContain("Collected from the owner, paid to subs, retainage held and owed this week.");
    expect(plain(html)).toContain("Owner pay app #1");
    expect(plain(html)).not.toContain("homeowner");
    expect(plain(html)).not.toContain("Retainage you hold");
    expect(plain(html)).not.toMatch(/\bDraws?\b/);
  });

  test("the portfolio strip is labeled across the GC's jobs and uses the neutral plural", () => {
    const html = render(money({ scope: "portfolio" }), undefined);
    expect(labels(html)[0]).toBe("Collected from owners");
    expect(labels(html)).not.toContain("Collected from homeowner");
    expect(labels(html)).not.toContain("Collected from owner");
    expect(plain(html)).toContain("Money across your jobs");
    expect(plain(html)).toContain("Across every job where you are the general contractor");
    expect(plain(html)).toContain("including the separate commercial reference job");
    expect(plain(html)).toContain("Lopez Kitchen Remodel · Owner pay app #1");
  });
});

describe("receipt rows read as real records", () => {
  test("a seeded guided-demo receipt hides the A401 number and the judge-demo title", () => {
    const data = money({ scope: "portfolio" });
    data.scope.projects[0].projectTitle = "Demo · TradePulse Pay judge demo 20261108-13";
    data.receipts.payouts[0].agreementNumber = "A401-DEMO-PAY-20261101-02";
    const html = render(data, undefined);
    expect(plain(html)).toContain("Sandbox run 20261108-13");
    expect(plain(html)).toContain("Sandbox subcontract");
    expect(plain(html)).not.toContain("A401-");
    expect(plain(html)).not.toContain("judge demo");
  });
});

describe("each number links to its receipts", () => {
  test("all five cells link to their receipt surfaces", () => {
    const html = render(money({ owed: 400_000, owedReceipt: true }), PROJECT_ID);
    expect(cell(html, "project-money-collected").href).toBe("#/owner-pay-apps");
    expect(cell(html, "project-money-paid-subs").href).toBe(`#/payments/${AGREEMENT_ID}`);
    expect(cell(html, "project-money-retainage").href).toBe("#/billing/retainage");
    expect(cell(html, "project-money-retainage-held-from-you").href).toBe("#/billing/owner-billing");
    expect(cell(html, "project-money-owed").href).toBe("#/billing");

    // The receipt rows behind the numbers link to the ledger, retainage rows and the pay app itself.
    expect(html).toContain(`href="#/payments/${AGREEMENT_ID}"`);
    expect(html).toContain('href="#/billing/retainage"');
    expect(html).toContain(`href="#/pay-apps/${PAY_APP_ID}"`);
    expect(html).toContain('href="#/billing/owner-billing"');
  });

  test("homeowner collection links to the paid draw and paid change order without counting drafts", () => {
    const html = render(money({ collectedWithChangeOrders: 480_000 }), PROJECT_ID, [
      {
        _id: "co_paid",
        status: "paid",
        label: "CO-1",
        title: "Add under-cabinet lighting",
        amountCents: 120_000,
        paypalInvoiceId: "INV2-CO-PAID",
        paidAt: 1_794_156_105_000,
      },
      {
        _id: "co_draft",
        status: "draft",
        label: "CO-2",
        title: "Unpaid later work",
        amountCents: 999_000,
        paypalInvoiceId: null,
        paidAt: null,
      },
    ]);
    expect(cell(html, "project-money-collected").text).toBe("$4,800.00");
    expect(plain(html)).toContain("From 1 paid draw and 1 paid change order.");
    expect(html).toContain('href="#/change-orders/co_paid"');
    expect(plain(html)).toContain("Add under-cabinet lighting");
    expect(plain(html)).toContain("$1,200.00");
    expect(html).not.toContain('href="#/change-orders/co_draft"');
    expect(plain(html)).not.toContain("Unpaid later work");
  });
});

describe("zero buckets explain the next step", () => {
  test("owed this week shows one sentence and one action beside $0.00", () => {
    const html = render(money(), PROJECT_ID);
    expect(cell(html, "project-money-owed").text).toBe("$0.00");
    expect(plain(html)).toContain("No approved pay app is due this week.");
    expect(plain(html)).toContain("Open billing");
    expect(html).toContain('href="#/billing"');
  });

  test("a residential job with no paid draw says what to do instead of a bare $0.00", () => {
    const html = render(money({ collected: 0 }), PROJECT_ID);
    expect(cell(html, "project-money-collected").text).toBe("$0.00");
    expect(plain(html)).toContain("No draw has been paid yet.");
    expect(plain(html)).toContain("Open draws");
    expect(html).toContain('href="#/owner-pay-apps"');
  });

  test("zero owner retainage explains the next step in its own cell", () => {
    const html = render(money({ ownerRetainage: 0 }), PROJECT_ID);
    expect(cell(html, "project-money-retainage-held-from-you").text).toBe("$0.00");
    expect(plain(html)).toContain("No retainage is held from you yet.");
    expect(plain(html)).toContain("Open owner billing");
    expect(cell(html, "project-money-retainage-held-from-you").href).toBe("#/billing/owner-billing");
  });

  test("a commercial job with no payment uses commercial words in the zero state", () => {
    const html = render(money({ kind: "commercial", collected: 0, paidToSubs: 0, retainage: 0, ownerRetainage: 0 }), PROJECT_ID);
    expect(plain(html)).toContain("No pay app has been paid yet.");
    expect(plain(html)).toContain("No subcontractor payout has succeeded yet.");
    expect(plain(html)).toContain("No subcontract retainage is held yet.");
    expect(plain(html)).not.toMatch(/\bDraws?\b/);
  });
});
