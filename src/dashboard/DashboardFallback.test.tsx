import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DashboardFallback, StudioErrorBoundary } from "./DashboardFallback";
import type { DashboardRaw } from "./dataSources";

describe("license-independent dashboard", () => {
  test("Owner change orders are not an empty subcontract ledger", () => {
    const html = renderToStaticMarkup(<DashboardFallback raw={{ agreements: [], changeOrders: [{
      changeOrderId: "co1", number: 1, description: "Owner extra work", amountCents: 185000, status: "paid",
    }] } as unknown as DashboardRaw} reason="Basic view selected." />);
    expect(html).toContain("$1,850.00");
    expect(html).toContain("Change order payment history");
    expect(html).not.toContain("No agreements to report.");
    expect(html).toContain('href="#/change-orders/co1"');
    expect(html).not.toContain('href="#/payments/');
  });
  test("renders actual per-agreement totals and ledger links without AG Studio", () => {
    const raw = { agreements: [{
      agreementId: "agreement1",
      agreementNumber: "SA-1",
      subcontractor: "Sub One",
      totals: { capturedCents: 10_000, paidCents: 0, retainageHeldCents: 1000, changeOrdersPaidCents: 0 },
    }] } as unknown as Pick<DashboardRaw, "agreements">;
    const html = renderToStaticMarkup(<DashboardFallback raw={raw} reason="AG Studio license is not configured." />);
    expect(html).toContain("AG Studio license is not configured.");
    expect(html).toContain("AI chat are unavailable");
    expect(html).toContain('href="#/payments/agreement1"');
    expect(html).toContain("Captured $100.00");
    expect(html).toContain("paid $0.00");
    expect(html).not.toContain("ag-studio-dashboard");
  });

  test("empty view remains usable and error-boundary state selects the fallback", () => {
    const fallback = <DashboardFallback raw={{ agreements: [] }} reason="AG Studio could not load." />;
    expect(renderToStaticMarkup(fallback)).toContain("No agreements to report.");
    const boundary = new StudioErrorBoundary({ fallback, children: <p>Studio</p> });
    boundary.state = StudioErrorBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBe(fallback);
  });
});
