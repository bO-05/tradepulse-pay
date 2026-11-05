import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useConvexAuth } from "convex/react";
import { DemoAccessPage } from "./DemoAccessPage";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock("convex/react", () => ({ useConvexAuth: vi.fn() }));
vi.mock("./signOutAndReset", () => ({ useSignOutAndReset: () => vi.fn() }));
beforeEach(() => vi.mocked(useConvexAuth).mockReturnValue({ isAuthenticated: false, isLoading: false, isRefreshing: false }));

test("public guide provides three ordinary demo roles and honest payment instructions", () => {
  const html = renderToStaticMarkup(<DemoAccessPage />);
  for (const role of ["gc", "sub", "owner"]) expect(html).toContain(`data-testid="demo-enter-${role}"`);
  for (const text of ["gc@demo.tradepulse", "sub1@demo.tradepulse", "owner@demo.tradepulse", "TradePulseDemo!2026",
    "4032031427005060", "United States", "synthetic", "COMPLETED", "SUCCESS", "PAID",
    "not an authentication bypass", "owner-approved OAuth", "valid license"]) expect(html).toContain(text);
});

test("the landing leads with the residential GC job story, not the judge checklist", () => {
  const html = renderToStaticMarkup(<DemoAccessPage />);
  for (const text of ["Residential remodel GCs", "Pay the right amount.", "Catch overbilling early",
    "Keep a clean owner trail", "owner-run remodels", "PayPal sandbox money only"]) expect(html).toContain(text);
  expect(html).toContain("Judge walkthrough");
  expect(html).toContain("<details");
});

test("guide never silently replaces an existing signed-in account", () => {
  vi.mocked(useConvexAuth).mockReturnValue({ isAuthenticated: true, isLoading: false, isRefreshing: false });
  const html = renderToStaticMarkup(<DemoAccessPage />);
  expect(html).toContain("Your current account will not be replaced");
  expect(html).toContain("Open your workspace");
  expect(html).not.toContain('data-testid="demo-enter-gc"');
});
