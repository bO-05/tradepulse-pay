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

function render(readOnlyReference: boolean, projectKind: "residential" | "commercial" = "residential") {
  const row = project(readOnlyReference, projectKind);
  const projectQuery = getFunctionName(api.projects.getProject);
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  const ownerQuery = getFunctionName(api.partyProfiles.getProjectOwner);
  const tradesQuery = getFunctionName(api.tradePackages.listByProject);
  // Answer by query name: the page adds the money strip, an owner-company read and the trades list.
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === projectQuery) return row;
    if (name === moneyQuery) return money(projectKind);
    if (name === ownerQuery) return { company: null, invoicing: { enabled: true } };
    if (name === tradesQuery) return [];
    return undefined;
  }) as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <ProjectPage projectId="project_lopez" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("a preserved reference job on the project page", () => {
  test("offers neither the settings nor the People link and shows the reference notice", () => {
    const html = render(true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("#/all-projects/project_lopez/settings");
    expect(html).not.toContain("#/people/project_lopez");
    expect(html).not.toContain(">Project settings<");
    expect(html).not.toContain(">People<");
    expect(html).not.toContain("Open in Procurement");
  });

  test("mounts the job-scoped money strip above the project details", () => {
    const html = render(true);
    expect(html).toContain('data-testid="project-money-strip"');
    expect(html).toContain('data-testid="project-money-collected"');
    expect(html).toContain("Money on this job");
    expect(html.indexOf('data-testid="project-money-strip"')).toBeLessThan(html.indexOf("Project details"));
  });

  test("an ordinary project keeps the settings and People links without the notice", () => {
    const html = render(false);
    expect(html).toContain("#/all-projects/project_lopez/settings");
    expect(html).toContain("#/people/project_lopez");
    expect(html).toContain(">Project settings<");
    expect(html).toContain(">People<");
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
