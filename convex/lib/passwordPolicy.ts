import { ConvexError } from "convex/values";

/**
 * The password rule, shared by the sign-up/reset screens (live hints) and the Convex Auth
 * Password provider (`validatePasswordRequirements`). Pure TS so `src/` can import it.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "1234567890",
  "12345678910",
  "qwertyuiop",
  "qwerty1234",
  "iloveyou12",
  "letmein123",
  "tradepulse",
  "tradepulsepay",
]);

export type PasswordCheck = { id: "length" | "classes" | "common"; label: string; ok: boolean };

export function characterClassCount(password: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
}

export function passwordChecks(password: string): PasswordCheck[] {
  return [
    {
      id: "length",
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      ok: password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH,
    },
    {
      id: "classes",
      label: "Mixes at least two of: lowercase, uppercase, numbers, symbols",
      ok: characterClassCount(password) >= 2,
    },
    {
      id: "common",
      label: "Not a common password",
      ok: password.length > 0 && !COMMON_PASSWORDS.has(password.toLowerCase()),
    },
  ];
}

/** A readable sentence describing what is missing, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (characterClassCount(password) < 2) {
    return "Password must mix at least two of: lowercase letters, uppercase letters, numbers, symbols.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "This password is too common. Choose another.";
  return null;
}

export const WEAK_PASSWORD_CODE = "WEAK_PASSWORD";

/** Throws a ConvexError (its message survives on production deployments) when the password is too weak. */
export function validatePassword(password: unknown): void {
  const problem = typeof password === "string" ? passwordProblem(password) : "Enter a password.";
  if (problem !== null) throw new ConvexError({ code: WEAK_PASSWORD_CODE, message: problem });
}
