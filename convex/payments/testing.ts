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

/**
 * Validator-only helper: ages a created retainage release so it reads as interrupted ("Resume release").
 * Create the row with the real begin step and no send, then backdate it:
 *   npx convex run payments/retainageDb:beginRetainageRelease '{"agreementId":"<id>"}'
 *   npx convex run payments/testing:backdateRetainageRelease '{"paymentId":"<id>","ageMs":600000}'
 */
export const backdateRetainageRelease = internalMutation({
  args: { paymentId: v.id("payments"), ageMs: v.number() },
  returns: v.object({ paymentId: v.id("payments"), status: v.string(), updatedAt: v.number() }),
  handler: async (ctx, { paymentId, ageMs }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null || p.kind !== "retainage_release" || p.status !== "created" || p.paypalPayoutBatchId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "No created retainage release without a PayPal batch." });
    }
    const at = Date.now() - ageMs;
    await ctx.db.patch(p._id, { createdAt: Math.min(p.createdAt, at), updatedAt: at });
    return { paymentId: p._id, status: p.status, updatedAt: at };
  },
});
