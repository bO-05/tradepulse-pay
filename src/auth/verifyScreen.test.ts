// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { assertAuthCodeSent } from "../../convex/lib/authEmail";
import { describeAuthError } from "./authErrors";
import { isCodeSendError, type VerifyScreen } from "./authScreens";

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn() }) }));

const { VerifyEmailForm } = await import("./VerifyEmailForm");

const EMAIL = "lakeshore-admin@mail-test.com";

function render(screen: VerifyScreen): string {
  return renderToStaticMarkup(createElement(VerifyEmailForm, { screen, onBack: () => {} }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

/** The Verify screen the sign-up and sign-in forms open after the server refuses to send a code. */
function screenAfterFailedSend(status: "failed" | "skipped_budget"): VerifyScreen {
  let err: unknown;
  try {
    assertAuthCodeSent(status === "failed" ? { status: "failed", error: "AgentMail 500" } : { status: "skipped_budget", outboxId: "x" as never, message: "limit" });
  } catch (e) {
    err = e;
  }
  const info = describeAuthError(err, "signUp");
  expect(isCodeSendError(info)).toBe(true);
  return { kind: "verify", email: EMAIL, password: "Harbor-Point-2026", codeSent: false, error: info.message };
}

describe("Verify screen after a code send", () => {
  test("a failed send shows that the code could not be sent, never that it was sent", () => {
    const out = render(screenAfterFailedSend("failed"));
    expect(out).toContain("We couldn't send the code email. Try again in a few minutes.");
    expect(out).not.toMatch(/We sent|Code sent/);
    expect(out).toContain("Resend code");
  });

  test("a send skipped by the daily limit says no code was sent", () => {
    const out = render(screenAfterFailedSend("skipped_budget"));
    expect(out).toContain("Today's email limit is reached, so no code was sent. Try again tomorrow.");
    expect(out).not.toMatch(/We sent|Code sent/);
  });

  test("a real send says the code was sent", () => {
    const out = render({ kind: "verify", email: EMAIL, password: "x", codeSent: true });
    expect(out).toContain(`We sent an 8-digit code to ${EMAIL}.`);
  });
});
