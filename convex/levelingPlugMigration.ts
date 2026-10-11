import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { bidCents, computeLeveledTotalCents } from "./lib/bidMoney";
import { exclusionScopeText } from "./lib/levelingPlugs";

/**
 * One-off cleanup (§15): before plugs became GC-entered, AI-parsed bids of real companies stored the
 * parser's benchmark amounts (for example a flat $15,000) as plugs, with pricing reasoning in the
 * exclusion text. This clears those unattributed plugs and the reasoning on non-Demo AI-parsed bids.
 * GC-attributed plugs, Demo company bids and awarded bids are left alone. Idempotent; page through
 * with the returned cursor until `isDone`.
 */

const AI_SOURCES = new Set(["email_ai", "document_ai"]);

async function isRealCompanyBid(ctx: MutationCtx, bid: Doc<"bids">, cache: Map<Id<"tradePackages">, boolean>): Promise<boolean> {
  const cached = cache.get(bid.tradePackageId);
  if (cached !== undefined) return cached;
  const pkg = await ctx.db.get(bid.tradePackageId);
  const project = pkg ? await ctx.db.get(pkg.projectId) : null;
  const company = project?.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
  const real = company !== null && !company.isDemo;
  cache.set(bid.tradePackageId, real);
  return real;
}

export function cleanedExclusions(bid: Pick<Doc<"bids">, "identifiedExclusions">) {
  let changed = false;
  const exclusions = bid.identifiedExclusions.map((e) => {
    if (e.plugEnteredAt !== undefined) return e;
    const description = exclusionScopeText(e.description);
    const costImpactCents = 0;
    if (description === e.description && (e.costImpactCents ?? 0) === 0) return e;
    changed = true;
    return { ...e, description, costImpactCents };
  });
  return { changed, exclusions };
}

export const clearParsedPlugs = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("bids").paginate({ numItems: 100, cursor: args.cursor ?? null });
    const cache = new Map<Id<"tradePackages">, boolean>();
    const fixed: { bidId: Id<"bids">; subcontractorName: string; leveledBeforeCents: number; leveledAfterCents: number }[] = [];
    for (const bid of page.page) {
      if (bid.isAwarded || !AI_SOURCES.has(bid.source ?? "")) continue;
      if (!(await isRealCompanyBid(ctx, bid, cache))) continue;
      const { changed, exclusions } = cleanedExclusions(bid);
      if (!changed) continue;
      const c = bidCents(bid);
      const leveledTotalCents = computeLeveledTotalCents({
        baseAmountCents: c.baseAmountCents,
        exclusions,
        veAlternates: bid.valueEngineeringAlternates ?? [],
        leadTimePenaltyCents: c.leadTimePenaltyCents,
        coiPenaltyCents: c.coiPenaltyCents,
      });
      fixed.push({ bidId: bid._id, subcontractorName: bid.subcontractorName, leveledBeforeCents: c.leveledTotalCents, leveledAfterCents: leveledTotalCents });
      if (!args.dryRun) {
        await ctx.db.patch(bid._id, {
          identifiedExclusions: exclusions,
          exclusions: exclusions.map((e) => e.description),
          leveledTotalCents,
        });
      }
    }
    return { fixed, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
