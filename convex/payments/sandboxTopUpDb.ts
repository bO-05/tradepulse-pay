import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { requireRole } from "../lib/roles";

/** Database side of the sandbox-only platform top-up (see sandboxTopUp.ts). */

export const MIN_TOP_UP_CENTS = 100;
export const MAX_TOP_UP_CENTS = 2_000_000;

export const recordTopUpCreated = internalMutation({
  args: { paypalOrderId: v.string(), amountCents: v.number(), approveUrl: v.string(), userId: v.id("users") },
  returns: v.id("sandboxTopUps"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sandboxTopUps")
      .withIndex("by_paypalOrderId", (q) => q.eq("paypalOrderId", args.paypalOrderId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("sandboxTopUps", {
      paypalOrderId: args.paypalOrderId,
      amountCents: args.amountCents,
      approveUrl: args.approveUrl,
      status: "created",
      createdBy: args.userId,
      createdAt: Date.now(),
    });
  },
});

export const topUpByOrder = internalQuery({
  args: { paypalOrderId: v.string() },
  handler: async (ctx, { paypalOrderId }) =>
    await ctx.db
      .query("sandboxTopUps")
      .withIndex("by_paypalOrderId", (q) => q.eq("paypalOrderId", paypalOrderId))
      .first(),
});

export const recordTopUpOutcome = internalMutation({
  args: {
    topUpId: v.id("sandboxTopUps"),
    status: v.union(v.literal("captured"), v.literal("failed")),
    paypalCaptureId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.topUpId);
    if (row === null || row.status === "captured") return null;
    await ctx.db.patch(args.topUpId, {
      status: args.status,
      ...(args.paypalCaptureId ? { paypalCaptureId: args.paypalCaptureId, capturedAt: Date.now() } : {}),
      ...(args.error ? { error: args.error.slice(0, 500) } : {}),
    });
    return null;
  },
});

/** The latest sandbox top-ups, GC only. */
export const listTopUps = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const rows = await ctx.db.query("sandboxTopUps").withIndex("by_createdAt").order("desc").take(10);
    return rows.map((r) => ({
      _id: r._id,
      paypalOrderId: r.paypalOrderId,
      amountCents: r.amountCents,
      status: r.status,
      approveUrl: r.status === "created" ? (r.approveUrl ?? null) : null,
      paypalCaptureId: r.paypalCaptureId ?? null,
      error: r.error ?? null,
      createdAt: r.createdAt,
      capturedAt: r.capturedAt ?? null,
    }));
  },
});
