import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { SignInPage } from "./SignInPage";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));

test("the signed-out landing shows the residential hero above the sign-in card", () => {
  const html = renderToStaticMarkup(<SignInPage />);
  for (const text of ["Pay apps for owner-run remodels", "Pay the right amount.", "Catch overbilling early"]) {
    expect(html).toContain(text);
  }
  expect(html).toContain('href="#/demo"');
  expect(html).toContain("Open the guided demo");
  // The hero is marketing copy; no demo credentials or role buttons leak onto the ordinary sign-in page.
  expect(html).not.toContain("TradePulseDemo!2026");
  expect(html).not.toContain("gc@demo.tradepulse");
  expect(html).not.toContain('data-testid="demo-enter-gc"');
});
