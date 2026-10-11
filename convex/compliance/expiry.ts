import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { formatIsoDate } from "../payApps/g703Math";
import { COMPLIANCE_KIND_LABEL, daysUntil, EXPIRING_WINDOW_DAYS, todayIso } from "../lib/complianceRules";
import { notify } from "../lib/notify";
import { itemsFor } from "./status";

/**
 * Daily compliance expiry notifications (architecture §17, §18). Walks accepted compliance records
 * page by page; for each COI or license that is the vendor's current record of its kind and
 * expires within 30 days or has expired, it notifies the sub company and the project's GC company
 * once per record and state (in-app only, no email).
 */

export const EXPIRY_PAGE_SIZE = 100;

type ExpiryState = "expiring" | "expired";

export function complianceItemHash(itemId: Id<"complianceItems">): string {
  return `#/compliance/${itemId}`;
}

function expiryOf(item: Doc<"complianceItems">): string | null {
  if (item.kind === "coi") return item.coi?.expiryDate ?? null;
  if (item.kind === "license") return item.license?.expiryDate ?? null;
  return null;
}

export function expiryStateOn(expiryDate: string, today: string): ExpiryState | null {
  const days = daysUntil(today, expiryDate);
  if (days < 0) return "expired";
  if (days <= EXPIRING_WINDOW_DAYS) return "expiring";
  return null;
}

export function expiryTitle(kind: "coi" | "license", state: ExpiryState): string {
  return `${kind === "coi" ? "Insurance" : "License"} ${state}`;
}

function whenText(expiryDate: string, today: string, state: ExpiryState): string {
  const date = formatIsoDate(expiryDate);
  if (state === "expired") return `expired on ${date}`;
  const days = daysUntil(today, expiryDate);
  return days === 0 ? `expires today (${date})` : `expires in ${days} day${days === 1 ? "" : "s"} (${date})`;
}

/** True when `item` is the newest accepted record of its kind for its vendor on its project. */
async function isCurrent(ctx: MutationCtx, item: Doc<"complianceItems">, cache: Map<string, Set<string>>): Promise<boolean> {
  const key = `${item.projectId}:${item.vendorId}`;
  let current = cache.get(key);
  if (current === undefined) {
    current = new Set();
    const newest = new Map<string, Doc<"complianceItems">>();
    for (const r of await itemsFor(ctx, item.projectId, item.vendorId)) {
      if (r.status !== "accepted") continue;
      const seen = newest.get(r.kind);
      if (seen === undefined || r.createdAt > seen.createdAt) newest.set(r.kind, r);
    }
    for (const r of newest.values()) current.add(r._id);
    cache.set(key, current);
  }
  return current.has(item._id);
}

async function notifyExpiry(ctx: MutationCtx, item: Doc<"complianceItems">, expiryDate: string, state: ExpiryState, today: string): Promise<number> {
  const project = await ctx.db.get(item.projectId);
  if (project === null || project.archived === true) return 0;
  const vendor = await ctx.db.get(item.vendorId);
  const kind = item.kind as "coi" | "license";
  const label = COMPLIANCE_KIND_LABEL[kind].toLowerCase();
  const when = whenText(expiryDate, today, state);
  const title = expiryTitle(kind, state);
  const link = complianceItemHash(item._id);
  const action = state === "expired" ? "Payments are on hold until a current one is accepted." : "Upload a renewed one before it expires.";
  let rows = 0;
  rows += await notify(ctx, { companyId: item.companyId }, {
    kind: state === "expired" ? "compliance_expired" : "compliance_expiring",
    title,
    body: `Your ${label} on ${project.title} ${when}. ${action}`,
    link,
    projectId: project._id,
  });
  rows += await notify(ctx, { companyId: item.gcCompanyId }, {
    kind: state === "expired" ? "compliance_expired" : "compliance_expiring",
    title,
    body: `${vendor?.name ?? "A subcontractor"}'s ${label} on ${project.title} ${when}.`,
    link,
    projectId: project._id,
  });
  return rows;
}

export const runExpiryNotifications = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const today = todayIso(now);
    const page = await ctx.db
      .query("complianceItems")
      .withIndex("by_status", (q) => q.eq("status", "accepted"))
      .paginate({ numItems: EXPIRY_PAGE_SIZE, cursor: args.cursor ?? null });
    const cache = new Map<string, Set<string>>();
    let notices = 0;
    let rows = 0;
    for (const item of page.page) {
      const expiryDate = expiryOf(item);
      if (expiryDate === null) continue;
      const state = expiryStateOn(expiryDate, today);
      if (state === null) continue;
      if (!(await isCurrent(ctx, item, cache))) continue;
      const seen = await ctx.db
        .query("complianceExpiryNotices")
        .withIndex("by_complianceItemId_and_state", (q) => q.eq("complianceItemId", item._id).eq("state", state))
        .first();
      if (seen !== null) continue;
      await ctx.db.insert("complianceExpiryNotices", { complianceItemId: item._id, state, expiryDate, createdAt: now });
      notices++;
      rows += await notifyExpiry(ctx, item, expiryDate, state, today);
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.compliance.expiry.runExpiryNotifications, { cursor: page.continueCursor });
    }
    return { scanned: page.page.length, notices, notificationRows: rows, isDone: page.isDone };
  },
});
