import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";

const BATCH = 200;

/** Stamps a newly linked contractor's existing pay apps with its sub company (bounded). */
export async function stampPayAppsSubCompany(ctx: MutationCtx, contractorId: Id<"contractors">, subCompanyId: Id<"companies">) {
  const rows = await ctx.db
    .query("payApplications")
    .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
    .take(500);
  for (const p of rows) if (p.subCompanyId === undefined) await ctx.db.patch(p._id, { subCompanyId });
}

/**
 * Copies each pay app's agreement contractor, and that contractor's linked sub company, onto rows
 * created before `contractorId` / `subCompanyId` were stored, so the sub portal's indexed
 * pagination sees them. Idempotent; schedules itself until done:
 *   npx convex run payApps/backfill:backfillPayAppContractorIds '{}'
 */
export const backfillPayAppContractorIds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("payApplications").paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    let patched = 0;
    for (const p of page.page) {
      if (p.contractorId !== undefined && p.subCompanyId !== undefined) continue;
      const patch: Partial<Doc<"payApplications">> = {};
      let contractorId = p.contractorId;
      if (contractorId === undefined) {
        const agreement = await ctx.db.get(p.agreementId);
        contractorId = agreement?.contractorId;
        if (contractorId !== undefined) patch.contractorId = contractorId;
      }
      if (p.subCompanyId === undefined && contractorId !== undefined) {
        const linked = (await ctx.db.get(contractorId))?.linkedCompanyId;
        if (linked !== undefined) patch.subCompanyId = linked;
      }
      if (Object.keys(patch).length === 0) continue;
      await ctx.db.patch(p._id, patch);
      patched++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.payApps.backfill.backfillPayAppContractorIds, { cursor: page.continueCursor });
    }
    return { patched, isDone: page.isDone };
  },
});
