import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { notificationKindValidator } from "../schema";

/**
 * In-app notifications (architecture §18). The only writer of the `notifications` table. Nothing here
 * sends email: notifications are in-app only so the shared free AgentMail budget stays for auth codes,
 * invites and RFQs.
 */

export type NotificationKind = Infer<typeof notificationKindValidator>;
export type NotificationTarget = { companyId: Id<"companies"> } | { userId: Id<"users"> };
export type NotificationInput = {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Hash route opened when the notification is clicked. */
  link: string;
  projectId?: Id<"projects">;
};

export const NOTIFICATION_TITLE_MAX = 140;
export const NOTIFICATION_BODY_MAX = 400;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Long opaque strings (tokens, codes, keys) never belong in a notification.
const OPAQUE = /\b[A-Za-z0-9_-]{24,}\b/g;
const CODE = /\b\d{6,}\b/g;

/** Strips anything that looks like an email address, token or numeric code, then trims to `max`. */
export function sanitizeNotificationText(raw: string, max: number): string {
  const clean = raw.replace(EMAIL, "[email hidden]").replace(OPAQUE, "[hidden]").replace(CODE, "[hidden]").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function safeLink(link: string): string {
  return /^#\/[A-Za-z0-9/_-]*$/.test(link) ? link : "#/";
}

/** True when the company is the project's GC or an active member of it. */
export async function companyOnProject(ctx: QueryCtx, companyId: Id<"companies">, projectId: Id<"projects">): Promise<boolean> {
  const project = await ctx.db.get(projectId);
  if (project === null) return false;
  if (project.gcCompanyId === companyId) return true;
  const rows = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_company_and_status", (q) => q.eq("projectId", projectId).eq("companyId", companyId).eq("status", "active"))
    .take(1);
  return rows.length > 0;
}

async function recipientsOf(ctx: MutationCtx, companyId: Id<"companies">): Promise<Id<"users">[]> {
  const members = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .take(200);
  const out: Id<"users">[] = [];
  for (const m of members) {
    if (m.status !== "active") continue;
    const user = await ctx.db.get(m.userId);
    if (user === null || user.actorType === "agent") continue;
    out.push(user._id);
  }
  return out;
}

async function activeCompanyOf(ctx: MutationCtx, userId: Id<"users">): Promise<Doc<"companies"> | null> {
  const membership = await ctx.db
    .query("companyMembers")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .first();
  return membership === null ? null : await ctx.db.get(membership.companyId);
}

/**
 * Creates one notification row per recipient: every active human member of a company, or one user (in
 * their current company). With a projectId, a company that has no access to that project gets nothing,
 * so a notification can never reach a company outside the project. Returns the number of rows written.
 */
export async function notify(ctx: MutationCtx, target: NotificationTarget, input: NotificationInput): Promise<number> {
  let companyId: Id<"companies">;
  let userIds: Id<"users">[];
  if ("companyId" in target) {
    const company = await ctx.db.get(target.companyId);
    if (company === null) return 0;
    companyId = company._id;
    userIds = await recipientsOf(ctx, companyId);
  } else {
    const user = await ctx.db.get(target.userId);
    if (user === null || user.actorType === "agent") return 0;
    const company = await activeCompanyOf(ctx, user._id);
    if (company === null) return 0;
    companyId = company._id;
    userIds = [user._id];
  }
  if (input.projectId !== undefined && !(await companyOnProject(ctx, companyId, input.projectId))) return 0;
  const title = sanitizeNotificationText(input.title, NOTIFICATION_TITLE_MAX);
  const body = sanitizeNotificationText(input.body, NOTIFICATION_BODY_MAX);
  const link = safeLink(input.link);
  const now = Date.now();
  for (const userId of userIds) {
    await ctx.db.insert("notifications", {
      userId,
      companyId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      kind: input.kind,
      title,
      body,
      link,
      createdAt: now,
    });
  }
  return userIds.length;
}
