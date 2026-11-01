import { ConvexError } from "convex/values";

/**
 * Readable messages for the sign-in screens. The server sends ConvexErrors with `{ code, message }`
 * (convex/lib/authErrors.ts) or the rate limiter's `{ kind: "RateLimited", name, retryAfter }`;
 * anything else (including production's redacted "Server Error") gets a fixed fallback per step.
 */

export type AuthStep = "signIn" | "signUp" | "verify" | "resend" | "resetRequest" | "resetVerify";

export type AuthErrorInfo = { code: string; message: string; retryAfterMs?: number; limitName?: string };

const FALLBACK: Record<AuthStep, string> = {
  signIn: "Invalid email or password.",
  signUp: "We couldn't create the account. Check the details and try again.",
  verify: "Invalid or expired code. Check the latest email or request a new code.",
  resend: "We couldn't send a new code. Try again in a minute.",
  resetRequest: "We couldn't start the reset. Try again in a minute.",
  resetVerify: "Invalid or expired code. Check the latest email or request a new code.",
};

function errorData(err: unknown): Record<string, unknown> | null {
  if (err instanceof ConvexError && err.data && typeof err.data === "object") return err.data as Record<string, unknown>;
  // ConvexError instances can lose their prototype across bundles; the shape is what matters.
  const data = (err as { data?: unknown } | null)?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function waitText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function describeAuthError(err: unknown, step: AuthStep): AuthErrorInfo {
  const data = errorData(err);
  if (data?.kind === "RateLimited") {
    const retryAfterMs = typeof data.retryAfter === "number" ? data.retryAfter : 60_000;
    const name = String(data.name ?? "");
    const message = name.startsWith("signUp")
      ? `Too many new accounts right now. Try again in ${waitText(retryAfterMs)}.`
      : name === "authEmailCooldown"
        ? `Wait ${waitText(retryAfterMs)} before requesting another code.`
        : `Too many code emails requested. Try again in ${waitText(retryAfterMs)}.`;
    return { code: "RATE_LIMITED", message, retryAfterMs, limitName: name };
  }
  if (data && typeof data.message === "string" && typeof data.code === "string") {
    return { code: data.code, message: data.message };
  }
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/Failed to fetch|NetworkError|network error|WebSocket/i.test(raw)) {
    return { code: "NETWORK", message: "Could not reach the server. Check your connection and try again." };
  }
  return { code: "UNKNOWN", message: FALLBACK[step] };
}

export function authErrorMessage(err: unknown, step: AuthStep): string {
  return describeAuthError(err, step).message;
}

/** Every call to Convex Auth uses the trimmed, lowercased address (the server rejects anything else). */
export function normalizeEmailInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailInputProblem(raw: string): string | null {
  const email = normalizeEmailInput(raw);
  if (email.length === 0) return "Enter your email address.";
  if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(email)) return "Enter a valid email address, like name@company.com.";
  return null;
}
