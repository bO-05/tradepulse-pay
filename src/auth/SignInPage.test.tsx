import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { SignInPage } from "./SignInPage";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));

test("normal sign-in does not advertise the demo guide", () => {
  const html = renderToStaticMarkup(<SignInPage />);
  expect(html).not.toContain("#/demo");
  expect(html).not.toContain("judge demo");
});
