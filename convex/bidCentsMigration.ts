import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";

/**
 * One-time, idempotent backfill of legacy dollar bid amounts into the integer-cents fields
 * (`*Cents` = round(legacy x 100)). This is the only code that reads the legacy dollar fields.
 * Run: `npx convex run bidCentsMigration:backfillBidCents '{}'` (continues itself page by page),
 * then `npx convex run bidCentsMigration:bidCentsReport '{}'`.
 */

function legacyCents(dollars: number | undefined): number | undefined {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return undefined;
  return Math.round(dollars * 100);
}

/** The patch that gives a legacy row its cents fields; null when nothing is missing. */
export function bidCentsPatch(bid: Doc<"bids">): Partial<Doc<"bids">> | null {
  const patch: Partial<Doc<"bids">> = {};
  const top: Array<[keyof Doc<"bids">, keyof Doc<"bids">]> = [
    ["baseAmountCents", "baseBidAmount"],
    ["leveledTotalCents", "leveledTotalCost"],
    ["leadTimePenaltyCents", "leadTimePenalty"],
    ["coiPenaltyCents", "coiPenalty"],
  ];
  for (const [centsKey, dollarKey] of top) {
    if (bid[centsKey] === undefined) {
      const cents = legacyCents(bid[dollarKey] as number | undefined) ?? 0;
      (patch as Record<string, unknown>)[centsKey] = cents;
    }
  }
  if (bid.lineItems.some((li) => li.unitCostCents === undefined || li.totalCostCents === undefined)) {
    patch.lineItems = bid.lineItems.map((li) => ({
      ...li,
      unitCostCents: li.unitCostCents ?? legacyCents(li.unitCost) ?? 0,
      totalCostCents: li.totalCostCents ?? legacyCents(li.totalCost) ?? 0,
    }));
  }
  if (bid.identifiedExclusions.some((e) => e.costImpactCents === undefined)) {
    patch.identifiedExclusions = bid.identifiedExclusions.map((e) => ({
      ...e,
      costImpactCents: e.costImpactCents ?? legacyCents(e.costImpact) ?? 0,
    }));
  }
  const ve = bid.valueEngineeringAlternates ?? [];
  if (ve.some((a) => a.costDeductCents === undefined)) {
    patch.valueEngineeringAlternates = ve.map((a) => ({
      ...a,
      costDeductCents: a.costDeductCents ?? legacyCents(a.costDeduct) ?? 0,
    }));
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Where a pre-portal bid came from: a quote file, a routed bidder email, or unknown. */
async function legacySource(
  ctx: MutationCtx,
  bid: Doc<"bids">,
): Promise<{ source: Doc<"bids">["source"]; sourceInboundEmailId?: Id<"inboundEmails"> }> {
  if (bid.sourceFileId) return { source: "document_ai" };
  const messages = await ctx.db
    .query("inboundEmails")
    .withIndex("by_tradePackageId", (q) => q.eq("tradePackageId", bid.tradePackageId))
    .take(500);
  const fromBidder = messages
    .filter((m) => m.routing === "routed" && m.contractorId === bid.contractorId && m.receivedAt <= bid.receivedAt + 60_000)
    .sort((a, b) => b.receivedAt - a.receivedAt);
  if (fromBidder.length > 0) return { source: "email_ai", sourceInboundEmailId: fromBidder[0]._id };
  return { source: "legacy" };
}

export const backfillBidCents = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), revisionsCreated: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("bids").paginate({ cursor: args.cursor ?? null, numItems: 100 });
    let patched = 0;
    let revisionsCreated = 0;
    for (const bid of page.page) {
      const patch: Partial<Doc<"bids">> = bidCentsPatch(bid) ?? {};
      if (bid.source === undefined) Object.assign(patch, await legacySource(ctx, bid));
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(bid._id, patch);
        patched += 1;
      }
      const hasRevision = await ctx.db
        .query("bidRevisions")
        .withIndex("by_bid_and_revision", (q) => q.eq("bidId", bid._id))
        .first();
      if (hasRevision === null) {
        const merged = { ...bid, ...patch } as Doc<"bids">;
        await ctx.db.insert("bidRevisions", {
          bidId: bid._id,
          tradePackageId: bid.tradePackageId,
          contractorId: bid.contractorId,
          revisionNumber: bid.revisionNumber ?? 1,
          source: merged.source ?? "legacy",
          baseAmountCents: merged.baseAmountCents ?? 0,
          alternates: merged.alternates ?? [],
          exclusions: merged.exclusions ?? merged.identifiedExclusions.map((e) => e.description),
          inclusions: merged.inclusions ?? [],
          unitPrices: merged.unitPrices ?? [],
          ...(merged.qualifications !== undefined ? { qualifications: merged.qualifications } : {}),
          ...(merged.validUntil !== undefined ? { validUntil: merged.validUntil } : {}),
          ...(merged.sourceInboundEmailId ? { sourceInboundEmailId: merged.sourceInboundEmailId } : {}),
          submittedByName: bid.subcontractorName,
          createdAt: bid.lastRevisedAt ?? bid.receivedAt,
        });
        revisionsCreated += 1;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.bidCentsMigration.backfillBidCents, { cursor: page.continueCursor });
    }
    return { patched, revisionsCreated, isDone: page.isDone };
  },
});

/** Verification counts for the backfill (read-only). */
export const bidCentsReport = internalQuery({
  args: {},
  handler: async (ctx) => {
    let total = 0;
    let missingCents = 0;
    let legacyWithoutCents = 0;
    let mismatches = 0;
    let withoutRevision = 0;
    for await (const bid of ctx.db.query("bids")) {
      total += 1;
      const hasLegacy = bid.baseBidAmount !== undefined || bid.leveledTotalCost !== undefined;
      const missing = bidCentsPatch(bid) !== null;
      if (missing) missingCents += 1;
      if (hasLegacy && missing) legacyWithoutCents += 1;
      const pairs: Array<[number | undefined, number | undefined]> = [
        [bid.baseAmountCents, bid.baseBidAmount],
        [bid.leveledTotalCents, bid.leveledTotalCost],
        [bid.leadTimePenaltyCents, bid.leadTimePenalty],
        [bid.coiPenaltyCents, bid.coiPenalty],
      ];
      if (pairs.some(([c, d]) => d !== undefined && c !== undefined && c !== Math.round(d * 100))) mismatches += 1;
      const rev = await ctx.db
        .query("bidRevisions")
        .withIndex("by_bid_and_revision", (q) => q.eq("bidId", bid._id))
        .first();
      if (rev === null) withoutRevision += 1;
    }
    return { total, missingCents, legacyWithoutCents, mismatches, withoutRevision };
  },
});
