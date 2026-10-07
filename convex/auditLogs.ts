import { query, internalMutation } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { v } from "convex/values";

/**
 * Live Reactive Activity Audit Stream:
 * Provides a real-time WebSocket audit log of all project procurement activities
 * (RFQ dispatch, pre-bid RFI clarification, quote submission, leveling, contracts, file uploads, crons).
 */
export const listRecentLogs = query({
  args: {
    projectId: v.optional(v.id("projects")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc", "owner"]);
    const maxLimit = args.limit ?? 50;

    // Audit history outlives deleted projects but is not shown for them.
    if (args.projectId) {
      if ((await ctx.db.get(args.projectId)) === null) return [];
      return await ctx.db
        .query("auditLogs")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId!))
        .order("desc")
        .take(maxLimit);
    }

    const recent = await ctx.db
      .query("auditLogs")
      .order("desc")
      .take(maxLimit);
    const live = new Map<string, boolean>();
    const visible = [];
    for (const log of recent) {
      if (log.projectId === undefined) {
        visible.push(log);
        continue;
      }
      let exists = live.get(log.projectId);
      if (exists === undefined) {
        exists = (await ctx.db.get(log.projectId)) !== null;
        live.set(log.projectId, exists);
      }
      if (exists) visible.push(log);
    }
    return visible;
  },
});

export const recordLog = internalMutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    eventType: v.string(),
    title: v.string(),
    description: v.string(),
    actor: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("auditLogs", {
      ...args,
      timestamp: Date.now(),
    });
  },
});

export const recordLogInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    eventType: v.string(),
    title: v.string(),
    description: v.string(),
    actor: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("auditLogs", {
      ...args,
      timestamp: Date.now(),
    });
  },
});
