import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { passwordChecks, passwordProblem, validatePassword } from "../../convex/lib/passwordPolicy";
import { isLowercaseEmail, isUndeliverableEmail, translateAuthError } from "../../convex/lib/authErrors";
import { describeAuthError, emailInputProblem, normalizeEmailInput } from "./authErrors";
import { isCodeSendError } from "./authScreens";

describe("password rule (shared client/server)", () => {
  test("contract examples", () => {
    expect(passwordProblem("short1!")).toMatch(/at least 10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/at least two/);
    expect(passwordProblem("Harbor-Point-2026")).toBeNull();
    expect(passwordProblem("Embarcadero-455-W")).toBeNull();
    expect(passwordProblem("password123")).toMatch(/too common/);
    expect(() => validatePassword("aaaaaaaaaaaa")).toThrow(ConvexError);
  });

  test("live hints turn satisfied for a valid password", () => {
    expect(passwordChecks("").every((c) => !c.ok)).toBe(true);
    expect(passwordChecks("aaaaaaaaaaaa").map((c) => c.ok)).toEqual([true, false, true]);
    expect(passwordChecks("Harbor-Point-2026").every((c) => c.ok)).toBe(true);
  });
});

describe("email handling", () => {
  test("the client lowercases and validates", () => {
    expect(normalizeEmailInput("  Dana-X@Mail.TM ")).toBe("dana-x@mail.tm");
    expect(emailInputProblem("not-an-email")).toMatch(/valid email/);
    expect(emailInputProblem("")).toMatch(/Enter your email/);
    expect(emailInputProblem("Dana@Example.com")).toBeNull();
  });

  test("the server accepts only lowercase addresses and refuses undeliverable sign-ups", () => {
    expect(isLowercaseEmail("dana@mail.tm")).toBe(true);
    expect(isLowercaseEmail("Dana@mail.tm")).toBe(false);
    expect(isLowercaseEmail(" dana@mail.tm")).toBe(false);
    expect(isUndeliverableEmail("gc@demo.tradepulse")).toBe(true);
    expect(isUndeliverableEmail("x@bayview.test")).toBe(true);
    expect(isUndeliverableEmail("dana@mail.tm")).toBe(false);
  });
});

describe("auth error messages", () => {
  test("library errors become fixed ConvexErrors that don't reveal whether an account exists", () => {
    const secret = translateAuthError("signIn", new Error("Uncaught Error: InvalidSecret"));
    const unknown = translateAuthError("signIn", new Error("Uncaught Error: InvalidAccountId"));
    expect(secret?.data).toEqual(unknown?.data);
    expect(secret?.data.message).toBe("Invalid email or password.");
    expect(translateAuthError("signUp", new Error("Account dana@x.com already exists"))?.data.code).toBe("ACCOUNT_EXISTS");
    expect(translateAuthError("email-verification", new Error("Could not verify code"))?.data.code).toBe("INVALID_CODE");
    expect(translateAuthError("reset-verification", new Error("Invalid code"))?.data.code).toBe("INVALID_CODE");
    expect(translateAuthError("signIn", new Error("TooManyFailedAttempts"))?.data.code).toBe("TOO_MANY_ATTEMPTS");
    expect(translateAuthError("signIn", new ConvexError({ code: "X", message: "y" }))).toBeNull();
  });

  test("the client shows ConvexError messages and never a raw server error", () => {
    expect(describeAuthError(new ConvexError({ code: "WEAK_PASSWORD", message: "Too weak." }), "signUp")).toEqual({
      code: "WEAK_PASSWORD",
      message: "Too weak.",
    });
    expect(describeAuthError(new Error("[Request ID: 1] Server Error"), "signIn").message).toBe("Invalid email or password.");
    expect(describeAuthError(new Error("Server Error"), "verify").message).toMatch(/Invalid or expired code/);
    expect(describeAuthError(new TypeError("Failed to fetch"), "signIn").code).toBe("NETWORK");
  });

  test("rate limits explain how long to wait", () => {
    const cooldown = describeAuthError(new ConvexError({ kind: "RateLimited", name: "authEmailCooldown", retryAfter: 21_500 }), "resend");
    expect(cooldown).toMatchObject({ code: "RATE_LIMITED", message: "Wait 22 seconds before requesting another code.", retryAfterMs: 21_500 });
    expect(isCodeSendError(cooldown)).toBe(true);
    const signUp = describeAuthError(new ConvexError({ kind: "RateLimited", name: "signUpBurst", retryAfter: 120_000 }), "signUp");
    expect(signUp.message).toMatch(/Too many new accounts/);
    expect(isCodeSendError(signUp)).toBe(false);
    expect(isCodeSendError({ code: "EMAIL_LIMIT" })).toBe(true);
  });
});
