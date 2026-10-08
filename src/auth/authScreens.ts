export type VerifyScreen = {
  kind: "verify";
  email: string;
  /** Kept in memory only, so "Resend code" can repeat the sign-in that sends a new code. */
  password: string;
  codeSent: boolean;
  notice?: string;
  error?: string;
  /** Server-reported wait before another code can be sent, when the send was rate limited. */
  retryAfterMs?: number;
};

export type AuthScreen =
  | { kind: "signIn"; email?: string; notice?: string }
  | { kind: "signUp" }
  | VerifyScreen
  | { kind: "forgot"; email?: string };

/** Errors raised after the password was accepted, while sending a code: the account exists but isn't verified. */
const CODE_SEND_ERRORS = new Set(["EMAIL_LIMIT", "EMAIL_FAILED"]);

export function isCodeSendError(info: { code: string; limitName?: string }): boolean {
  if (CODE_SEND_ERRORS.has(info.code)) return true;
  return info.code === "RATE_LIMITED" && (info.limitName ?? "").startsWith("authEmail");
}
