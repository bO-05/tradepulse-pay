import { afterEach, describe, expect, test, vi } from "vitest";
import { rememberedBlockedEmail, rememberBlockedEmail, verificationResendParams, type VerifyScreen } from "./authScreens";

const screen: VerifyScreen = {
  kind: "verify",
  email: "dana@bayview-mail.com",
  password: "Harbor-Point-2026",
  codeSent: false,
};

describe("verification resend", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("remembers the server's blocked-email reason for the same address", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    rememberBlockedEmail("Dana@Bayview-Mail.com", "This test deployment cannot email that address.");
    expect(rememberedBlockedEmail("dana@bayview-mail.com")).toBe("This test deployment cannot email that address.");
    expect(rememberedBlockedEmail("someone@else.test")).toBeNull();
  });

  test("retries sign-up after preflight refused account creation", () => {
    expect(verificationResendParams({ ...screen, signUpName: "Dana" })).toEqual({
      flow: "signUp",
      email: screen.email,
      password: screen.password,
      name: "Dana",
    });
  });

  test("keeps the password sign-in flow for existing unverified users", () => {
    expect(verificationResendParams(screen)).toEqual({
      flow: "signIn",
      email: screen.email,
      password: screen.password,
    });
  });
});
