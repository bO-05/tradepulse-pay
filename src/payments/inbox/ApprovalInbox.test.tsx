// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { ApprovalInbox } from "./ApprovalInbox";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

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

describe("the GC approval inbox", () => {
  test("mounts the portfolio money strip, labeled as across the GC's jobs", () => {
    const inboxQuery = getFunctionName(api.payApps.proposals.listInbox);
    const moneyQuery = getFunctionName(api.billing.projectMoney.getProjectMoney);
    vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
      const name = getFunctionName(fn as never);
      if (name === inboxQuery) return [];
      if (name === moneyQuery) return portfolioMoney();
      return undefined;
    }) as never);

    const html = renderToStaticMarkup(<ApprovalInbox />);
    expect(html).toContain('data-testid="project-money-strip"');
    expect(html).toContain('data-testid="project-money-collected"');
    expect(html).toContain("Money across your jobs");
    expect(html).toContain(">Collected from owners<");
    expect(html).toContain("$3,600.00");
    expect(html).toContain("$3,800.00");
    expect(html).not.toContain("Collected from homeowner");
  });
});
