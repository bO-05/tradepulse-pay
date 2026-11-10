// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ToastProvider } from "../ui";
import { GcOwnerBilling } from "./OwnerBilling";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

const LOPEZ_ID = "project_lopez";

function projects() {
  return [
    {
      _id: LOPEZ_ID,
      title: "Lopez Kitchen Remodel",
      partyRole: "gc" as const,
      projectKind: "residential" as const,
    },
  ];
}

function ownerPayApps() {
  return {
    projectId: LOPEZ_ID,
    projectTitle: "Lopez Kitchen Remodel",
    projectKind: "residential" as const,
    readOnlyReference: false,
    party: "gc" as const,
    retainageBps: 1_000,
    contractValueCents: 8_650_000,
    primeRetainageHeldCents: 40_000,
    create: { allowed: false, reason: "Finish the current draw first.", nextPeriodEnd: null },
    rows: [],
  };
}

function projectMoney() {
  return {
    scope: {
      kind: "project" as const,
      projectId: LOPEZ_ID,
      projectTitle: "Lopez Kitchen Remodel",
      projectKind: "residential" as const,
      projects: [{ projectId: LOPEZ_ID, projectTitle: "Lopez Kitchen Remodel", projectKind: "residential" as const }],
    },
    collectedFromOwnerCents: 360_000,
    collectedFromOwnerInclChangeOrdersCents: 480_000,
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

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("the GC owner-billing tab", () => {
  test("mounts the job-scoped money strip above the owner billing summary", () => {
    const projectsQuery = getFunctionName(api.billing.ownerPayApps.ownerBillingProjects);
    const listQuery = getFunctionName(api.billing.ownerPayApps.listOwnerPayApps);
    const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
    vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
      const name = getFunctionName(fn as never);
      if (name === projectsQuery) return projects();
      if (name === listQuery) return ownerPayApps();
      if (name === moneyQuery) return projectMoney();
      return undefined;
    }) as never);

    const html = renderToStaticMarkup(
      <ToastProvider>
        <GcOwnerBilling />
      </ToastProvider>,
    );
    expect(html).toContain('data-testid="gc-owner-billing"');
    expect(html).toContain('data-testid="project-money-strip"');
    expect(html).toContain(">Collected from homeowner<");
    expect(html).toContain(">Retainage you hold<");
    expect(html).toContain(">Retainage held from you<");
    expect(html).toContain('data-testid="project-money-retainage-held-from-you"');
    expect(html).toContain("$4,800.00");
    expect(html).toContain("$3,800.00");
    expect(html).toContain("$200.00");
    expect(html).toContain("$400.00");
    // The older three-cell owner money strip stays for its pinned test ids.
    expect(html).toContain('data-testid="owner-money-strip"');
    expect(html.indexOf('data-testid="project-money-strip"')).toBeLessThan(
      html.indexOf('data-testid="owner-money-strip"'),
    );
  });
});
