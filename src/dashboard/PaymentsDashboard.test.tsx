import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import PaymentsDashboard from "./PaymentsDashboard";
import type { DashboardRaw } from "./dataSources";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));
vi.mock("./StudioDashboard", () => {
  throw new Error("AG Studio must not load without a configured license");
});

afterEach(() => vi.unstubAllEnvs());

test("missing Studio license shows live basic dashboard without loading Studio", () => {
  vi.stubEnv("VITE_AG_STUDIO_LICENSE_KEY", "");
  vi.mocked(useQuery).mockReturnValue({
    agreements: [],
    payments: [],
    payApps: [],
    retainage: [],
    changeOrders: [],
    readOnly: true,
    role: "owner",
    totals: { paidCents: 0, retainageHeldCents: 0, retainageReleasedCents: 0, pendingPayAppCents: 0, changeOrdersPaidCents: 185000, changeOrdersInvoicedCents: 0 },
    incomplete: { truncated: false },
  } as unknown as DashboardRaw);
  const html = renderToStaticMarkup(<PaymentsDashboard />);
  expect(html).toContain("dashboard-basic-view");
  expect(html).toContain("AG Studio license is not configured.");
  expect(html).toContain("Read-only");
  expect(html).toContain("Live from Convex");
  expect(html).not.toContain("Loading AG Studio");
  expect(html).toContain("Owner change orders paid");
  expect(html).toContain("$1,850.00");
  // An Owner never sees subcontract measures: the header omits them rather than printing a false $0.
  expect(html).not.toContain("subcontract payouts");
  expect(html).toContain("Subcontract measures are not shared with the Owner.");
});
