// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { OwnerPortal } from "./OwnerPortal";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

const job = {
  basis: "approved" as const,
  contractSumToDateCents: 5_000_000,
  completedAndStoredCents: 2_000_000,
  completionBps: 4_000,
  paidToDateCents: 1_135_000,
  paidOwnerPayAppsCents: 950_000,
  paidChangeOrdersCents: 185_000,
  retainageHeldCents: 100_000,
  balanceToFinishCents: 3_000_000,
  changeOrdersApprovedCents: 235_000,
  openChangeOrders: 1,
  latestApplicationNo: 3,
  latestStatus: "submitted_to_owner",
  paymentDueCents: 950_000,
  approvedApplicationNo: 2,
  paidApplicationCount: 1,
  startDate: "2026-09-01",
  substantialCompletionDate: "2027-02-01",
};

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function project() {
  return {
    _id: "project_1",
    title: "Harbor Point Dental Office TI",
    location: "Oakland, CA",
    projectType: "Tenant improvement",
    estBudget: 100_000,
    isDemoProject: false,
    partyRole: "owner" as const,
    agreements: [],
    primeContractSum: { originalCents: 5_000_000, netChangeCents: 235_000, toDateCents: 5_235_000 },
    primeRetainageHeldCents: 100_000,
    ownerJob: job,
    changeOrders: [],
    tranches: [],
  };
}

beforeEach(() => {
  vi.mocked(useQuery).mockReturnValue([project()] as never);
});

describe("Owner job so far card", () => {
  test("shows approved progress and the submitted app waiting for the owner without a payment control", () => {
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    expect(html).toContain("Job so far");
    expect(html).toContain("40.0%");
    expect(html).toContain("Approved through pay app #2");
    expect(html).toContain("Pay app #3 is waiting for your review");
    expect(html).toContain("$50,000.00"); // contract to date
    expect(html).toContain("$20,000.00"); // completed & stored
    expect(html).toContain("$11,350.00"); // paid to date
    expect(html).toContain("$1,000.00"); // retainage held
    expect(html).toContain("$30,000.00"); // balance to finish
    expect(html).toContain("1 awaiting your review");
    expect(html).toContain("Paid to date = $9,500.00 in paid pay apps + $1,850.00 in paid change orders");
    expect(html).not.toContain("they do not move money");
    expect(html).toContain('data-testid="owner-home-open-draw"');
    expect(html.match(/bg-accent text-accent-fg/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/read-only/i);
    expect(html).not.toContain(">Pay now<");
  });

  test("does not show the owner card in the GC project summary", () => {
    vi.mocked(useQuery).mockReturnValue([{ ...project(), partyRole: "gc", ownerJob: null, agreements: [] }] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="gc" />);
    expect(html).toContain("Project summaries");
    expect(html).not.toContain("Job so far");
  });

  test("a residential job uses draw, trade and funded-milestone words with no commercial wording", () => {
    vi.mocked(useQuery).mockReturnValue([
      { ...project(), projectKind: "residential", title: "Lopez Kitchen Remodel" },
    ] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    const rendered = visibleText(html);
    expect(rendered).toContain("Draw #3 is waiting for your review");
    expect(rendered).toContain("Approved through draw #2");
    expect(rendered).toContain("in paid draws");
    expect(rendered).toContain("Retainage you hold on the contract");
    expect(rendered).toContain("Contract sum to date");
    expect(rendered).toContain("No change orders on this project yet.");
    expect(rendered).toContain("Funded milestones");
    expect(rendered).toContain("Settled sandbox record · read-only.");
    expect(rendered).not.toContain("Preserved reference job");
    expect(rendered).not.toContain("Owner pay app");
    expect(rendered).not.toContain("Prime");
    expect(rendered).not.toContain("tranche");
    expect(rendered).not.toContain("Commercial reference job");
  });

  test("a commercial job keeps the pinned pay-app wording and shows the reference badge", () => {
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    expect(html).toContain("Pay app #3 is waiting for your review");
    expect(html).toContain("Prime contract sum to date");
    expect(html).toContain("Retainage you hold on the prime contract");
    expect(html).toContain("Commercial reference job");
    expect(html).toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("Settled sandbox record · read-only.");
  });
});

describe("the owner's portfolio leads with the residential job", () => {
  const commercial = { ...project(), _id: "project_commercial", title: "Harbor Point Dental Office TI" };
  const residential = { ...project(), _id: "project_lopez", title: "Lopez Kitchen Remodel", projectKind: "residential" as const };
  const secondResidential = { ...project(), _id: "project_cabin", title: "Hilltop Cabin Rewire", projectKind: "residential" as const };

  test("the mixed home leads with Lopez and hides every commercial secondary card", () => {
    // The server returns the newest commercial demo job first; the owner home puts Lopez first.
    vi.mocked(useQuery).mockReturnValue([commercial, residential] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    const rendered = visibleText(html);
    expect(html.indexOf("Lopez Kitchen Remodel")).toBeLessThan(html.indexOf("owner-job-so-far"));
    expect(rendered).not.toContain("Harbor Point Dental Office TI");
    expect(rendered).not.toContain("Other projects");
    expect(html).not.toContain('data-testid="owner-project-secondary"');
    // Exactly one full job card: Lopez.
    expect((html.match(/data-testid="owner-job-so-far"/g) ?? []).length).toBe(1);
  });

  test("additional residential jobs remain as secondary cards", () => {
    vi.mocked(useQuery).mockReturnValue([commercial, residential, secondResidential] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    const rendered = visibleText(html);
    expect(rendered).toContain("Hilltop Cabin Rewire");
    expect(rendered).toContain("Other projects");
    expect((html.match(/data-testid="owner-project-secondary"/g) ?? []).length).toBe(1);
    expect(rendered).not.toContain("Harbor Point Dental Office TI");
    expect(rendered).not.toContain("Commercial reference job");
  });

  test("a missing project kind is commercial and hidden from the mixed home", () => {
    const legacy = { ...commercial, _id: "project_legacy", title: "Legacy Office Buildout", projectKind: undefined };
    vi.mocked(useQuery).mockReturnValue([legacy, residential] as never);
    const rendered = visibleText(renderToStaticMarkup(<OwnerPortal role="owner" />));
    expect(rendered).toContain("Lopez Kitchen Remodel");
    expect(rendered).not.toContain("Legacy Office Buildout");
    expect(rendered).not.toContain("Other projects");
  });

  test("commercial-only owners keep their commercial lead, money, draw and change-order data", () => {
    vi.mocked(useQuery).mockReturnValue([commercial] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    const rendered = visibleText(html);
    expect(rendered).toContain("Harbor Point Dental Office TI");
    expect(rendered).toContain("Job so far");
    expect(rendered).toContain("$11,350.00");
    expect(rendered).toContain("Prime contract sum to date");
    expect(rendered).toContain("Commercial reference job");
    expect(rendered).not.toContain("Other projects");
  });

  test("commercial-only owners keep the first commercial lead and hide later commercial cards", () => {
    const older = { ...commercial, _id: "project_older", title: "Second Commercial Job" };
    vi.mocked(useQuery).mockReturnValue([commercial, older] as never);
    const rendered = visibleText(renderToStaticMarkup(<OwnerPortal role="owner" />));
    expect(rendered).toContain("Harbor Point Dental Office TI");
    expect(rendered).not.toContain("Second Commercial Job");
    expect(rendered).not.toContain("Other projects");
  });

  test("the lead job shows the money trail with every pinned hook and paid as the headline", () => {
    vi.mocked(useQuery).mockReturnValue([commercial, residential] as never);
    const html = renderToStaticMarkup(<OwnerPortal role="owner" />);
    expect(html).toContain('data-testid="owner-money-trail"');
    for (const hook of ["owner-job-contract", "owner-job-completed", "owner-job-retainage", "owner-job-paid", "owner-job-balance", "owner-job-change-orders"]) {
      expect(html, hook).toContain(`data-testid="${hook}"`);
    }
    expect(html).toMatch(/data-testid="owner-job-paid"[^>]*text-3xl/);
    expect(html).toContain(">Paid to date<");
    expect(html).toContain("$9,500.00 draw · $1,850.00 change order");
    expect(html).toContain(">Balance to finish<");
    expect(html).toContain("Contract to date");
    expect(visibleText(html)).toContain("1 awaiting your review");
  });
});
