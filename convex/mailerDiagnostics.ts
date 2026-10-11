import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { brandedHtml, sendEmail } from "./lib/mailer";

/**
 * Operator check of the real send path (one AgentMail send, counted in the budget):
 *   npx convex run mailerDiagnostics:sendTestEmail '{"to":"<mail.tm address>"}'
 */
export const sendTestEmail = internalAction({
  args: { to: v.string(), idempotencyKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const text = "This is a test message from TradePulse Pay. It confirms that the system sender can deliver email.\n\nNo action is needed.";
    return await sendEmail(ctx, {
      kind: "other",
      from: "system",
      to: args.to,
      subject: "TradePulse Pay test email",
      text,
      html: brandedHtml(text),
      idempotencyKey: args.idempotencyKey ?? `test.${Date.now()}`,
    });
  },
});
