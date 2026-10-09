import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { initialSovState } from "../payments/sov";

/**
 * Backfills `agreements.sov` for rows written before SOV approval existed: agreements that already
 * have pay apps, payments or retainage keep billing (approved, labelled as legacy); all others are
 * drafts the GC approves in the editor. Only rows without `sov` are touched, so reruns change nothing.
 *   npx convex run billing/sovMigration:backfillSovState '{"dryRun":true}'
 */
export const backfillSovState = internalMutation({
  args: { cursor: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("agreements").paginate({ cursor: args.cursor ?? null, numItems: 100 });
    let approved = 0;
    let drafts = 0;
    for (const a of page.page) {
      if (a.sov !== undefined) continue;
      const sov = await initialSovState(ctx, a._id);
      if (sov.status === "approved") approved += 1;
      else drafts += 1;
      if (!args.dryRun) await ctx.db.patch(a._id, { sov });
    }
    return { approved, drafts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
