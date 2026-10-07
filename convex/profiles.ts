import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { roleValidator } from "./schema";
import { getViewer, requireRole } from "./lib/roles";

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
    const viewer = await getViewer(ctx);
    if (viewer === null) {
      return {
        userId,
        email: user.email ?? null,
        role: null,
        displayName: user.name ?? user.email ?? "Unassigned account",
        contractorId: null,
        contractorName: null,
        paypalEmail: null,
        actorType: user.actorType ?? "human",
      };
    }
    const contractor = viewer.profile.contractorId ? await ctx.db.get(viewer.profile.contractorId) : null;
    return {
      userId,
      email: user.email ?? null,
      role: viewer.role,
      displayName: viewer.profile.displayName,
      contractorId: viewer.profile.contractorId ?? null,
      contractorName: contractor?.companyName ?? null,
      // A sub sees its own payout address; nobody else's is exposed here.
      paypalEmail: viewer.profile.paypalEmail ?? null,
      actorType: viewer.profile.actorType ?? user.actorType ?? "human",
    };
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
