import { describe, expect, test } from "vitest";
import { buildDashboardData, dashboardTotals, paidNetCents, type DashboardRaw } from "./dataSources";

const AG = "agreement1" as DashboardRaw["agreements"][number]["agreementId"];

function payment(over: Partial<DashboardRaw["payments"][number]>): DashboardRaw["payments"][number] {
  return {
    paymentId: "p" as DashboardRaw["payments"][number]["paymentId"],
    agreementId: AG,
    kind: "payout",
    status: "success",
    grossCents: 0,
    retainageCents: 0,
    netCents: 0,
    capturedCents: 0,
    createdAt: Date.UTC(2026, 9, 7),
    updatedAt: Date.UTC(2026, 9, 7),
    ...over,
  } as DashboardRaw["payments"][number];
}

function payApp(over: Partial<DashboardRaw["payApps"][number]>): DashboardRaw["payApps"][number] {
  return {
    payAppId: "pa" as DashboardRaw["payApps"][number]["payAppId"],
    agreementId: AG,
    periodLabel: "Oct 2026",
    status: "submitted",
    requestedCents: 0,
    aiRecommendedCents: null,
    finalApprovedCents: null,
    reviewEngine: null,
    overbilledLines: 0,
    excludedScopeLines: 0,
    frontLoadedLines: 0,
    outOfSequenceLines: 0,
    lienWaiverMissing: false,
    licenseIssue: false,
    createdAt: Date.UTC(2026, 9, 7),
    ...over,
  } as DashboardRaw["payApps"][number];
}

const raw = {
  role: "gc",
  readOnly: false,
  agreements: [
    {
      agreementId: AG,
      agreementNumber: "SA-1",
      subcontractor: "Rosendin Electric",
      trade: "Electrical",
      project: "Tower",
      status: "executed",
      contractSumCents: 10_000_00,
      retainagePercent: 10,
      retainageCapCents: 1_000_00,
    },
  ],
  payments: [
    payment({ kind: "payout", status: "success", grossCents: 1_000_01, retainageCents: 100_00, netCents: 900_01 }),
    payment({ kind: "payout", status: "failed", netCents: 500_00 }),
    payment({ kind: "funding", status: "authorized", grossCents: 2_000_00, netCents: 2_000_00 }),
    payment({ kind: "retainage_release", status: "success", netCents: 50_00 }),
  ],
  payApps: [
    payApp({ status: "submitted", requestedCents: 300_00 }),
    payApp({ status: "reviewed", requestedCents: 200_05, aiRecommendedCents: 150_00, overbilledLines: 1 }),
    payApp({ status: "approved", requestedCents: 999_00, finalApprovedCents: 999_00 }),
  ],
  retainage: [
    { entryId: "r1", agreementId: AG, paymentId: null, deltaCents: 100_00, reason: "withheld", createdAt: 0 },
    { entryId: "r2", agreementId: AG, paymentId: null, deltaCents: -50_00, reason: "released", createdAt: 0 },
  ],
  changeOrders: [],
  milestones: [],
} as unknown as DashboardRaw;

describe("dashboard data", () => {
  test("paid counts only successful payouts and retainage releases", () => {
    expect(paidNetCents({ kind: "payout", status: "success", netCents: 7 })).toBe(7);
    expect(paidNetCents({ kind: "payout", status: "failed", netCents: 7 })).toBe(0);
    expect(paidNetCents({ kind: "funding", status: "success", netCents: 7 })).toBe(0);
  });

  test("KPI totals in cents", () => {
    expect(dashboardTotals(raw)).toEqual({
      totalPaidCents: 950_01,
      retainageHeldCents: 50_00,
      pendingPayAppCents: 500_05,
    });
  });

  test("Studio rows sum (in dollars) to the same KPI values", () => {
    const data = buildDashboardData(raw);
    const rows = (id: string) => data.sources.find((s) => s.id === id)!.data as unknown as Record<string, number>[];
    const sum = (id: string, key: string) => Math.round(rows(id).reduce((t, r) => t + (r[key] ?? 0), 0) * 100);
    expect(sum("payments", "paid")).toBe(950_01);
    expect(sum("retainage", "balance")).toBe(50_00);
    expect(sum("retainage", "released")).toBe(50_00);
    expect(sum("payApps", "pending")).toBe(500_05);
    expect(rows("agreements")[0].retainageCap).toBe(1000);
  });

  test("every fact source joins the agreements dimension and review flags are readable", () => {
    const data = buildDashboardData(raw);
    expect(data.sources.map((s) => s.id)).toEqual([
      "agreements",
      "payments",
      "payApps",
      "retainage",
      "changeOrders",
      "milestones",
    ]);
    expect(data.relationships.map((r) => r.source.tableId)).toEqual([
      "payments",
      "payApps",
      "retainage",
      "changeOrders",
      "milestones",
    ]);
    const apps = data.sources.find((s) => s.id === "payApps")!.data as unknown as { flags: string; aiRecommended: number | null }[];
    expect(apps[0]).toMatchObject({ flags: "none", aiRecommended: null });
    expect(apps[1]).toMatchObject({ flags: "overbilled", aiRecommended: 150 });
  });
});
