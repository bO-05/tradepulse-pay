import { describe, expect, test } from "vitest";
import { verificationResendParams, type VerifyScreen } from "./authScreens";

const screen: VerifyScreen = {
  kind: "verify",
  email: "dana@bayview-mail.com",
  password: "Harbor-Point-2026",
  codeSent: false,
};

describe("verification resend", () => {
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
