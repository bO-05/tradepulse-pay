// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { ApprovalInbox } from "./ApprovalInbox";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn(), useAction: vi.fn() }));

const LOPEZ_ID = "project_lopez";

function portfolioMoney() {
  return {
    scope: {
      kind: "portfolio" as const,
      projectId: null,
      projectTitle: null,
      projectKind: null,
      projects: [{ projectId: LOPEZ_ID, projectTitle: "Lopez Kitchen Remodel", projectKind: "residential" }],
    },
    collectedFromOwnerCents: 360_000,
    collectedFromOwnerInclChangeOrdersCents: 360_000,
    paidToSubsCents: 1_707_040,
    retainageHeldCents: 65_760,
    ownerRetainageHeldCents: 40_000,
    owedThisWeekCents: 0,
    receipts: { ownerPayApps: [], payouts: [], retainage: [], owed: [] },
    asOf: 1_794_200_000_000,
    weekEnd: "2026-11-15",
    truncated: false,
  };
}

function lopezMoney() {
  return {
    ...portfolioMoney(),
    scope: {
      kind: "project" as const,
      projectId: LOPEZ_ID,
      projectTitle: "Lopez Kitchen Remodel",
      projectKind: "residential" as const,
      projects: [{ projectId: LOPEZ_ID, projectTitle: "Lopez Kitchen Remodel", projectKind: "residential" as const, ownerRetainageBps: 1_000 }],
    },
    collectedFromOwnerInclChangeOrdersCents: 480_000,
    paidToSubsCents: 380_000,
    retainageHeldCents: 20_000,
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    _id: "proposal_payout",
    kind: "payout",
    status: "pending",
    source: "code_policy",
    amountCents: 32_000,
    editedAmountCents: null,
    editedReason: null,
    split: { retainageCents: 3_200, netCents: 28_800 },
    rationale: "Pay the approved amount net of 10% retainage.",
    flags: [],
    licenseStatus: "active",
    milestoneName: "Mobilization",
    decidedAt: null,
    executedAt: null,
    paypalCaptureId: null,
    error: null,
    overrideLicenseHold: false,
    createdAt: 1_790_000_000_000,
    ...overrides,
  };
}

function inboxItem(overrides: Record<string, unknown> = {}) {
  return {
    readOnlyReference: false,
    projectKind: "commercial",
    payApp: {
      _id: "payapp_1",
      status: "reviewed",
      periodLabel: "Period 1",
      submittedBy: { actorType: "human", userEmail: "sub4@demo.tradepulse" },
      judgeDemoFiledBy: null,
      createdAt: 1_790_000_000_000,
      requestedTotalCents: 540_000,
      lines: [],
    },
    agreement: {
      _id: "agreement_1",
      agreementNumber: "SC-22-ORTIZ-0001",
      projectTitle: "Lopez Kitchen Remodel",
      subcontractorName: "Ortiz Plumbing",
      contractorId: "contractor_1",
      retainagePercent: 10,
    },
    contractor: { companyName: "Ortiz Plumbing", licenseNumber: "" },
    license: null,
    proposals: [
      proposal({ _id: "proposal_capture", kind: "capture", split: null }),
      proposal({ _id: "proposal_payout" }),
      proposal({ _id: "proposal_hold", kind: "hold", amountCents: null, split: null, rationale: "Hold until the license is verified." }),
    ],
    payment: null,
    ...overrides,
  };
}

function residentialSettledItem() {
  const base = inboxItem();
  return {
    ...base,
    readOnlyReference: true,
    projectKind: "residential",
    payApp: {
      ...base.payApp,
      _id: "payapp_lopez_draw",
      status: "paid",
      periodLabel: "Pay app #1 – period ending Oct 15, 2026",
      requestedTotalCents: 540_000,
      finalApproval: { totalCents: 400_000, approvedAt: 1_794_156_100_000 },
      review: null,
    },
    agreement: {
      ...base.agreement,
      _id: "agreement_ortiz",
      agreementNumber: "SC-22-ORTIZ-0001",
      projectTitle: "Lopez Kitchen Remodel",
      subcontractorName: "Ortiz Plumbing",
      retainagePercent: 5,
    },
    proposals: [
      proposal({
        _id: "proposal_paid_payout",
        status: "executed",
        amountCents: 400_000,
        split: { retainageCents: 20_000, netCents: 380_000 },
      }),
    ],
  };
}

function mockQueries(items: unknown) {
  const inboxQuery = getFunctionName(api.payApps.proposals.listInbox);
  const projectsQuery = getFunctionName(api.billing.ownerPayApps.ownerBillingProjects);
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockImplementation(((fn: unknown, args?: { projectId?: string }) => {
    const name = getFunctionName(fn as never);
    if (name === inboxQuery) return items;
    if (name === projectsQuery) {
      return [{ _id: LOPEZ_ID, title: "Lopez Kitchen Remodel", projectKind: "residential", partyRole: "gc" }];
    }
    if (name === moneyQuery) return args?.projectId === LOPEZ_ID ? lopezMoney() : portfolioMoney();
    return undefined;
  }) as never);
}

/** Elements carrying the shared primary Button variant class, matched as a whole class token. */
const primaryElements = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((className) => className.split(/\s+/).includes("bg-accent"));

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
  vi.mocked(useAction).mockReturnValue((async () => undefined) as never);
});

describe("the GC approval inbox", () => {
  test("leads with the five-cell Lopez strip and labels the separate portfolio strip", () => {
    mockQueries([]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html.match(/data-testid="project-money-strip"/g)).toHaveLength(2);
    const lopez = html.indexOf("Money on this job · Lopez Kitchen Remodel");
    const portfolio = html.indexOf("Money across your jobs");
    expect(lopez).toBeGreaterThan(-1);
    expect(lopez).toBeLessThan(portfolio);
    expect(html).toContain(">Collected from homeowner<");
    expect(html).toContain(">Retainage you hold<");
    expect(html).toContain(">Retainage held from you<");
    expect(html).toContain("$4,800.00");
    expect(html).toContain("$3,800.00");
    expect(html).toContain("$200.00");
    expect(html).toContain("$400.00");
    expect(html).toContain(">Collected from owners<");
    expect(html).toContain("$17,070.40");
    expect(html).toContain("including the separate commercial reference job");
    const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
    const moneyCalls = vi.mocked(useQuery).mock.calls.filter(([fn]) => getFunctionName(fn as never) === moneyQuery);
    expect(moneyCalls).toHaveLength(2);
  });

  test("uses an EmptyState with one sentence and one button when there is nothing to review", () => {
    mockQueries([]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).toContain("No pay applications to review");
    expect(html).toContain("When a subcontractor files a pay app, it lands here for your decision.");
    expect(html).toContain('href="#/billing"');
    expect(primaryElements(html)).toHaveLength(1);
  });

  test("shows plain-word proposal statuses and a compact money trail, not raw codes", () => {
    mockQueries([inboxItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).toContain('data-testid="proposal-status"');
    expect(html).toContain(">Pending<");
    expect(html).not.toContain('data-testid="proposal-status">pending');
    expect(html).toContain('data-testid="proposal-money-trail"');
    expect(html).toMatch(/data-testid="proposal-amount"[^>]*>\$320\.00<\/dd>/);
    expect(html).toMatch(/data-testid="proposal-retainage"[^>]*>\$32\.00<\/dd>/);
    expect(html).toMatch(/data-testid="proposal-net"[^>]*>\$288\.00<\/dd>/);
    expect(html).toContain("Ready for decision");
    expect(html).not.toContain(">reviewed<");
  });

  test("keeps one visually primary approve action and makes Edit and Reject secondary", () => {
    mockQueries([inboxItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html.match(/data-testid="approve-proposal"/g)).toHaveLength(2);
    expect(primaryElements(html)).toHaveLength(1);
    const [primaryApprove] = html.match(/<button[^>]*data-testid="approve-proposal"[^>]*>/) ?? [];
    const [, secondaryApprove] = html.match(/<button[^>]*data-testid="approve-proposal"[^>]*>/g) ?? [];
    expect(primaryApprove).toContain("bg-accent");
    expect(secondaryApprove).not.toContain("bg-accent");
    for (const id of ["edit-proposal", "reject-proposal"]) {
      const tag = html.match(new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
      expect(tag).not.toContain("bg-accent");
    }
  });

  test("across several applications only the next decision carries the primary style", () => {
    mockQueries([
      inboxItem(),
      inboxItem({
        payApp: { ...inboxItem().payApp, _id: "payapp_2" },
        agreement: { ...inboxItem().agreement, _id: "agreement_2" },
        proposals: [proposal({ _id: "proposal_second_payout" })],
      }),
    ]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html.match(/data-testid="approve-proposal"/g)).toHaveLength(3);
    expect(primaryElements(html)).toHaveLength(1);
  });

  test("the paid residential draw leads with a receipt and commercial records stay in one collapsed section", () => {
    mockQueries([inboxItem(), residentialSettledItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    const residential = html.indexOf('data-testid="inbox-residential-decision"');
    const commercial = html.indexOf('data-testid="inbox-commercial"');
    expect(residential).toBeGreaterThan(-1);
    expect(residential).toBeLessThan(commercial);
    expect(html.indexOf("Needs your attention")).toBeLessThan(residential);
    expect(html).toContain('data-testid="inbox-residential-decision-action"');
    expect(html).toContain("View paid receipt");
    expect(html).toContain('href="#/pay-apps/payapp_lopez_draw"');
    expect(html).not.toContain("Approve $4,000.00 and pay $3,800.00");
    expect(primaryElements(html)).toHaveLength(1);
    expect(html).toContain("Commercial reference job (1)");
    expect(html.match(/data-testid="inbox-commercial"/g)).toHaveLength(1);
    const detailsStart = html.lastIndexOf("<details", commercial);
    const detailsTag = html.slice(detailsStart, html.indexOf(">", detailsStart) + 1);
    expect(detailsTag).not.toContain(" open");
    const card = html.slice(residential, html.indexOf("</article>", residential));
    expect(card).not.toContain("A401-");
    expect(card).not.toContain("status");
    expect(card).toContain("Lopez Kitchen Remodel");
  });

  test("the settled residential card leaves the commercial decision queued without a second primary", () => {
    mockQueries([residentialSettledItem(), inboxItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(primaryElements(html)).toHaveLength(1);
    const primary = primaryElements(html)[0];
    expect(primary).toContain("bg-accent");
    expect(html.split('data-testid="approve-proposal"').length - 1).toBeGreaterThan(0);
    const firstApprove = html.match(/<button[^>]*data-testid="approve-proposal"[^>]*>/)?.[0] ?? "";
    expect(firstApprove).not.toContain("bg-accent");
  });

  test("a decidable residential pay app keeps its approval action and stored amounts", () => {
    const pending = inboxItem({
      projectKind: "residential",
      proposals: [proposal({ amountCents: 400_000, split: { retainageCents: 20_000, netCents: 380_000 } })],
    });
    mockQueries([pending]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).toContain("Approve capture + payout");
    expect(html).toMatch(/data-testid="proposal-amount"[^>]*>\$4,000\.00<\/dd>/);
    expect(html).toMatch(/data-testid="proposal-retainage"[^>]*>\$200\.00<\/dd>/);
    expect(html).toMatch(/data-testid="proposal-net"[^>]*>\$3,800\.00<\/dd>/);
    expect(html).not.toContain("View paid receipt");
    expect(html).not.toContain('data-testid="inbox-commercial"');
    const primaryApprove = html.match(/<button[^>]*data-testid="approve-proposal"[^>]*>/)?.[0] ?? "";
    expect(primaryApprove).toContain("bg-accent");
    expect(primaryElements(html)).toHaveLength(1);
  });

  test("the paid history entry stays reachable without offering another approval or primary", () => {
    mockQueries([residentialSettledItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html.match(/data-payapp-id="payapp_lopez_draw"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="inbox-history"');
    expect(html.match(/View paid receipt/g)).toHaveLength(1);
    expect(html).not.toContain("Approve $4,000.00 and pay $3,800.00");
    expect(html).not.toContain('data-testid="approve-proposal"');
    expect(primaryElements(html)).toHaveLength(1);
  });

  test("every commercial status shares one counted disclosure after all residential records", () => {
    const waiting = inboxItem({
      payApp: { ...inboxItem().payApp, _id: "payapp_waiting", status: "approved" },
      agreement: { ...inboxItem().agreement, _id: "agreement_waiting", agreementNumber: "A401-DEMO-PAY-20261106-09" },
    });
    const settled = inboxItem({
      payApp: { ...inboxItem().payApp, _id: "payapp_commercial_paid", status: "paid" },
      agreement: { ...inboxItem().agreement, _id: "agreement_commercial_paid", agreementNumber: "A401-DEMO-PAY-20261109-19" },
    });
    mockQueries([inboxItem(), waiting, settled, residentialSettledItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    const residentialHistory = html.indexOf('data-testid="inbox-history"');
    const commercial = html.indexOf('data-testid="inbox-commercial"');
    expect(residentialHistory).toBeGreaterThan(-1);
    expect(residentialHistory).toBeLessThan(commercial);
    expect(html).toContain("Commercial reference job (3)");
    expect(html.match(/data-testid="inbox-commercial"/g)).toHaveLength(1);
    const commercialHtml = html.slice(commercial, html.indexOf('data-testid="inbox-filters"', commercial));
    for (const id of ["payapp_1", "payapp_waiting", "payapp_commercial_paid"]) {
      expect(commercialHtml).toContain(`data-payapp-id="${id}"`);
    }
    expect(commercialHtml).not.toContain("payapp_lopez_draw");
    expect(primaryElements(html)).toHaveLength(1);
  });

  test("removes the duplicate jump-to-approve affordance while keeping its pinned hook", () => {
    mockQueries([inboxItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).not.toContain("Ready for your decision · review and approve the payout");
    expect(html).toContain('data-testid="jump-to-approve"');
    expect(html).toMatch(/<button[^>]*hidden[^>]*data-testid="jump-to-approve"/);
  });
});
