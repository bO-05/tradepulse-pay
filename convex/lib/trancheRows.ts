import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_TRANCHES_PER_AGREEMENT, TRANCHE_CAPACITY_MESSAGE } from "../billing/trancheRules";

/**
 * Every funding tranche (milestones row) of an agreement, in order. Throws instead of returning a
 * partial list when the agreement holds more than MAX_TRANCHES_PER_AGREEMENT, so no cap, order
 * position or funding source is ever computed from a truncated read.
 */
export async function loadTranches(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"milestones">[]> {
  const rows = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(MAX_TRANCHES_PER_AGREEMENT + 1);
  if (rows.length > MAX_TRANCHES_PER_AGREEMENT) throw new ConvexError({ code: "TRANCHE_CAPACITY", message: TRANCHE_CAPACITY_MESSAGE });
  return rows;
}
