import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { useConvexAuth } from "convex/react";
import { DemoAccessPage } from "./DemoAccessPage";
import { DEMO_SEATS, SETTLED_LOPEZ_PAY_APP_ID } from "./demoSeats";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));
vi.mock("convex/react", () => ({ useConvexAuth: vi.fn() }));
vi.mock("./signOutAndReset", () => ({ useSignOutAndReset: () => vi.fn() }));
beforeEach(() => vi.mocked(useConvexAuth).mockReturnValue({ isAuthenticated: false, isLoading: false, isRefreshing: false }));

test("public guide provides three ordinary demo roles and honest payment instructions", () => {
  const html = renderToStaticMarkup(<DemoAccessPage />);
  for (const role of ["gc", "sub", "owner"]) expect(html).toContain(`data-testid="demo-enter-${role}"`);
  for (const text of ["gc@demo.tradepulse", "sub4@demo.tradepulse", "owner@demo.tradepulse", "TradePulseDemo!2026",
    "4032031427005060", "United States", "synthetic", "COMPLETED", "SUCCESS", "PAID",
    "not an authentication bypass", "owner-approved OAuth", "valid license"]) expect(html).toContain(text);
});

test("the Subcontractor seat is Ortiz and lands on the settled Lopez pay app", () => {
  expect(DEMO_SEATS.map((seat) => seat.testId)).toEqual(["gc", "sub", "owner"]);
  const gc = DEMO_SEATS.find((seat) => seat.testId === "gc");
  const sub = DEMO_SEATS.find((seat) => seat.testId === "sub");
  const owner = DEMO_SEATS.find((seat) => seat.testId === "owner");
  // GC and Owner keep their shared accounts and landing routes.
  expect(gc?.email).toBe("gc@demo.tradepulse");
  expect(gc?.hash).toBe("#/inbox");
  expect(owner?.email).toBe("owner@demo.tradepulse");
  expect(owner?.hash).toBe("#/projects");
  // The Sub seam is the new Ortiz account on the settled residential pay app, not Rosendin.
  expect(sub?.email).toBe("sub4@demo.tradepulse");
  expect(sub?.hash).toBe(`#/pay-apps/${SETTLED_LOPEZ_PAY_APP_ID}`);
  expect(SETTLED_LOPEZ_PAY_APP_ID).toBe("ph7434a59sqck3nysgt6teqh0h8hvx1h");

  const html = renderToStaticMarkup(<DemoAccessPage />);
  expect(html.match(/data-testid="demo-enter-/g) ?? []).toHaveLength(3);
  expect(html).not.toContain("sub1@demo.tradepulse");
  expect(html).not.toContain("Rosendin");
});

test("the seat buttons are the first action and the manual details are one collapsed disclosure", () => {
  const html = renderToStaticMarkup(<DemoAccessPage />);
  const seatIndex = html.indexOf('data-testid="demo-enter-gc"');
  const outcomesIndex = html.indexOf("Catch overbilling early");
  expect(seatIndex).toBeGreaterThan(-1);
  expect(seatIndex).toBeLessThan(outcomesIndex);

  expect(html.match(/data-testid="demo-manual-details"/g) ?? []).toHaveLength(1);
  const fromManual = html.slice(html.indexOf('data-testid="demo-manual-details"'));
  const manualBlock = fromManual.slice(0, fromManual.indexOf("</details>"));
  for (const text of ["Manual sign-in and sandbox details", "TradePulseDemo!2026", "4032031427005060",
    "cheery-axolotl-689.convex.site", "Build", "Recovery-dev", "Studio license"]) {
    expect(manualBlock).toContain(text);
  }
  // VAL-JUDGE-001 pins exactly six manual items.
  expect(manualBlock.match(/<dt/g) ?? []).toHaveLength(6);
  // Closed by default: React only emits the open attribute when the disclosure is open.
  expect(manualBlock).not.toContain("<details open");
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
