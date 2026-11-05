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
});
