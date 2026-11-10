import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DashboardFallback, StudioErrorBoundary } from "./DashboardFallback";
import type { DashboardRaw } from "./dataSources";

describe("license-independent dashboard", () => {
  test("Owner change orders are not an empty subcontract ledger", () => {
    const html = renderToStaticMarkup(<DashboardFallback raw={{ agreements: [], changeOrders: [{
      changeOrderId: "co1", number: 1, description: "Judge demo: Owner extra work", amountCents: 185000, status: "paid",
    }] } as unknown as DashboardRaw} reason="Basic view selected." />);
    expect(html).toContain("$1,850.00");
    expect(html).toContain("Owner extra work");
    expect(html).not.toContain("Judge demo");
    expect(html).toContain("Change order payment history");
    expect(html).not.toContain("No agreements to report.");
    expect(html).toContain('href="#/change-orders/co1"');
    expect(html).not.toContain('href="#/payments/');
  });
  test("renders actual per-agreement totals, a money chart and ledger links without AG Studio", () => {
    const raw = { agreements: [{
      agreementId: "agreement1",
      agreementNumber: "SA-1",
      subcontractor: "Sub One",
      contractSumCents: 100_000,
      totals: { capturedCents: 10_000, paidCents: 0, retainageHeldCents: 1000, changeOrdersPaidCents: 0 },
    }, {
      agreementId: "agreement2",
      agreementNumber: "SA-2",
      subcontractor: "Sub Two",
      contractSumCents: 50_000,
      totals: { capturedCents: 0, paidCents: 0, retainageHeldCents: 0, changeOrdersPaidCents: 0 },
    }] } as unknown as Pick<DashboardRaw, "agreements">;
    const html = renderToStaticMarkup(<DashboardFallback raw={raw} reason="Basic view selected." />);
    expect(html).toContain("Basic view selected.");
    expect(html).toContain("Showing the basic report instead");
    expect(html).toContain('href="#/payments/agreement1"');
    expect(html).toContain("Captured $100.00");
    expect(html).toContain("paid $0.00");
    expect(html).toContain('data-testid="dashboard-money-chart"');
    // A $0 agreement does not sit next to a global pending total as if it had activity.
    expect(html).not.toContain('href="#/payments/agreement2"');
    expect(html).toContain("1 agreement with no payment activity yet is hidden.");
    expect(html).not.toContain("ag-studio-dashboard");
  });

  test("the default basic report does not mention an unconfigured license", () => {
    const raw = { agreements: [] } as unknown as Pick<DashboardRaw, "agreements">;
    const html = renderToStaticMarkup(<DashboardFallback raw={raw} />);
    expect(html).toContain("The optional Studio layout is not needed.");
    expect(html).not.toContain("AG Studio");
    expect(html).not.toContain("not configured");
  });

  test("empty view remains usable and error-boundary state selects the fallback", () => {
    const fallback = <DashboardFallback raw={{ agreements: [] }} reason="AG Studio could not load." />;
    expect(renderToStaticMarkup(fallback)).toContain("No agreements to report.");
    const boundary = new StudioErrorBoundary({ fallback, children: <p>Studio</p> });
    boundary.state = StudioErrorBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBe(fallback);
  });
});
