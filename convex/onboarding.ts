import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { normalizeCompanyProfile, validateCompanyProfile } from "./lib/companyProfile";
import { findActiveMembership, requireVerifiedUser } from "./lib/tenancy";

/**
 * Self-serve GC onboarding (architecture §13): a verified person with no company creates a GC
 * company and becomes its admin. Company, membership and profile are written in this one
 * transaction. The company is never chosen by the client; the args validator rejects extra fields.
 */
export const createCompany = mutation({
  args: {
    name: v.string(),
    address: v.object({
      line1: v.string(),
      line2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    }),
    phone: v.string(),
  },
  returns: v.object({ companyId: v.id("companies") }),
  handler: async (ctx, args) => {
    const user = await requireVerifiedUser(ctx);
    if (user.actorType === "agent") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: billing agents can't create companies." });
    }
    if ((await findActiveMembership(ctx, user._id)) !== null) {
      throw new ConvexError({ code: "ALREADY_ONBOARDED", message: "You already belong to a company." });
    }
    const errors = validateCompanyProfile(args);
    const firstError = Object.values(errors)[0];
    if (firstError !== undefined) {
      throw new ConvexError({ code: "INVALID", message: firstError, fields: errors });
    }
    const profile = normalizeCompanyProfile(args);
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", {
      name: profile.name,
      kind: "gc",
      isDemo: false,
      address: profile.address,
      phone: profile.phone,
      createdByUserId: user._id,
      createdAt: now,
    });
    await ctx.db.insert("companyMembers", { companyId, userId: user._id, role: "admin", status: "active", createdAt: now });

    const displayName = user.name?.trim() || user.email || "Company admin";
    const existingProfile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (existingProfile === null) {
      await ctx.db.insert("userProfiles", {
        userId: user._id,
        role: "gc",
        displayName,
        actorType: "human",
        companyId,
        createdAt: now,
      });
    } else {
      // A pre-tenancy account without a company keeps its row but takes the new company's role.
      await ctx.db.patch(existingProfile._id, { role: "gc", companyId, contractorId: undefined, paypalEmail: undefined });
    }
    return { companyId };
  },
});
