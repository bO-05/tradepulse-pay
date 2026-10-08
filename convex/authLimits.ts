import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { RESEND_COOLDOWN_SECONDS } from "./lib/authErrors";

/**
 * Limits on auth email sends and account creation (architecture §20). Convex Auth only limits
 * failed password/code attempts; sends cost AgentMail quota (100/day for the whole org), so
 * they are limited here. Values are deliberately loose; ops tunes them.
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // One code per address per cooldown; the UI shows the same countdown.
  authEmailCooldown: { kind: "token bucket", rate: 1, period: RESEND_COOLDOWN_SECONDS * 1000, capacity: 1 },
  authEmailPerAddress: { kind: "token bucket", rate: 6, period: HOUR, capacity: 4 },
  authEmailGlobal: { kind: "fixed window", rate: 50, period: 24 * HOUR },
  signUpGlobal: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  signUpBurst: { kind: "token bucket", rate: 5, period: MINUTE, capacity: 5 },
});

const AUTH_EMAIL_LIMITS = ["authEmailCooldown", "authEmailPerAddress", "authEmailGlobal"] as const;

/**
 * Read-only look at whether a code email could go out now, plus the password account's state.
 * Convex Auth stores a new code (replacing the one already emailed) before it calls the sender,
 * so a send refused afterwards would silently invalidate the user's current code.
 */
export const preflightAuthEmail = internalQuery({
  args: { email: v.string() },
  returns: v.object({
    account: v.union(v.literal("none"), v.literal("unverified"), v.literal("verified")),
    limited: v.union(v.null(), v.object({ name: v.string(), retryAfter: v.number() })),
  }),
  handler: async (ctx, { email }) => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
      .unique();
    let limited: { name: string; retryAfter: number } | null = null;
    for (const name of AUTH_EMAIL_LIMITS) {
      const status = await rateLimiter.check(ctx, name, name === "authEmailGlobal" ? {} : { key: email });
      if (!status.ok) {
        limited = { name, retryAfter: status.retryAfter ?? RESEND_COOLDOWN_SECONDS * 1000 };
        break;
      }
    }
    const state = account === null ? "none" : account.emailVerified ? "verified" : "unverified";
    return { account: state as "none" | "verified" | "unverified", limited };
  },
});

export const consumeAuthEmailSend = internalMutation({
  args: { email: v.string() },
  returns: v.null(),
  handler: async (ctx, { email }) => {
    await rateLimiter.limit(ctx, "authEmailCooldown", { key: email, throws: true });
    await rateLimiter.limit(ctx, "authEmailPerAddress", { key: email, throws: true });
    await rateLimiter.limit(ctx, "authEmailGlobal", { throws: true });
    return null;
  },
});
