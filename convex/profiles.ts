import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { DEMO_ACCOUNTS } from "./demoAccounts";
import { roleValidator } from "./schema";
import { getViewer, requireRole } from "./lib/roles";
import { findActiveMembership } from "./lib/tenancy";

/**
 * The signed-in identity for the app shell. Returns null when signed out, and
 * `role: null` for a signed-in account that has no TradePulse profile.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const rawUserId = await getAuthUserId(ctx);
    const userId = rawUserId === null ? null : ctx.db.normalizeId("users", rawUserId);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const membership = user.actorType === "agent" ? null : await findActiveMembership(ctx, userId);
    const companyDoc = membership === null ? null : await ctx.db.get(membership.companyId);
    // Someone removed from their company sees "not a member" wording instead of first-time onboarding.
    const formerMembership =
      membership !== null || user.actorType === "agent"
        ? null
        : await ctx.db
            .query("companyMembers")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first();
    const account = {
      wasRemovedFromCompany: formerMembership !== null,
      // Agents are verified by AgentID; humans must confirm an emailed code.
      emailVerified: user.actorType === "agent" || user.emailVerificationTime !== undefined,
      company:
        companyDoc === null || membership === null
          ? null
          : { name: companyDoc.name, kind: companyDoc.kind, isDemo: companyDoc.isDemo, memberRole: membership.role },
    };
    const viewer = await getViewer(ctx);
    if (viewer === null) {
      return {
        ...account,
        userId,
        email: user.email ?? null,
        role: null,
        displayName: user.name ?? user.email ?? "Unassigned account",
        contractorId: null,
        contractorName: null,
        paypalEmail: null,
        actorType: user.actorType ?? "human",
        ownerName: user.ownerName ?? null,
        ownerEmail: user.ownerEmail ?? null,
      };
    }
    const contractor = viewer.profile.contractorId ? await ctx.db.get(viewer.profile.contractorId) : null;
    return {
      ...account,
      userId,
      email: user.email ?? null,
      role: viewer.role,
      displayName: viewer.profile.displayName,
      contractorId: viewer.profile.contractorId ?? null,
      contractorName: contractor?.companyName ?? null,
      // A sub sees its own payout address; nobody else's is exposed here.
      paypalEmail: viewer.profile.paypalEmail ?? null,
      actorType: viewer.profile.actorType ?? user.actorType ?? "human",
      ownerName: user.ownerName ?? null,
      ownerEmail: user.ownerEmail ?? null,
    };
  },
});

/**
 * Test-only (internal, CLI): points a sub profile's payout address elsewhere, e.g. at an unclaimable
 * address. Omit `paypalEmail` to restore the demo account's value from its PAYPAL_SANDBOX_* env var.
 *   npx convex run profiles:setPaypalEmailForTesting '{"email":"sub1@demo.tradepulse","paypalEmail":"nobody-1@example.com"}'
 */
export const setPaypalEmailForTesting = internalMutation({
  args: { email: v.string(), paypalEmail: v.optional(v.string()) },
  returns: v.object({ email: v.string(), restoredFromEnv: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) throw new ConvexError({ code: "NOT_FOUND", message: `No user ${args.email}.` });
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (profile === null || profile.role !== "sub") {
      throw new ConvexError({ code: "NOT_FOUND", message: `${args.email} has no sub profile.` });
    }
    let paypalEmail = args.paypalEmail?.trim();
    const restoredFromEnv = paypalEmail === undefined;
    if (paypalEmail === undefined) {
      const envName = DEMO_ACCOUNTS.find((a) => a.email === args.email)?.paypalEmailEnv;
      paypalEmail = envName ? process.env[envName]?.trim() : undefined;
      if (!paypalEmail) {
        throw new ConvexError({ code: "NOT_FOUND", message: `No demo PayPal email env var is set for ${args.email}.` });
      }
    }
    await ctx.db.patch(profile._id, { paypalEmail });
    return { email: args.email, restoredFromEnv };
  },
});

export const requireRoleForAction = internalQuery({
  args: { roles: v.array(roleValidator) },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, args.roles);
    return {
      userId: viewer.userId,
      role: viewer.role,
      profileId: viewer.profile._id,
      contractorId: viewer.profile.contractorId,
    };
  },
});
