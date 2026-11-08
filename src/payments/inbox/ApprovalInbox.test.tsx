// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { ApprovalInbox } from "./ApprovalInbox";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn(), useAction: vi.fn() }));

function portfolioMoney() {
  return {
    scope: {
      kind: "portfolio" as const,
      projectId: null,
      projectTitle: null,
      projectKind: null,
      projects: [{ projectId: "project_lopez", projectTitle: "Lopez Kitchen Remodel", projectKind: "residential" }],
    },
    collectedFromOwnerCents: 360_000,
    paidToSubsCents: 380_000,
    retainageHeldCents: 20_000,
    ownerRetainageHeldCents: 40_000,
    owedThisWeekCents: 0,
    receipts: { ownerPayApps: [], payouts: [], retainage: [], owed: [] },
    asOf: 1_794_200_000_000,
    weekEnd: "2026-11-15",
    truncated: false,
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

function mockQueries(items: unknown) {
  const inboxQuery = getFunctionName(api.payApps.proposals.listInbox);
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === inboxQuery) return items;
    if (name === moneyQuery) return portfolioMoney();
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
  test("mounts the portfolio money strip, labeled as across the GC's jobs", () => {
    mockQueries([]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).toContain('data-testid="project-money-strip"');
    expect(html).toContain('data-testid="project-money-collected"');
    expect(html).toContain("Money across your jobs");
    expect(html).toContain(">Collected from owners<");
    expect(html).toContain("$3,600.00");
    expect(html).toContain("$3,800.00");
    expect(html).not.toContain("Collected from homeowner");
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

  test("removes the duplicate jump-to-approve affordance while keeping its pinned hook", () => {
    mockQueries([inboxItem()]);
    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).not.toContain("Ready for your decision · review and approve the payout");
    expect(html).toContain('data-testid="jump-to-approve"');
    expect(html).toMatch(/<button[^>]*hidden[^>]*data-testid="jump-to-approve"/);
  });
});
