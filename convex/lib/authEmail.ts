import { Email } from "@convex-dev/auth/providers/Email";
import type { EmailConfig } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { isUndeliverableEmail } from "./authErrors";
import { sendEmail, SYSTEM_SENDER_NAME, type MailerCtx, type SendEmailResult } from "./mailer";

/**
 * Convex Auth email-code providers for sign-up verification and password reset (architecture §13).
 * `Email` from @convex-dev/auth binds a code to the address it was issued for, so a code can't be
 * redeemed against another account. Codes are typed in; never put them in a `?code=` URL because
 * ConvexAuthProvider consumes that parameter on page load.
 */

export const AUTH_CODE_LENGTH = 8;
export const AUTH_CODE_TTL_SECONDS = 15 * 60;
export const VERIFY_PROVIDER_ID = "agentmail-verify";
export const RESET_PROVIDER_ID = "agentmail-reset";

export type AuthCodeKind = "verify" | "reset";

export function randomDigits(length: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(16);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      // Rejection sampling: 250 is the largest multiple of 10 below 256, so digits stay uniform.
      if (byte < 250 && out.length < length) out.push(String(byte % 10));
    }
  }
  return out.join("");
}

export function authCodeEmail(kind: AuthCodeKind, code: string): { subject: string; text: string; html: string } {
  const minutes = Math.round(AUTH_CODE_TTL_SECONDS / 60);
  const subject =
    kind === "verify" ? `${SYSTEM_SENDER_NAME}: verify your email` : `${SYSTEM_SENDER_NAME}: reset your password`;
  const intro =
    kind === "verify"
      ? `Enter this code in ${SYSTEM_SENDER_NAME} to verify your email address:`
      : `Enter this code in ${SYSTEM_SENDER_NAME} to choose a new password:`;
  const ignore =
    kind === "verify"
      ? "If you did not create an account, you can ignore this email."
      : "If you did not ask to reset your password, you can ignore this email. Your password has not changed.";
  const text = `${intro}\n\n${code}\n\nThe code expires in ${minutes} minutes.\n${ignore}\n\n${SYSTEM_SENDER_NAME}`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a">` +
    `<p>${intro}</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:Menlo,Consolas,monospace">${code}</p>` +
    `<p>The code expires in ${minutes} minutes.</p>` +
    `<p style="color:#475569">${ignore}</p>` +
    `<p style="color:#475569">${SYSTEM_SENDER_NAME}</p>` +
    `</div>`;
  return { subject, text, html };
}

export function emailLimitError() {
  return new ConvexError({
    code: "EMAIL_LIMIT",
    message: "Today's email limit is reached, so no code was sent. Try again tomorrow.",
  });
}

/** Turns a mailer result into what the sign-in screens show; only a real send counts as success. */
export function assertAuthCodeSent(result: SendEmailResult): void {
  if (result.status === "sent") return;
  if (result.status === "skipped_budget") throw emailLimitError();
  throw new ConvexError({
    code: "EMAIL_FAILED",
    message: "We couldn't send the code email. Try again in a few minutes.",
  });
}

export async function sendAuthCode(
  ctx: MailerCtx,
  args: { kind: AuthCodeKind; email: string; code: string },
): Promise<void> {
  if (isUndeliverableEmail(args.email)) {
    // Seeded accounts use reserved domains; sending there would only burn the shared daily quota.
    throw new ConvexError({ code: "EMAIL_FAILED", message: "This address can't receive email, so no code was sent." });
  }
  await ctx.runMutation(internal.authLimits.consumeAuthEmailSend, { email: args.email });
  const message = authCodeEmail(args.kind, args.code);
  const result = await sendEmail(ctx, {
    kind: "auth_code",
    from: "system",
    to: args.email,
    ...message,
    idempotencyKey: `auth.${args.kind}.${crypto.randomUUID()}`,
    redact: [args.code],
  });
  assertAuthCodeSent(result);
}

function authCodeProvider(id: string, kind: AuthCodeKind) {
  return Email({
    id,
    maxAge: AUTH_CODE_TTL_SECONDS,
    async generateVerificationToken() {
      return randomDigits(AUTH_CODE_LENGTH);
    },
    // Convex Auth passes its action ctx as a second argument (signIn.ts), though the type omits it.
    sendVerificationRequest: (async (params: { identifier: string; token: string }, ctx: MailerCtx) => {
      await sendAuthCode(ctx, { kind, email: params.identifier, code: params.token });
    }) as unknown as EmailConfig["sendVerificationRequest"],
  });
}

export const VerifyEmailCode = authCodeProvider(VERIFY_PROVIDER_ID, "verify");
export const ResetPasswordCode = authCodeProvider(RESET_PROVIDER_ID, "reset");
