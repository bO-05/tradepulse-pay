// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { ToastProvider } from "../../ui";
import { ProjectPage } from "./ProjectPage";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

function project(readOnlyReference: boolean, projectKind: "residential" | "commercial" = "residential") {
  return {
    _id: "project_lopez",
    title: "Lopez Kitchen Remodel",
    generalContractorName: "Bayview Remodeling",
    ownerName: "Dana Lopez",
    projectType: "Residential kitchen remodel",
    projectKind,
    location: "El Cerrito, CA",
    address: { line1: "1420 Elm Street", city: "El Cerrito", state: "CA", zip: "94530" },
    state: "CA",
    contractValueCents: 8_650_000,
    retainageBps: 1_000,
    billingDay: 15,
    startDate: "2026-09-21",
    substantialCompletionDate: "2026-11-20",
    status: "active" as const,
    isDemoProject: false,
    readOnlyReference,
  };
}

function money(kind: "residential" | "commercial") {
  return {
    scope: {
      kind: "project" as const,
      projectId: "project_lopez",
      projectTitle: "Lopez Kitchen Remodel",
      projectKind: kind,
      projects: [{ projectId: "project_lopez", projectTitle: "Lopez Kitchen Remodel", projectKind: kind }],
    },
    collectedFromOwnerCents: 0,
    collectedFromOwnerInclChangeOrdersCents: 0,
    paidToSubsCents: 0,
    retainageHeldCents: 0,
    ownerRetainageHeldCents: 0,
    owedThisWeekCents: 0,
    receipts: { ownerPayApps: [], payouts: [], retainage: [], owed: [] },
    asOf: 0,
    weekEnd: "2026-11-15",
    truncated: false,
  };
}

function ownerPayApps(projectKind: "residential" | "commercial") {
  return {
    projectId: "project_lopez",
    projectTitle: "Lopez Kitchen Remodel",
    projectKind,
    readOnlyReference: true,
    party: "gc" as const,
    retainageBps: 1_000,
    contractValueCents: 8_650_000,
    primeRetainageHeldCents: 40_000,
    create: { allowed: false, reason: "The reference is read-only.", nextPeriodEnd: null },
    rows: [
      {
        _id: "owner_app_1",
        applicationNo: 1,
        periodStart: "2026-10-16",
        periodEnd: "2026-11-15",
        status: "paid",
        currentPaymentDueCents: 360_000,
        retainageCents: 40_000,
        submittedAt: 1_790_000_000_000,
        approvedAt: 1_790_100_000_000,
        paidAt: 1_790_200_000_000,
      },
    ],
  };
}

function render(readOnlyReference: boolean, projectKind: "residential" | "commercial" = "residential") {
  const row = project(readOnlyReference, projectKind);
  const projectQuery = getFunctionName(api.projects.getProject);
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  const ownerQuery = getFunctionName(api.partyProfiles.getProjectOwner);
  const tradesQuery = getFunctionName(api.tradePackages.listByProject);
  const drawsQuery = getFunctionName(api.billing.ownerPayApps.listOwnerPayApps);
  // Answer by query name: the page adds the money strip, the owner trail, an owner-company read and the trades list.
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === projectQuery) return row;
    if (name === moneyQuery) return money(projectKind);
    if (name === ownerQuery) return { company: null, invoicing: { enabled: true } };
    if (name === tradesQuery) return [];
    if (name === drawsQuery) return ownerPayApps(projectKind);
    return undefined;
  }) as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <ProjectPage projectId="project_lopez" />
    </ToastProvider>,
  );
}

/** Elements carrying the shared primary Button variant class, matched as a whole class token. */
const primaryElements = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1])
    .filter((className) => className.split(/\s+/).includes("bg-accent"));

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("a preserved reference job on the project page", () => {
  test("offers neither the settings nor the People link and shows the settled-record notice", () => {
    const html = render(true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Settled sandbox record · read-only.");
    expect(html).not.toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("#/all-projects/project_lopez/settings");
    expect(html).not.toContain("#/people/project_lopez");
    expect(html).not.toContain(">Project settings<");
    expect(html).not.toContain(">People<");
    expect(html).not.toContain("Open in Procurement");
  });

  test("a frozen commercial project keeps the reference-job notice", () => {
    const html = render(true, "commercial");
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("Settled sandbox record · read-only.");
  });

  test("mounts the job-scoped money strip above the project details", () => {
    const html = render(true);
    expect(html).toContain('data-testid="project-money-strip"');
    expect(html).toContain('data-testid="project-money-collected"');
    expect(html).toContain("Money on this job · Lopez Kitchen Remodel");
    expect(html.indexOf('data-testid="project-money-strip"')).toBeLessThan(html.indexOf("Project details"));
  });

  test("shows Bayview Remodeling, Dana Lopez and the $86,500 contract above the money strip", () => {
    const html = render(true);
    expect(html).toContain("Bayview Remodeling");
    expect(html).toContain("Dana Lopez");
    expect(html).toContain("Contract value");
    expect(html).toContain("$86,500.00");
    expect(html.indexOf("Bayview Remodeling")).toBeLessThan(html.indexOf('data-testid="project-money-strip"'));
  });

  test("has exactly one primary action on the preserved job", () => {
    const html = render(true);
    const primaries = primaryElements(html);
    expect(primaries).toHaveLength(1);
    expect(html).toContain(">Open billing<");
    expect(html).toContain('href="#/billing"');
  });

  test("renders the owner money trail with the stored cents, visible without a disclosure", () => {
    const html = render(true);
    expect(html).toContain('data-testid="gc-money-trail"');
    expect(html).toContain("Money trail");
    expect(html).toContain("Contract");
    expect(html).toContain("Draw #1");
    expect(html).toContain("$3,600.00");
    expect(html).toContain("Retainage held");
    expect(html).toContain("$400.00");
    expect(html).toContain("Paid by the homeowner");
    expect(html.indexOf('data-testid="project-money-strip"')).toBeLessThan(html.indexOf('data-testid="gc-money-trail"'));
    expect(html.indexOf('data-testid="gc-money-trail"')).toBeLessThan(html.indexOf("Project details"));
    expect(html).not.toContain("<details");
  });

  test("a commercial job keeps the owner wording on the money trail", () => {
    const html = render(false, "commercial");
    expect(html).toContain('data-testid="gc-money-trail"');
    expect(html).toContain("Owner pay app #1");
    expect(html).toContain("Paid by the owner");
    expect(html).not.toContain("Draw #1");
  });

  test("an ordinary project keeps the settings and People links without the notice", () => {
    const html = render(false);
    expect(html).toContain("#/all-projects/project_lopez/settings");
    expect(html).toContain("#/people/project_lopez");
    expect(html).toContain(">Project settings<");
    expect(html).toContain(">People<");
    expect(html).toContain(">Open in Procurement<");
    expect(html).toContain("AI spec breakdown");
    expect(html).not.toContain('data-testid="read-only-reference"');
  });

  test("a residential job calls the section Trades and never shows CSI wording", () => {
    const html = render(false, "residential");
    expect(html).toContain(">Trades<");
    expect(html).toContain("No trades yet");
    expect(html).toContain("Add trade<");
    expect(html).not.toContain("Trade packages");
    expect(html).not.toContain("CSI");
    expect(html).not.toContain("Commercial reference job");
  });

  test("a commercial job keeps Trade packages, CSI and the reference badge", () => {
    const html = render(false, "commercial");
    expect(html).toContain(">Trade packages<");
    expect(html).toContain("No trade packages yet");
    expect(html).toContain("CSI MasterFormat");
    expect(html).toContain("Commercial reference job");
  });
});
