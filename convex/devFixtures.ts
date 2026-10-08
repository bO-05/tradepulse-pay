import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { DEMO_PASSWORD } from "./demoAccounts";
import { findActiveMembership } from "./lib/tenancy";

/**
 * Dev-only isolation fixture: a signed-in GC of a second, non-demo GC company with no projects,
 * used to check that Demo company data never shows up for another company. CLI only:
 *   npx convex run devFixtures:ensureIsolationGc '{}'
 * Idempotent; the address uses the reserved .test TLD and never receives mail.
 */
export const ISOLATION_GC_EMAIL = "isolation-gc@tenancy-check.test";
const ISOLATION_GC_COMPANY = "Isolation Check GC (dev fixture)";

export const attachIsolationGc = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) throw new Error("Fixture user missing.");
    if (user.emailVerificationTime === undefined) await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
    let membership = await findActiveMembership(ctx, user._id);
    if (membership === null) {
      const companyId = await ctx.db.insert("companies", {
        name: ISOLATION_GC_COMPANY,
        kind: "gc",
        isDemo: false,
        createdByUserId: user._id,
        createdAt: Date.now(),
      });
      await ctx.db.insert("companyMembers", { companyId, userId: user._id, role: "admin", status: "active", createdAt: Date.now() });
      membership = await findActiveMembership(ctx, user._id);
    }
    const companyId = membership!.companyId;
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (profile === null) {
      await ctx.db.insert("userProfiles", {
        userId: user._id,
        role: "gc",
        displayName: "Isolation Check GC",
        companyId,
        actorType: "human",
        createdAt: Date.now(),
      });
    }
    return { userId: user._id, companyId };
  },
});

export const ensureIsolationGc = internalAction({
  args: {},
  handler: async (ctx): Promise<{ email: string; userId: string; companyId: string; created: boolean }> => {
    const exists = await ctx.runQuery(internal.demoAccounts.passwordAccountExists, { email: ISOLATION_GC_EMAIL });
    if (exists) {
      await modifyAccountCredentials(ctx, { provider: "password", account: { id: ISOLATION_GC_EMAIL, secret: DEMO_PASSWORD } });
    } else {
      await createAccount(ctx, {
        provider: "password",
        account: { id: ISOLATION_GC_EMAIL, secret: DEMO_PASSWORD },
        profile: { email: ISOLATION_GC_EMAIL, name: "Isolation Check GC" },
      });
    }
    const ids = await ctx.runMutation(internal.devFixtures.attachIsolationGc, { email: ISOLATION_GC_EMAIL });
    return { email: ISOLATION_GC_EMAIL, userId: ids.userId, companyId: ids.companyId, created: !exists };
  },
});
