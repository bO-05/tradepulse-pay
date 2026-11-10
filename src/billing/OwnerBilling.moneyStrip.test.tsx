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
type Kind = "residential" | "commercial";

function projects(kind: Kind = "residential") {
  return [
    {
      _id: LOPEZ_ID,
      title: "Lopez Kitchen Remodel",
      partyRole: "gc" as const,
      projectKind: kind,
    },
  ];
}

function ownerPayApps(kind: Kind = "residential", readOnlyReference = false) {
  return {
    projectId: LOPEZ_ID,
    projectTitle: "Lopez Kitchen Remodel",
    projectKind: kind,
    readOnlyReference,
    party: "gc" as const,
    retainageBps: 1_000,
    contractValueCents: 8_650_000,
    primeRetainageHeldCents: 40_000,
    create: { allowed: false, reason: "Finish the current draw first.", nextPeriodEnd: null },
    rows: [],
  };
}

function projectMoney(kind: Kind = "residential") {
  return {
    scope: {
      kind: "project" as const,
      projectId: LOPEZ_ID,
      projectTitle: "Lopez Kitchen Remodel",
      projectKind: kind,
      projects: [{ projectId: LOPEZ_ID, projectTitle: "Lopez Kitchen Remodel", projectKind: kind }],
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

function renderBilling(kind: Kind = "residential", readOnlyReference = false): string {
  const projectsQuery = getFunctionName(api.billing.ownerPayApps.ownerBillingProjects);
  const listQuery = getFunctionName(api.billing.ownerPayApps.listOwnerPayApps);
  const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    const name = getFunctionName(fn as never);
    if (name === projectsQuery) return projects(kind);
    if (name === listQuery) return ownerPayApps(kind, readOnlyReference);
    if (name === moneyQuery) return projectMoney(kind);
    return undefined;
  }) as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <GcOwnerBilling />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("the GC owner-billing tab", () => {
  test("mounts the job-scoped money strip above the owner billing summary", () => {
    const html = renderBilling();

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

  test("the commercial owner-billing mount keeps four cells and no nested homeowner caption", () => {
    const html = renderBilling("commercial");

    expect(html).toContain(">Collected from owner<");
    expect(html).toContain(">Retainage held<");
    expect(html).not.toContain(">Retainage you hold<");
    expect(html).not.toContain('data-testid="project-money-retainage-held-from-you"');
    expect(html).not.toContain("project-money-owner-retainage");
    expect(html).not.toContain("from the homeowner");
  });

  test("a settled residential job shows the settled-record notice", () => {
    const html = renderBilling("residential", true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Settled sandbox record · read-only.");
    expect(html).not.toContain("Preserved reference job · read-only.");
  });

  test("a commercial job keeps the reference-job notice", () => {
    const html = renderBilling("commercial", true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("Settled sandbox record · read-only.");
  });
});
