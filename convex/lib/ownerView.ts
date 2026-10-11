import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Owner-safe projections (architecture §12): an owner party sees the project summary and owner
 * items (prime change orders), never subcontract sums, bids, SOV, pay-app lines, payments,
 * retainage or AI review internals.
 */

export function ownerProjectSummary(project: Doc<"projects">, gcCompanyName: string | null) {
  return {
    _id: project._id,
    title: project.title,
    location: project.location,
    projectType: project.projectType,
    estBudget: project.estBudget,
    ownerName: project.ownerName ?? null,
    gcCompanyName,
  };
}

/** Prime change orders of a project the owner sees: every one but the GC's drafts. */
export async function ownerChangeOrdersOfProject(ctx: QueryCtx, projectId: Id<"projects">): Promise<Doc<"changeOrders">[]> {
  const rows = await ctx.db
    .query("changeOrders")
    .withIndex("by_projectId_and_scope_and_number", (q) => q.eq("projectId", projectId).eq("scope", "prime"))
    .take(200);
  return rows.filter((co) => co.status !== "draft");
}
