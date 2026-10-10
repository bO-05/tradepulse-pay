import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { exclusionOwner } from "./lib/exclusionOwnership";

/**
 * Backfill (§15): writes `source` on every exclusion row stored before ownership existed, using the
 * same rule the revision paths apply, and fills a missing `bids.exclusions` from the bidder-owned
 * rows. Idempotent; page through with the returned cursor until `isDone`.
 */

export function ownershipBackfill(bid: Pick<Doc<"bids">, "identifiedExclusions" | "exclusions">) {
  const identifiedExclusions = bid.identifiedExclusions.map((e) =>
    e.source !== undefined ? e : { ...e, source: exclusionOwner(e, bid.exclusions) },
  );
  const exclusions = bid.exclusions ?? identifiedExclusions.filter((e) => e.source === "bidder").map((e) => e.description);
  const changed = bid.exclusions === undefined || bid.identifiedExclusions.some((e) => e.source === undefined);
  return { changed, identifiedExclusions, exclusions };
}

export const tagExclusionOwners = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("bids").paginate({ numItems: 100, cursor: args.cursor ?? null });
    const fixed: { bidId: Id<"bids">; gcRows: number; bidderRows: number; filledExclusions: boolean }[] = [];
    for (const bid of page.page) {
      const next = ownershipBackfill(bid);
      if (!next.changed) continue;
      const untagged = next.identifiedExclusions.filter((_, i) => bid.identifiedExclusions[i].source === undefined);
      fixed.push({
        bidId: bid._id,
        gcRows: untagged.filter((e) => e.source === "gc").length,
        bidderRows: untagged.filter((e) => e.source === "bidder").length,
        filledExclusions: bid.exclusions === undefined,
      });
      if (!args.dryRun) {
        await ctx.db.patch(bid._id, { identifiedExclusions: next.identifiedExclusions, exclusions: next.exclusions });
      }
    }
    return { fixed, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
