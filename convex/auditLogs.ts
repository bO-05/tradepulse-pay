import { query, internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { callerProjects, requireProjectScope } from "./lib/projectScope";
import { requireUser, type ProjectAccess } from "./lib/tenancy";

/** Event types an owner may see without the actor being their own company. */
const OWNER_SAFE_EVENTS = new Set(["package_created", "file_uploaded", "file_deleted", "cron_executed"]);

function visibleToParty(access: ProjectAccess, log: Doc<"auditLogs">): boolean {
  if (access.partyRole === "gc") return true;
  const ownCompany = access.company !== null && log.actorCompanyId === access.company._id;
  if (access.partyRole === "sub") {
    return ownCompany || (log.contractorId !== undefined && access.contractorIds.includes(log.contractorId));
  }
  return ownCompany || (log.contractorId === undefined && OWNER_SAFE_EVENTS.has(log.eventType));
}

async function projectFeed(
  ctx: Parameters<typeof requireProjectScope>[0],
  access: ProjectAccess,
  limit: number,
): Promise<Doc<"auditLogs">[]> {
  const out: Doc<"auditLogs">[] = [];
  const rows = ctx.db
    .query("auditLogs")
    .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
    .order("desc");
  for await (const log of rows) {
    if (visibleToParty(access, log)) out.push(log);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Activity feed for one project, or for every project the caller can access. GC parties see the
 * whole project; subs only their own vendor's events; owners their own and owner-safe events.
 * A project the caller cannot access reads exactly like a deleted one (an empty feed).
 */
export const listRecentLogs = query({
  args: {
    projectId: v.optional(v.id("projects")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    const maxLimit = Math.max(1, Math.min(args.limit ?? 50, 500));

    if (args.projectId) {
      let access: ProjectAccess;
      try {
        access = await requireProjectScope(ctx, args.projectId);
      } catch (error) {
        const code = (error as { data?: { code?: string } }).data?.code;
        if (code === "NOT_FOUND") return [];
        throw error;
      }
      return await projectFeed(ctx, access, maxLimit);
    }

    const merged: Doc<"auditLogs">[] = [];
    for (const project of await callerProjects(ctx)) {
      const access = await requireProjectScope(ctx, project._id);
      merged.push(...(await projectFeed(ctx, access, maxLimit)));
    }
    merged.sort((a, b) => b._creationTime - a._creationTime);
    return merged.slice(0, maxLimit);
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
