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
    expect(html).toContain("Read-only");
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
  });
});
