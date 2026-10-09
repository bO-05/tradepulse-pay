import { query, mutation, internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { auditActor, requireDocOfProject, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { v, ConvexError } from "convex/values";
import { deleteAgreementCascade } from "./payments/cascade";
import { syncAgreementForBid } from "./agreements";
import { validateProjectText } from "./validation";
import { leadTimePenaltyFor, targetWeeksForDivision } from "./terms";
import { contractorCanBidOnPackage } from "./lib/packageContractors";
import { biddingClosedReason } from "./lib/biddingClosed";
import { bidExclusionValidator, bidVeAlternateValidator } from "./lib/bidValidators";
import { formatCents, fromDollars } from "./lib/money";
import {
  CLEAR_LEGACY_BID_DOLLARS,
  acceptedVeDeductCents,
  bidCents,
  computeLeveledTotalCents,
  exclusionPlugCents,
  type BidExclusionCents,
  type BidLineItemCents,
  type BidVeAlternateCents,
} from "./lib/bidMoney";
import { recordBidRevision, termsOfBid } from "./lib/bidRevisions";
import { attributePlugs, cleanPlugNote, exclusionScopeText, keptPlugFields, type PlugActor } from "./lib/levelingPlugs";
import { buildLevelingRows } from "./lib/levelingSummary";
import { attributeDemoExclusions, findDemoGcPlugActor } from "./lib/demoPlugs";
import type { ProjectAccess } from "./lib/tenancy";

const MAX_BID_CENTS = 100_000_000_000; // $1,000,000,000.00

/**
 * Plausibility guard for the AI and GC-direct ingestion paths. Blocks six/seven-figure data-entry
 * mistakes and $1 "joke" bids before they can be ranked or awarded.
 */
function assertBidAmountPlausible(tradePkg: Doc<"tradePackages">, baseAmountCents: number): void {
  if (baseAmountCents < 100_000) {
    throw new ConvexError(
      `The proposal amount ${formatCents(baseAmountCents)} is implausibly low for a commercial trade package (minimum $1,000.00). Verify the proposal before ingesting.`
    );
  }
  const budgetCents = Number.isFinite(tradePkg.budgetEstimate) && tradePkg.budgetEstimate > 0 ? fromDollars(tradePkg.budgetEstimate) : 0;
  const ceilingCents = Math.max(budgetCents * 5, 500_000_000);
  if (budgetCents > 0 && baseAmountCents > ceilingCents) {
    throw new ConvexError(
      `The proposal amount ${formatCents(baseAmountCents)} exceeds the plausibility ceiling of ${formatCents(ceilingCents)} (5x the ${formatCents(budgetCents)} package budget, with a $5,000,000.00 minimum ceiling). Verify the proposal before ingesting.`
    );
  }
}

const ALLOWED_COI_STATUSES = new Set(["compliant", "deficiency_detected"]);

function centsArg(value: number, label: string, { positive = false }: { positive?: boolean } = {}): number {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0) || value > MAX_BID_CENTS) {
    throw new ConvexError(
      positive
        ? `${label} must be a whole number of cents greater than zero and no more than $1,000,000,000.00.`
        : `${label} must be a whole number of cents, zero or greater, and no more than $1,000,000,000.00.`,
    );
  }
  return value;
}

/** A10-05: all writers must enforce the same long-lead bounds as insertParsedBid. */
function validateLongLeadWeeks(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 520) {
    throw new ConvexError("Long-lead equipment weeks must be a whole number between 0 and 520.");
  }
  return value;
}

const lineItemCentsArg = v.object({
  item: v.string(),
  unit: v.string(),
  quantity: v.number(),
  unitCostCents: v.number(),
  totalCostCents: v.number(),
});

/** A10-06: reject non-finite or negative line-item math on public writers. */
function assertLineItemsNonNegative(items: ReadonlyArray<BidLineItemCents> | undefined): void {
  for (const item of items ?? []) {
    if (
      !Number.isFinite(item.quantity) ||
      item.quantity < 0 ||
      !Number.isSafeInteger(item.unitCostCents) ||
      !Number.isSafeInteger(item.totalCostCents) ||
      item.unitCostCents < 0 ||
      item.totalCostCents < 0
    ) {
      throw new ConvexError("Line items must use a non-negative quantity and whole-cent, non-negative unit and total costs.");
    }
  }
}

/**
 * A7-01/A7-02: shared validation for every public bid writer so the same bad
 * COI status or negative scope impact cannot slip through a sibling mutation.
 */
function assertBidLevelingInputs(
  exclusions: ReadonlyArray<{ costImpactCents?: number }>,
  veAlternates: ReadonlyArray<{ costDeductCents?: number }>,
  coiComplianceStatus?: string
): void {
  if (coiComplianceStatus !== undefined && !ALLOWED_COI_STATUSES.has(coiComplianceStatus)) {
    throw new ConvexError("COI status must be 'compliant' or 'deficiency_detected'.");
  }
  for (const exc of exclusions) {
    const c = exc.costImpactCents ?? 0;
    if (!Number.isSafeInteger(c) || c < 0) {
      throw new ConvexError("Scope exclusion cost impacts must be zero or positive whole-cent amounts.");
    }
  }
  for (const ve of veAlternates) {
    const c = ve.costDeductCents ?? 0;
    if (!Number.isSafeInteger(c) || c < 0) {
      throw new ConvexError("Value-engineering deducts must be zero or positive whole-cent amounts.");
    }
  }
}

// The arg validators still accept the legacy dollar keys so a migrated row can be sent back
// unchanged, but a dollar amount without its cents twin would silently become $0.
function assertCentsPresent(items: ReadonlyArray<object>, centsKey: string, dollarKey: string): void {
  for (const item of items as ReadonlyArray<Record<string, unknown>>) {
    if (item[centsKey] === undefined && item[dollarKey] !== undefined) {
      throw new ConvexError(`Send ${dollarKey} as integer cents (${centsKey}).`);
    }
  }
}

function normalizeExclusions(items: ReadonlyArray<Doc<"bids">["identifiedExclusions"][number]>): BidExclusionCents[] {
  assertCentsPresent(items, "costImpactCents", "costImpact");
  return items.map((e) => ({
    ...(e.canonicalCode ? { canonicalCode: e.canonicalCode } : {}),
    description: e.description,
    costImpactCents: e.costImpactCents ?? 0,
    severity: e.severity,
    ...(e.isWaived !== undefined ? { isWaived: e.isWaived } : {}),
    ...(e.plugNote !== undefined ? { plugNote: e.plugNote } : {}),
  }));
}

function plugActor(access: Pick<ProjectAccess, "user" | "viewer" | "company">): PlugActor {
  const a = auditActor(access);
  return { userId: a.actorUserId, name: a.actor };
}

function normalizeVe(items: ReadonlyArray<NonNullable<Doc<"bids">["valueEngineeringAlternates"]>[number]>): BidVeAlternateCents[] {
  assertCentsPresent(items, "costDeductCents", "costDeduct");
  return items.map((a) => ({ description: a.description, costDeductCents: a.costDeductCents ?? 0, isAccepted: a.isAccepted }));
}

export const listByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    // Bid amounts are GC-internal: owners and subs never read the leveling matrix.
    await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    return await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
  },
});

export const listAllProjectBids = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allBids = [];
    for (const pkg of packages) {
      const packageBids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const b of packageBids) {
        allBids.push({
          ...b,
          csiDivision: pkg.csiDivision,
          tradeName: pkg.tradeName,
        });
      }
    }
    return allBids;
  },
});

/** GC leveling view: apparent low vs leveled low, plugs with who entered them, and award status per bidder. */
export const getLevelingSummary = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const pkg = access.doc;
    const bids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .take(200);
    const rows = buildLevelingRows(pkg, bids);
    const awarded = rows.find((r) => r.status === "awarded") ?? null;
    return {
      packageStatus: pkg.status,
      csiDivision: pkg.csiDivision,
      tradeName: pkg.tradeName,
      awardedTo: awarded ? awarded.subcontractorName : null,
      apparentLowBidId: rows.find((r) => r.isApparentLow)?.bidId ?? null,
      leveledLowBidId: rows.find((r) => r.isLeveledLow)?.bidId ?? null,
      rows,
    };
  },
});

/**
 * Sets (or clears, with 0) the GC's comparison plug on one bid exclusion. The plug changes only the
 * leveled total; the bid's base, the contract sum and the SOV never include it.
 */
export const setExclusionPlug = mutation({
  args: {
    bidId: v.id("bids"),
    exclusionIndex: v.number(),
    amountCents: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"], write: true });
    const bid = access.doc;
    if (bid.isAwarded) {
      throw new ConvexError({ code: "CLOSED", message: "This bid is awarded; plugs are locked. Unaward it first to change leveling." });
    }
    const exclusion = Number.isInteger(args.exclusionIndex) ? bid.identifiedExclusions[args.exclusionIndex] : undefined;
    if (!exclusion) throw new ConvexError({ code: "INVALID", message: "That exclusion is not on this bid." });
    if (!Number.isSafeInteger(args.amountCents) || args.amountCents < 0 || args.amountCents > MAX_BID_CENTS) {
      throw new ConvexError({
        code: "INVALID",
        field: "amount",
        message: "Enter the plug as a dollar amount of $0.00 or more (whole cents).",
      });
    }
    const note = cleanPlugNote(args.note);
    const next = bid.identifiedExclusions.map((e, i) =>
      i === args.exclusionIndex ? { ...e, costImpactCents: args.amountCents, plugNote: note, isWaived: false } : e,
    );
    const exclusions = attributePlugs(bid.identifiedExclusions, next, plugActor(access), Date.now());
    const c = bidCents(bid);
    const leveledTotalCents = computeLeveledTotalCents({
      baseAmountCents: c.baseAmountCents,
      exclusions,
      veAlternates: bid.valueEngineeringAlternates ?? [],
      leadTimePenaltyCents: c.leadTimePenaltyCents,
      coiPenaltyCents: c.coiPenaltyCents,
    });
    await ctx.db.patch(bid._id, { ...CLEAR_LEGACY_BID_DOLLARS, ...c, identifiedExclusions: exclusions, leveledTotalCents });
    const pkg = await ctx.db.get(bid.tradePackageId);
    await ctx.db.insert("auditLogs", {
      projectId: access.project._id,
      tradePackageId: bid.tradePackageId,
      eventType: "bid_leveled",
      title: `Leveling plug ${args.amountCents > 0 ? "set" : "cleared"}: ${bid.subcontractorName}`,
      description:
        args.amountCents > 0
          ? `Comparison-only plug of ${formatCents(args.amountCents)} on "${exclusion.description}"${pkg ? ` (Division ${pkg.csiDivision})` : ""}. Base bid stays ${formatCents(c.baseAmountCents)}; leveled total ${formatCents(leveledTotalCents)}. Plugs never enter the contract sum.`
          : `Plug removed from "${exclusion.description}". Leveled total ${formatCents(leveledTotalCents)}.`,
      ...auditActor(access),
      timestamp: Date.now(),
    });
    return { leveledTotalCents };
  },
});

export const awardContract = mutation({
  args: {
    bidId: v.id("bids"),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const tradePkg = access.doc;
    const awardedBid = await requireDocOfProject(ctx, access, "bids", args.bidId);
    if (awardedBid.tradePackageId !== args.tradePackageId) {
      throw new Error("The selected bid is not part of this trade package.");
    }
    const contractor = await ctx.db.get(awardedBid.contractorId);
    if (!contractor || !contractorCanBidOnPackage(contractor, tradePkg)) {
      throw new Error("The selected bid is not linked to a contractor in this trade package.");
    }
    const existingAgreement = await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .first();
    if (!existingAgreement || existingAgreement.tradePackageId !== args.tradePackageId) {
      throw new ConvexError("Generate the agreement before changing an award; this prevents an award without a contract record.");
    }
    // Executed subcontracts are immutable: awarding a different bid must not
    // silently supersede a signed agreement (A1-02).
    const packageAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    const executedAgreement = packageAgreements.find((a) => a.status === "executed");
    if (executedAgreement && executedAgreement.bidId !== args.bidId) {
      throw new ConvexError(
        `An executed subcontract (${executedAgreement.agreementNumber}) already exists for this package. Void or amend it explicitly before awarding a different bid.`
      );
    }
    // A12-01: a superseded agreement is not an active contract; awarding the bid
    // behind it would show an award with no contract in the register.
    if (existingAgreement.status === "superseded") {
      throw new ConvexError(
        "The agreement for this bid was superseded. Regenerate the agreement before awarding it again."
      );
    }
    // Un-award all other bids in this package first
    const existingBids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();

    for (const b of existingBids) {
      if (b.isAwarded) {
        await ctx.db.patch(b._id, { isAwarded: false });
      }
    }

    await ctx.db.patch(args.bidId, { isAwarded: true });
    await ctx.db.patch(args.tradePackageId, { status: "awarded" });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "contract_awarded",
      title: `Subcontract Awarded: ${awardedBid.subcontractorName}`,
      description: `Awarded Division ${tradePkg.csiDivision} to ${awardedBid.subcontractorName}; contract sum ${formatCents(existingAgreement.contractSumCents ?? fromDollars(existingAgreement.contractSum))} (base bid plus accepted alternates; leveling plugs excluded).`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return {
      success: true,
      awardedBid,
    };
  },
});

export const unawardContract = mutation({
  args: {
    bidId: v.id("bids"),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const tradePkg = access.doc;
    const bid = await requireDocOfProject(ctx, access, "bids", args.bidId);
    if (bid.tradePackageId !== args.tradePackageId) {
      throw new Error("The selected bid is not part of this trade package.");
    }

    await ctx.db.patch(args.bidId, { isAwarded: false });
    await ctx.db.patch(args.tradePackageId, { status: "leveling" });

    // Mark any active agreements for this bid as superseded
    const packageAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const a of packageAgreements) {
      if (a.bidId === args.bidId && a.status !== "superseded") {
        if (a.status === "executed") {
          throw new ConvexError("Executed agreements are immutable and cannot be unawarded. Void the executed subcontract explicitly before changing the award.");
        }
        await ctx.db.patch(a._id, { status: "superseded" });
      }
    }

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "contract_awarded",
      title: `Subcontract Un-Awarded: ${bid.subcontractorName}`,
      description: `Reopened Division ${tradePkg.csiDivision} bid leveling matrix. Removed award flag from ${bid.subcontractorName}.`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return { success: true };
  },
});

export const deleteBid = mutation({
  args: {
    bidId: v.id("bids"),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"], write: true });
    const bid = access.doc;

    const tradePkg = await ctx.db.get(bid.tradePackageId);

    // Delete or supersede any agreements associated with this bid
    const bidAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .collect();
    for (const a of bidAgreements) {
      if (a.status === "executed") {
        throw new ConvexError("Executed agreements are immutable and cannot be deleted with their bid. Void the executed subcontract first.");
      }
      await deleteAgreementCascade(ctx, a._id);
    }

    const revisions = await ctx.db
      .query("bidRevisions")
      .withIndex("by_bid_and_revision", (q) => q.eq("bidId", args.bidId))
      .take(500);
    for (const r of revisions) await ctx.db.delete(r._id);
    await ctx.db.delete(args.bidId);

    // Check remaining bids
    const remainingBids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", bid.tradePackageId))
      .collect();

    if (remainingBids.length === 0 && tradePkg) {
      await ctx.db.patch(tradePkg._id, { status: "rfqs_dispatched" });
    } else if (bid.isAwarded && tradePkg) {
      await ctx.db.patch(tradePkg._id, { status: "leveling" });
    }

    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "bid_leveled",
        title: `Bid Removed: ${bid.subcontractorName}`,
        description: `Deleted proposal from ${bid.subcontractorName} (${formatCents(bidCents(bid).baseAmountCents)}) from Division ${tradePkg.csiDivision} leveling matrix.`,
        ...auditActor(access),
        timestamp: Date.now(),
      });
    }

    return { success: true };
  },
});

const levelingArgs = {
  identifiedExclusions: v.optional(v.array(bidExclusionValidator)),
  valueEngineeringAlternates: v.optional(v.array(bidVeAlternateValidator)),
  leadTimePenaltyCents: v.optional(v.number()),
  longLeadEquipmentWeeks: v.optional(v.number()),
  coiPenaltyCents: v.optional(v.number()),
  coiComplianceStatus: v.optional(v.string()),
};

/** Shared by the GC leveling writers: validates, recomputes the leveled total in cents and audits. */
async function applyLeveling(
  ctx: MutationCtx,
  access: Awaited<ReturnType<typeof requireDocScope<"bids">>>,
  args: {
    baseAmountCents?: number;
    identifiedExclusions?: Doc<"bids">["identifiedExclusions"];
    valueEngineeringAlternates?: Doc<"bids">["valueEngineeringAlternates"];
    leadTimePenaltyCents?: number;
    longLeadEquipmentWeeks?: number;
    coiPenaltyCents?: number;
    coiComplianceStatus?: string;
  },
  label: { title: string; verb: string },
) {
  const bid = access.doc;
  const current = bidCents(bid);
  const baseAmountCents = centsArg(args.baseAmountCents ?? current.baseAmountCents, "Base bid amount", { positive: true });
  const exclusions = args.identifiedExclusions
    ? attributePlugs(bid.identifiedExclusions, normalizeExclusions(args.identifiedExclusions), plugActor(access), Date.now())
    : bid.identifiedExclusions;
  const veAlternates = normalizeVe(args.valueEngineeringAlternates ?? bid.valueEngineeringAlternates ?? []);
  assertBidLevelingInputs(exclusions, veAlternates, args.coiComplianceStatus);
  const leadTimePenaltyCents = centsArg(args.leadTimePenaltyCents ?? current.leadTimePenaltyCents, "Lead time penalty");
  const coiPenaltyCents = centsArg(args.coiPenaltyCents ?? current.coiPenaltyCents, "COI penalty");
  const longLeadEquipmentWeeks =
    args.longLeadEquipmentWeeks !== undefined ? validateLongLeadWeeks(args.longLeadEquipmentWeeks) : bid.longLeadEquipmentWeeks;

  const leveledTotalCents = computeLeveledTotalCents({
    baseAmountCents,
    exclusions,
    veAlternates,
    leadTimePenaltyCents,
    coiPenaltyCents,
  });

  await ctx.db.patch(bid._id, {
    ...CLEAR_LEGACY_BID_DOLLARS,
    baseAmountCents,
    identifiedExclusions: exclusions,
    valueEngineeringAlternates: veAlternates,
    leadTimePenaltyCents,
    longLeadEquipmentWeeks,
    coiPenaltyCents,
    coiComplianceStatus: args.coiComplianceStatus ?? bid.coiComplianceStatus,
    leveledTotalCents,
  });

  if (bid.isAwarded) {
    await syncAgreementForBid(ctx, bid._id);
  }

  const tradePkg = await ctx.db.get(bid.tradePackageId);
  if (tradePkg) {
    const waivedCount = exclusions.filter((e) => e.isWaived).length;
    const acceptedVeCount = veAlternates.filter((a) => a.isAccepted).length;
    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "bid_leveled",
      title: `${label.title}: ${bid.subcontractorName}`,
      description: `${label.verb} Base ${formatCents(baseAmountCents)} → Leveled Total: ${formatCents(leveledTotalCents)} (${waivedCount} exclusions waived, ${acceptedVeCount} VE alternates accepted, -${formatCents(acceptedVeDeductCents(veAlternates))} deduct).`,
      ...auditActor(access),
      timestamp: Date.now(),
    });
  }
  return { success: true, leveledTotalCents };
}

export const updateBidLeveling = mutation({
  args: { bidId: v.id("bids"), baseAmountCents: v.optional(v.number()), ...levelingArgs },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"], write: true });
    const { bidId: _bidId, ...rest } = args;
    return await applyLeveling(ctx, access, rest, { title: "Bid Leveling Recalculated", verb: "Normalized leveling recalculated." });
  },
});

export const updateBidAdjustments = mutation({
  args: { bidId: v.id("bids"), ...levelingArgs, identifiedExclusions: v.array(bidExclusionValidator) },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"], write: true });
    const { bidId: _bidId, ...rest } = args;
    return await applyLeveling(ctx, access, rest, { title: "Bid Leveling Adjusted", verb: "Manual leveling adjustments applied." });
  },
});

export const submitDirectBid = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    subcontractorName: v.string(),
    baseAmountCents: v.number(),
    lineItems: v.optional(v.array(lineItemCentsArg)),
    identifiedExclusions: v.optional(v.array(bidExclusionValidator)),
    valueEngineeringAlternates: v.optional(v.array(bidVeAlternateValidator)),
    longLeadEquipmentWeeks: v.optional(v.number()),
    leadTimePenaltyCents: v.optional(v.number()),
    coiComplianceStatus: v.optional(v.string()),
    coiPenaltyCents: v.optional(v.number()),
    rawProposalText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const tradePkg = access.doc;
    const contractor = await requireDocOfProject(ctx, access, "contractors", args.contractorId);
    if (contractor.tradePackageId !== tradePkg._id) {
      throw new Error("The contractor is not assigned to this trade package.");
    }
    const baseAmountCents = centsArg(args.baseAmountCents, "Base bid amount", { positive: true });
    assertBidAmountPlausible(tradePkg, baseAmountCents);
    const existingForPlugs = await ctx.db
      .query("bids")
      .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", args.tradePackageId).eq("contractorId", args.contractorId))
      .first();
    const exclusions = attributePlugs(
      existingForPlugs?.identifiedExclusions ?? [],
      normalizeExclusions(args.identifiedExclusions ?? []),
      plugActor(access),
      Date.now(),
    );
    const veAlternates = normalizeVe(args.valueEngineeringAlternates ?? []);
    assertBidLevelingInputs(exclusions, veAlternates, args.coiComplianceStatus);
    assertLineItemsNonNegative(args.lineItems);
    // A12-08: keep one canonical bidder name per contractor so leveling, CSV,
    // contracts, and the tour cannot disagree.
    const subcontractorName = validateProjectText(
      contractor.companyName.trim() || args.subcontractorName,
      "Subcontractor name"
    );
    await ctx.db.patch(args.contractorId, { rfqStatus: "bid_received" });
    await ctx.db.patch(args.tradePackageId, { status: "leveling" });

    const existing = await ctx.db
      .query("bids")
      .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", args.tradePackageId).eq("contractorId", args.contractorId))
      .first();

    const lineItems: BidLineItemCents[] = args.lineItems ?? [
      { item: "Base Commercial Package Scope", unit: "LS", quantity: 1, unitCostCents: baseAmountCents, totalCostCents: baseAmountCents },
    ];
    const leadWeeks = args.longLeadEquipmentWeeks ?? 12;
    if (!Number.isInteger(leadWeeks) || leadWeeks < 0 || leadWeeks > 520) {
      throw new Error("Long-lead equipment weeks must be a whole number between 0 and 520.");
    }
    const leadTimePenaltyCents = centsArg(args.leadTimePenaltyCents ?? 0, "Lead time penalty");
    const coiStatus = args.coiComplianceStatus ?? "compliant";
    const coiPenaltyCents = centsArg(args.coiPenaltyCents ?? 0, "COI penalty");
    const leveledTotalCents = computeLeveledTotalCents({
      baseAmountCents,
      exclusions,
      veAlternates,
      leadTimePenaltyCents,
      coiPenaltyCents,
    });
    const money = {
      ...CLEAR_LEGACY_BID_DOLLARS,
      subcontractorName,
      baseAmountCents,
      lineItems,
      identifiedExclusions: exclusions,
      valueEngineeringAlternates: veAlternates,
      longLeadEquipmentWeeks: leadWeeks,
      leadTimePenaltyCents,
      coiComplianceStatus: coiStatus,
      coiPenaltyCents,
      leveledTotalCents,
    };

    let bidId: Id<"bids">;
    if (existing) {
      bidId = existing._id;
      if (existing.isAwarded) {
        const activeAgreement = await ctx.db
          .query("agreements")
          .withIndex("by_bid", (q) => q.eq("bidId", existing._id))
          .filter((q) => q.neq(q.field("status"), "superseded"))
          .first();
        if (activeAgreement?.status === "executed") {
          throw new ConvexError("Executed agreements are immutable. Create an amendment before changing this bid.");
        }
      }
      await ctx.db.patch(existing._id, {
        ...money,
        exclusions: exclusions.map((e) => e.description),
        source: "gc_entered",
        revisionNumber: (existing.revisionNumber ?? 1) + 1,
        lastRevisedAt: Date.now(),
        receivedAt: Date.now(),
      });
      // A12-02: a revision to an awarded bid must keep its active agreement in
      // sync, otherwise the register contract sum drifts from the bid.
      if (existing.isAwarded) {
        await syncAgreementForBid(ctx, existing._id);
      }
    } else {
      bidId = await ctx.db.insert("bids", {
        tradePackageId: args.tradePackageId,
        contractorId: args.contractorId,
        ...money,
        exclusions: exclusions.map((e) => e.description),
        source: "gc_entered",
        isAwarded: false,
        revisionNumber: 1,
        receivedAt: Date.now(),
      });
    }
    const saved = (await ctx.db.get(bidId))!;
    const actor = auditActor(access);
    await recordBidRevision(ctx, saved, {
      source: "gc_entered",
      terms: termsOfBid(saved),
      submittedByUserId: access.user._id,
      submittedByName: actor.actor,
      submittedByCompanyId: access.company?._id,
    });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "quote_received",
      title: `Direct Bid Ingested: ${subcontractorName}`,
      description: `Direct proposal ingested for Division ${tradePkg.csiDivision}: Base ${formatCents(baseAmountCents)} → Leveled ${formatCents(leveledTotalCents)} (${exclusions.length} exclusions, ${veAlternates.length} VE alternates).`,
      ...actor,
      timestamp: Date.now(),
    });

    return {
      success: true,
      bidId,
      subcontractorName,
      baseAmountCents,
      leveledTotalCents,
    };
  },
});

/**
 * Stores an AI-parsed proposal (bidder email or quote file). The parser works in dollars; this is
 * the storage boundary where its amounts become integer cents. The bid stays "needs review" until a
 * GC member confirms or edits it.
 */
export const insertParsedBid = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    subcontractorName: v.string(),
    baseAmountCents: v.number(),
    lineItems: v.array(lineItemCentsArg),
    identifiedExclusions: v.array(bidExclusionValidator),
    valueEngineeringAlternates: v.optional(v.array(bidVeAlternateValidator)),
    longLeadEquipmentWeeks: v.number(),
    leadTimeTargetWeeks: v.optional(v.number()),
    coiComplianceStatus: v.string(),
    coiPenaltyCents: v.number(),
    sourceFileId: v.optional(v.id("projectFiles")),
    sourceInboundEmailId: v.optional(v.id("inboundEmails")),
    /** Extraction path recorded in the bid_leveled audit entry (e.g. "Anthropic claude-sonnet-5" or the deterministic engine). */
    levelingProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    const contractor = await ctx.db.get(args.contractorId);
    if (!contractor || !contractorCanBidOnPackage(contractor, tradePkg)) {
      throw new Error("The contractor is not assigned to this trade package.");
    }
    if (args.sourceFileId) {
      const sourceFile = await ctx.db.get(args.sourceFileId);
      if (!sourceFile || sourceFile.projectId !== tradePkg.projectId || sourceFile.tradePackageId !== tradePkg._id) {
        throw new Error("The source quote file does not belong to this project and trade package.");
      }
    }
    const message = args.sourceInboundEmailId ? await ctx.db.get(args.sourceInboundEmailId) : null;
    if (args.sourceInboundEmailId) {
      if (!message || message.tradePackageId !== tradePkg._id || message.contractorId !== contractor._id) {
        throw new Error("The source email does not belong to this bidder and trade package.");
      }
    }
    // Checked here, in the same transaction as the write, because the award can land between the
    // email arriving and its parse finishing. The Demo simulator (no source email or file) is exempt.
    const hasSource = args.sourceInboundEmailId !== undefined || args.sourceFileId !== undefined;
    const closed = hasSource ? biddingClosedReason(tradePkg, await ctx.db.get(tradePkg.projectId)) : null;
    if (closed !== null) {
      if (!message) throw new ConvexError({ code: "CLOSED" as const, message: closed });
      await ctx.db.patch(message._id, { lateReason: closed });
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        contractorId: contractor._id,
        eventType: "quote_received",
        title: `Late proposal email kept: ${contractor.companyName}`,
        description: `${contractor.companyName} emailed a priced proposal after bidding closed. ${closed} The message is kept in Bidder messages; no bid was changed.`,
        actor: "Forensic Leveling Engine (ADR-0003)",
        timestamp: Date.now(),
      });
      return null;
    }
    const baseAmountCents = centsArg(args.baseAmountCents, "Base bid amount", { positive: true });
    assertBidAmountPlausible(tradePkg, baseAmountCents);
    const longLeadEquipmentWeeks = validateLongLeadWeeks(args.longLeadEquipmentWeeks);
    // A6-05r/A6-54: the schedule penalty is always derived in code from the stored
    // weeks and the GC-owned division baseline (or an explicit target), never from
    // a producer- or model-supplied dollar amount.
    const leadTimeTargetWeeks =
      Number.isFinite(args.leadTimeTargetWeeks) && (args.leadTimeTargetWeeks as number) > 0
        ? (args.leadTimeTargetWeeks as number)
        : targetWeeksForDivision(tradePkg.csiDivision);
    const leadTimePenaltyCents = fromDollars(leadTimePenaltyFor(longLeadEquipmentWeeks, leadTimeTargetWeeks));
    const coiPenaltyCents = Number.isSafeInteger(args.coiPenaltyCents) && args.coiPenaltyCents > 0 ? args.coiPenaltyCents : 0;
    // A10-06: normalize model-extracted line items instead of persisting negative math.
    const safeLineItems: BidLineItemCents[] = args.lineItems.map((item) => ({
      ...item,
      quantity: Math.max(0, Number(item.quantity) || 0),
      unitCostCents: Number.isSafeInteger(item.unitCostCents) ? Math.max(0, item.unitCostCents) : 0,
      totalCostCents: Number.isSafeInteger(item.totalCostCents) ? Math.max(0, item.totalCostCents) : 0,
    }));
    await ctx.db.patch(args.contractorId, { rfqStatus: "bid_received" });
    await ctx.db.patch(args.tradePackageId, { status: "leveling" });

    const existingBySource = args.sourceFileId
      ? await ctx.db.query("bids").withIndex("by_source_file", (q) => q.eq("sourceFileId", args.sourceFileId)).first()
      : null;
    const existing =
      existingBySource ||
      (await ctx.db
        .query("bids")
        .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", args.tradePackageId).eq("contractorId", args.contractorId))
        .first());
    if (existingBySource && (existingBySource.tradePackageId !== args.tradePackageId || existingBySource.contractorId !== args.contractorId)) {
      throw new Error("This quote file is already linked to a different contractor or trade package.");
    }

    // A7-03: normalize model output here so an invalid COI string or negative
    // impact can never reach storage even from the internal ingestion path.
    const safeCoiStatus = ALLOWED_COI_STATUSES.has(args.coiComplianceStatus) ? args.coiComplianceStatus : "compliant";
    // Plugs are GC-entered (§15): for real companies the parser's benchmark or stated amounts are
    // never stored as plugs. The Demo company keeps them so its seeded leveling scenarios still work.
    const project = await ctx.db.get(tradePkg.projectId);
    const gcCompany = project?.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
    const keepParsedPlugs = gcCompany ? gcCompany.isDemo : true;
    const parsedExclusions = normalizeExclusions(args.identifiedExclusions).map(({ plugNote: _note, ...parsed }) => {
      const e = keepParsedPlugs ? parsed : { ...parsed, description: exclusionScopeText(parsed.description) };
      const gcPlug = existing?.identifiedExclusions.find((p) => p.description.trim() === e.description.trim() && p.plugEnteredAt !== undefined);
      if (gcPlug) return { ...e, ...keptPlugFields(gcPlug) };
      return {
        ...e,
        costImpactCents: keepParsedPlugs && Number.isSafeInteger(e.costImpactCents) ? Math.max(0, e.costImpactCents) : 0,
      };
    });
    const demoActor = gcCompany?.isDemo === true ? await findDemoGcPlugActor(ctx) : null;
    const safeExclusions = demoActor ? attributeDemoExclusions(parsedExclusions, demoActor, Date.now()).next : parsedExclusions;
    const safeVeAlternates = normalizeVe(args.valueEngineeringAlternates ?? []).map((a) => ({
      ...a,
      costDeductCents: Number.isSafeInteger(a.costDeductCents) ? Math.max(0, a.costDeductCents) : 0,
    }));
    const leveledTotalCents = computeLeveledTotalCents({
      baseAmountCents,
      exclusions: safeExclusions,
      veAlternates: safeVeAlternates,
      leadTimePenaltyCents,
      coiPenaltyCents,
    });
    const source: "email_ai" | "document_ai" = args.sourceInboundEmailId ? "email_ai" : "document_ai";
    const fields = {
      ...CLEAR_LEGACY_BID_DOLLARS,
      subcontractorName: args.subcontractorName,
      baseAmountCents,
      lineItems: safeLineItems,
      identifiedExclusions: safeExclusions,
      exclusions: safeExclusions.map((e) => e.description),
      valueEngineeringAlternates: safeVeAlternates,
      longLeadEquipmentWeeks,
      leadTimePenaltyCents,
      leadTimeTargetWeeks,
      coiComplianceStatus: safeCoiStatus,
      coiPenaltyCents,
      leveledTotalCents,
      source,
      sourceInboundEmailId: args.sourceInboundEmailId,
      submittedByUserId: undefined,
      submittedByName: undefined,
      submittedByCompanyId: undefined,
      confirmedByUserId: undefined,
      confirmedByName: undefined,
      confirmedAt: undefined,
      ...(args.sourceFileId ? { sourceFileId: args.sourceFileId } : {}),
    };

    let bidId: Id<"bids">;
    if (existing) {
      bidId = existing._id;
      await ctx.db.patch(existing._id, {
        ...fields,
        revisionNumber: (existing.revisionNumber ?? 1) + 1,
        lastRevisedAt: Date.now(),
        receivedAt: Date.now(),
      });
      if (existing.isAwarded) {
        await syncAgreementForBid(ctx, existing._id);
      }
    } else {
      bidId = await ctx.db.insert("bids", {
        tradePackageId: args.tradePackageId,
        contractorId: args.contractorId,
        ...fields,
        isAwarded: false,
        revisionNumber: 1,
        receivedAt: Date.now(),
      });
    }
    const saved = (await ctx.db.get(bidId))!;
    await recordBidRevision(ctx, saved, {
      source,
      terms: termsOfBid(saved),
      submittedByName: args.levelingProvider ? `AI parser (${args.levelingProvider})` : "AI parser",
      sourceInboundEmailId: args.sourceInboundEmailId,
    });

    const exclusionsCount = safeExclusions.length;
    const gapsCents = safeExclusions.reduce((s, e) => s + exclusionPlugCents(e), 0);
    const providerNote = args.levelingProvider ? ` Model path: ${args.levelingProvider}.` : "";
    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "bid_leveled",
      title: `Forensic Bid Leveled: ${args.subcontractorName}`,
      description: `Normalized proposal: Base ${formatCents(baseAmountCents)} → Leveled ${formatCents(leveledTotalCents)} (${exclusionsCount} exclusions totaling +${formatCents(gapsCents)}).${providerNote}`,
      actor: "Forensic Leveling Engine (ADR-0003)",
      timestamp: Date.now(),
    });

    return bidId;
  },
});
