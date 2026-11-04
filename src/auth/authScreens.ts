export type VerifyScreen = {
  kind: "verify";
  email: string;
  /** Kept in memory only, so "Resend code" can repeat the sign-in that sends a new code. */
  password: string;
  /** A refused sign-up send may precede account creation; retry sign-up with its original name. */
  signUpName?: string;
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

/** Code-send failures can also be raised by preflight, before a sign-up creates its account. */
const CODE_SEND_ERRORS = new Set(["EMAIL_LIMIT", "EMAIL_FAILED", "EMAIL_BLOCKED"]);

export function isCodeSendError(info: { code: string; limitName?: string }): boolean {
  if (CODE_SEND_ERRORS.has(info.code)) return true;
  return info.code === "RATE_LIMITED" && (info.limitName ?? "").startsWith("authEmail");
}

export function verificationResendParams(screen: VerifyScreen): Record<string, string> {
  const credentials = { email: screen.email, password: screen.password };
  return screen.signUpName === undefined
    ? { ...credentials, flow: "signIn" }
    : { ...credentials, flow: "signUp", name: screen.signUpName };
}
