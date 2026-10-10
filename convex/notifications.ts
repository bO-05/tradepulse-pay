import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { notFound, requireCompanyMember } from "./lib/tenancy";

/**
 * The signed-in user's in-app notifications (architecture §18). Rows are per user and per company;
 * the company always comes from the session, so a user never sees another user's or company's rows.
 */

export const BELL_LIMIT = 8;
const UNREAD_COUNT_CAP = 99;

function publicRow(n: Doc<"notifications">) {
  return {
    _id: n._id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    read: n.readAt !== undefined,
    readAt: n.readAt ?? null,
    createdAt: n.createdAt,
  };
}

/** Bell data: unread count (capped, `unreadCapped` when more) and the newest few notifications. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    // Billing agents and users without a company have no notifications; the bell then shows nothing.
    const member = await requireCompanyMember(ctx).catch(() => null);
    if (member === null) return { unreadCount: 0, unreadCapped: false, latest: [], hasMore: false };
    const { user, company } = member;
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_companyId_and_readAt", (q) => q.eq("userId", user._id).eq("companyId", company._id).eq("readAt", undefined))
      .take(UNREAD_COUNT_CAP + 1);
    const latest = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_companyId_and_createdAt", (q) => q.eq("userId", user._id).eq("companyId", company._id))
      .order("desc")
      .take(BELL_LIMIT + 1);
    return {
      unreadCount: Math.min(unread.length, UNREAD_COUNT_CAP),
      unreadCapped: unread.length > UNREAD_COUNT_CAP,
      latest: latest.slice(0, BELL_LIMIT).map(publicRow),
      hasMore: latest.length > BELL_LIMIT,
    };
  },
});

/** All of the caller's notifications, newest first, paginated ("See all" page). */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { user, company } = await requireCompanyMember(ctx);
    const result = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_companyId_and_createdAt", (q) => q.eq("userId", user._id).eq("companyId", company._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(publicRow) };
  },
});

/** Marks one of the caller's notifications read. Anyone else's id reads as "Not found.". */
export const markRead = mutation({
  args: { notificationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, company } = await requireCompanyMember(ctx);
    const id = ctx.db.normalizeId("notifications", args.notificationId);
    const row = id === null ? null : await ctx.db.get(id);
    if (row === null || row.userId !== user._id || row.companyId !== company._id) throw notFound();
    if (row.readAt === undefined) await ctx.db.patch(row._id, { readAt: Date.now() });
    return null;
  },
});

export const MARK_ALL_BATCH = 1000;

/** Marks one bounded batch read and schedules the next one while unread rows remain. */
async function markReadBatch(ctx: MutationCtx, userId: Id<"users">, companyId: Id<"companies">): Promise<number> {
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_userId_and_companyId_and_readAt", (q) => q.eq("userId", userId).eq("companyId", companyId).eq("readAt", undefined))
    .take(MARK_ALL_BATCH);
  const now = Date.now();
  for (const n of unread) await ctx.db.patch(n._id, { readAt: now });
  if (unread.length === MARK_ALL_BATCH) {
    await ctx.scheduler.runAfter(0, internal.notifications.markAllReadContinue, { userId, companyId });
  }
  return unread.length;
}

/**
 * Marks every unread notification of the caller read. The first batch is marked in this call and the
 * rest in scheduled batches. Returns how many this call changed.
 */
export const markAllRead = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const { user, company } = await requireCompanyMember(ctx);
    return await markReadBatch(ctx, user._id, company._id);
  },
});

export const markAllReadContinue = internalMutation({
  args: { userId: v.id("users"), companyId: v.id("companies") },
  returns: v.null(),
  handler: async (ctx, { userId, companyId }) => {
    await markReadBatch(ctx, userId, companyId);
    return null;
  },
});
