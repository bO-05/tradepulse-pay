import { ConvexError, v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Validator-only helper (internal, never exposed to clients): moves a funding payment's honor-period
 * end and/or expiry so the honor-period watcher can be exercised on a real authorization, e.g.
 *   npx convex run payments/testing:backdateAuthorization '{"paymentId":"<id>","honorPeriodEndsAt":<ms>}'
 * PayPal still holds the real dates; only the stored row changes.
 */
export const backdateAuthorization = internalMutation({
  args: {
    paymentId: v.id("payments"),
    honorPeriodEndsAt: v.optional(v.number()),
    authorizationExpiresAt: v.optional(v.number()),
  },
  returns: v.object({
    paymentId: v.id("payments"),
    status: v.string(),
    paypalAuthorizationId: v.union(v.string(), v.null()),
    honorPeriodEndsAt: v.union(v.number(), v.null()),
    authorizationExpiresAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null || p.kind !== "funding") {
      throw new ConvexError({ code: "NOT_FOUND", message: "Funding payment not found." });
    }
    if (!p.paypalAuthorizationId) {
      throw new ConvexError({ code: "NOT_AUTHORIZED", message: "This funding payment has no PayPal authorization." });
    }
    const patch: { honorPeriodEndsAt?: number; authorizationExpiresAt?: number; reauthorizeRetryAfter?: undefined } = {};
    if (args.honorPeriodEndsAt !== undefined) patch.honorPeriodEndsAt = args.honorPeriodEndsAt;
    if (args.authorizationExpiresAt !== undefined) patch.authorizationExpiresAt = args.authorizationExpiresAt;
    // A backdated row is meant to be watched right away, so drop any rejection backoff.
    patch.reauthorizeRetryAfter = undefined;
    await ctx.db.patch(p._id, { ...patch, updatedAt: Date.now() });
    const after = (await ctx.db.get(p._id))!;
    return {
      paymentId: after._id,
      status: after.status,
      paypalAuthorizationId: after.paypalAuthorizationId ?? null,
      honorPeriodEndsAt: after.honorPeriodEndsAt ?? null,
      authorizationExpiresAt: after.authorizationExpiresAt ?? null,
    };
  },
});
