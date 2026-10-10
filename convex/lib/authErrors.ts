import { ConvexError } from "convex/values";

/**
 * Convex Auth throws plain `Error`s (InvalidSecret, InvalidAccountId, "Account … already exists",
 * "Could not verify code", TooManyFailedAttempts). Production deployments redact those to
 * "Server Error", so the Password provider's authorize step rethrows them as ConvexErrors with
 * fixed, readable messages. Sign-in failures for unknown and known emails read the same.
 */

/** Per-address wait between code emails; the server limits it and the Verify screen counts it down. */
export const RESEND_COOLDOWN_SECONDS = 30;

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
export const INVALID_CODE_MESSAGE = "Invalid or expired code. Check the latest email or request a new code.";
export const ACCOUNT_EXISTS_MESSAGE = "An account with this email already exists. Sign in or reset your password.";
export const TOO_MANY_ATTEMPTS_MESSAGE = "Too many failed attempts. Wait a few minutes and try again.";
export const INVALID_EMAIL_MESSAGE = "Enter a valid lowercase email address.";

export type AuthFlow = "signUp" | "signIn" | "reset" | "reset-verification" | "email-verification" | string;

/** Returns the ConvexError to throw instead of a library error, or null to rethrow as is. */
export function translateAuthError(flow: AuthFlow, err: unknown): ConvexError<{ code: string; message: string }> | null {
  if (err instanceof ConvexError) return null;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/TooManyFailedAttempts/.test(raw)) {
    return new ConvexError({ code: "TOO_MANY_ATTEMPTS", message: TOO_MANY_ATTEMPTS_MESSAGE });
  }
  if (flow === "signUp" && /already exists/i.test(raw)) {
    return new ConvexError({ code: "ACCOUNT_EXISTS", message: ACCOUNT_EXISTS_MESSAGE });
  }
  if (flow === "signIn" && /InvalidAccountId|InvalidSecret|Invalid credentials/.test(raw)) {
    return new ConvexError({ code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE });
  }
  if (
    (flow === "email-verification" || flow === "reset-verification") &&
    /InvalidAccountId|Could not verify code|Invalid code|verification code|matching `email`/i.test(raw)
  ) {
    return new ConvexError({ code: "INVALID_CODE", message: INVALID_CODE_MESSAGE });
  }
  return null;
}

/** Unknown-email reset requests end quietly so the response matches a real one. */
export function isUnknownAccount(err: unknown): boolean {
  return !(err instanceof ConvexError) && err instanceof Error && /InvalidAccountId/.test(err.message);
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/;
// Reserved or seeded domains that can't receive mail; a sign-up there would only burn a send.
const UNDELIVERABLE = /(\.test|\.example|\.invalid|\.localhost|@example\.(com|org|net)|@demo\.tradepulse)$/;

export function isLowercaseEmail(raw: unknown): raw is string {
  return typeof raw === "string" && raw === raw.trim().toLowerCase() && EMAIL_RE.test(raw) && raw.length <= 254;
}

export function isUndeliverableEmail(email: string): boolean {
  return UNDELIVERABLE.test(email);
}
