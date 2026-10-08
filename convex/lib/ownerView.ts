import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isNotFoundError, requireProjectScope } from "./projectScope";

/**
 * Owner-safe projections (architecture §12): an owner party sees the project summary and owner
 * items (change orders invoiced to it), never subcontract sums, bids, SOV, pay-app lines, payments,
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

/**
 * The agreement behind a change-order list, when the caller is the owner party on its project.
 * Null for anyone else and for missing ids, so the caller can answer "Not found.".
 */
export async function ownerAgreementForChangeOrders(ctx: QueryCtx, agreementId: string): Promise<Doc<"agreements"> | null> {
  const id = ctx.db.normalizeId("agreements", agreementId);
  const agreement = id === null ? null : await ctx.db.get(id);
  if (agreement === null || agreement.status === "superseded") return null;
  try {
    await requireProjectScope(ctx, agreement.projectId, { roles: ["owner"] });
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  return agreement;
}

/** Non-draft change orders on a project, i.e. the ones invoiced (or once invoiced) to the owner. */
export async function ownerChangeOrdersOfProject(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<{ agreement: Doc<"agreements">; changeOrder: Doc<"changeOrders"> }[]> {
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(100);
  const out = [];
  for (const agreement of agreements) {
    const cos = await ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreement._id))
      .take(100);
    for (const changeOrder of cos) {
      if (changeOrder.status !== "draft") out.push({ agreement, changeOrder });
    }
  }
  return out;
}
