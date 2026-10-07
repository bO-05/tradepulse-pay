import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

const BATCH = 200;

/**
 * Copies each pay app's agreement contractor onto rows created before `contractorId` was stored,
 * so the sub portal's by_contractorId pagination sees them. Idempotent; schedules itself until done:
 *   npx convex run payApps/backfill:backfillPayAppContractorIds '{}'
 */
export const backfillPayAppContractorIds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("payApplications").paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    let patched = 0;
    for (const p of page.page) {
      if (p.contractorId !== undefined) continue;
      const agreement = await ctx.db.get(p.agreementId);
      if (agreement?.contractorId === undefined) continue;
      await ctx.db.patch(p._id, { contractorId: agreement.contractorId });
      patched++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.payApps.backfill.backfillPayAppContractorIds, { cursor: page.continueCursor });
    }
    return { patched, isDone: page.isDone };
  },
});
