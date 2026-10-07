import { query, mutation, internalMutation } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import { syncAgreementForBid } from "./agreements";
import { validateNonNegativeAmount, validatePositiveAmount, validateProjectText } from "./validation";
import { leadTimePenaltyFor, targetWeeksForDivision } from "./terms";

/**
 * Plausibility guard for every bid ingestion path. Blocks six/seven-figure data-entry
 * mistakes and $1 "joke" bids before they can be ranked or awarded.
 */
function assertBidAmountPlausible(tradePkg: any, baseBidAmount: number): void {
  if (baseBidAmount < 1000) {
    throw new ConvexError(
      `The proposal amount $${baseBidAmount.toLocaleString()} is implausibly low for a commercial trade package (minimum $1,000). Verify the proposal before ingesting.`
    );
  }
  const budget = Number(tradePkg?.budgetEstimate) || 0;
  const ceiling = Math.max(budget * 5, 5_000_000);
  if (budget > 0 && baseBidAmount > ceiling) {
    throw new ConvexError(
      `The proposal amount $${baseBidAmount.toLocaleString()} exceeds the plausibility ceiling of $${ceiling.toLocaleString()} (5x the $${budget.toLocaleString()} package budget, with a $5,000,000 minimum ceiling). Verify the proposal before ingesting.`
    );
  }
}

const ALLOWED_COI_STATUSES = new Set(["compliant", "deficiency_detected"]);

/** A10-05: all writers must enforce the same long-lead bounds as insertParsedBid. */
function validateLongLeadWeeks(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 520) {
    throw new ConvexError("Long-lead equipment weeks must be a whole number between 0 and 520.");
  }
  return value;
}

/** A10-06: reject non-finite or negative line-item math on public writers. */
function assertLineItemsNonNegative(
  items: ReadonlyArray<{ quantity: number; unitCost: number; totalCost: number }> | undefined
): void {
  for (const item of items ?? []) {
    if (
      !Number.isFinite(item.quantity) ||
      !Number.isFinite(item.unitCost) ||
      !Number.isFinite(item.totalCost) ||
      item.quantity < 0 ||
      item.unitCost < 0 ||
      item.totalCost < 0
    ) {
      throw new ConvexError("Line items must use non-negative numeric quantity, unit cost, and total cost.");
    }
  }
}

/**
 * A7-01/A7-02: shared validation for every public bid writer so the same bad
 * COI status or negative scope impact cannot slip through a sibling mutation.
 */
function assertBidLevelingInputs(
  exclusions: ReadonlyArray<{ costImpact: number }>,
  veAlternates: ReadonlyArray<{ costDeduct: number }>,
  coiComplianceStatus?: string
): void {
  if (coiComplianceStatus !== undefined && !ALLOWED_COI_STATUSES.has(coiComplianceStatus)) {
    throw new ConvexError("COI status must be 'compliant' or 'deficiency_detected'.");
  }
  for (const exc of exclusions) {
    if (!Number.isFinite(exc.costImpact) || exc.costImpact < 0) {
      throw new ConvexError("Scope exclusion cost impacts must be zero or positive dollar amounts.");
    }
  }
  for (const ve of veAlternates) {
    if (!Number.isFinite(ve.costDeduct) || ve.costDeduct < 0) {
      throw new ConvexError("Value-engineering deducts must be zero or positive dollar amounts.");
    }
  }
}

export const listByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
  },
});

export const listAllProjectBids = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
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

export const awardContract = mutation({
  args: {
    bidId: v.id("bids"),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const awardedBid = await ctx.db.get(args.bidId);
    if (!awardedBid) throw new Error("Bid not found");
    if (awardedBid.tradePackageId !== args.tradePackageId) {
      throw new Error("The selected bid is not part of this trade package.");
    }
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    const contractor = await ctx.db.get(awardedBid.contractorId);
    if (!contractor || contractor.tradePackageId !== tradePkg._id) {
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

    // Mark this bid awarded
    await ctx.db.patch(args.bidId, { isAwarded: true });

    // Update trade package status to awarded
    await ctx.db.patch(args.tradePackageId, { status: "awarded" });

    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "contract_awarded",
        title: `Subcontract Awarded: ${awardedBid.subcontractorName}`,
        description: `Awarded Division ${tradePkg.csiDivision} to ${awardedBid.subcontractorName} at leveled cost of $${awardedBid.leveledTotalCost.toLocaleString()}.`,
        actor: "Lead Project Manager / Executive",
        timestamp: Date.now(),
      });
    }

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
    await requireRole(ctx, ["gc"]);
    const bid = await ctx.db.get(args.bidId);
    if (!bid) throw new Error("Bid not found");
    if (bid.tradePackageId !== args.tradePackageId) {
      throw new Error("The selected bid is not part of this trade package.");
    }
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

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

    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "contract_awarded",
        title: `Subcontract Un-Awarded: ${bid.subcontractorName}`,
        description: `Reopened Division ${tradePkg.csiDivision} bid leveling matrix. Removed award flag from ${bid.subcontractorName}.`,
        actor: "Lead Project Manager",
        timestamp: Date.now(),
      });
    }

    return { success: true };
  },
});

export const deleteBid = mutation({
  args: {
    bidId: v.id("bids"),
  },
  handler: async (ctx, args) => {
    const bid = await ctx.db.get(args.bidId);
    if (!bid) throw new Error("Bid not found");

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
      await ctx.db.delete(a._id);
    }

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
        description: `Deleted proposal from ${bid.subcontractorName} ($${bid.baseBidAmount.toLocaleString()}) from Division ${tradePkg.csiDivision} leveling matrix.`,
        actor: "Estimator / Procurement Team",
        timestamp: Date.now(),
      });
    }

    return { success: true };
  },
});

export const updateBidLeveling = mutation({
  args: {
    bidId: v.id("bids"),
    baseBidAmount: v.optional(v.number()),
    identifiedExclusions: v.optional(
      v.array(
        v.object({
          canonicalCode: v.optional(v.string()),
          description: v.string(),
          costImpact: v.number(),
          severity: v.string(),
          isWaived: v.optional(v.boolean()),
        })
      )
    ),
    valueEngineeringAlternates: v.optional(
      v.array(
        v.object({
          description: v.string(),
          costDeduct: v.number(),
          isAccepted: v.boolean(),
        })
      )
    ),
    leadTimePenalty: v.optional(v.number()),
    longLeadEquipmentWeeks: v.optional(v.number()),
    coiPenalty: v.optional(v.number()),
    coiComplianceStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bid = await ctx.db.get(args.bidId);
    if (!bid) throw new Error("Bid not found");

    const baseBidAmount = validatePositiveAmount(args.baseBidAmount ?? bid.baseBidAmount, "Base bid amount");
    const exclusions = args.identifiedExclusions ?? bid.identifiedExclusions;
    const veAlternates = args.valueEngineeringAlternates ?? bid.valueEngineeringAlternates ?? [];
    assertBidLevelingInputs(exclusions, veAlternates, args.coiComplianceStatus);
    const leadTimePenalty = validateNonNegativeAmount(args.leadTimePenalty !== undefined ? args.leadTimePenalty : bid.leadTimePenalty, "Lead time penalty");
    const coiPenalty = validateNonNegativeAmount(args.coiPenalty !== undefined ? args.coiPenalty : bid.coiPenalty, "COI penalty");
    const longLeadEquipmentWeeks =
      args.longLeadEquipmentWeeks !== undefined
        ? validateLongLeadWeeks(args.longLeadEquipmentWeeks)
        : bid.longLeadEquipmentWeeks;

    // ADR-0003 Formula:
    // Leveled Cost = Base Bid + Sum(Un-waived Exclusions) + Lead Time Penalty + COI Penalty - Sum(Accepted Alternates)
    const activeExclusionsCost = exclusions.reduce((sum, exc) => (exc.isWaived ? sum : sum + (exc.costImpact || 0)), 0);
    const acceptedAlternatesDeduct = veAlternates.reduce((sum, ve) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum), 0);
    const leveledTotalCost = Math.max(0, baseBidAmount + activeExclusionsCost + leadTimePenalty + coiPenalty - acceptedAlternatesDeduct);

    await ctx.db.patch(args.bidId, {
      baseBidAmount,
      identifiedExclusions: exclusions,
      valueEngineeringAlternates: veAlternates,
      leadTimePenalty,
      longLeadEquipmentWeeks,
      coiPenalty,
      coiComplianceStatus: args.coiComplianceStatus ?? bid.coiComplianceStatus,
      leveledTotalCost,
    });

    if (bid.isAwarded) {
      await syncAgreementForBid(ctx, bid._id);
    }

    const tradePkg = await ctx.db.get(bid.tradePackageId);
    if (tradePkg) {
      const waivedCount = exclusions.filter((e) => e.isWaived).length;
      const acceptedVeCount = veAlternates.filter((v) => v.isAccepted).length;
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "bid_leveled",
        title: `Bid Leveling Recalculated: ${bid.subcontractorName}`,
        description: `Normalized leveling recalculated. Base $${baseBidAmount.toLocaleString()} → Leveled Total: $${leveledTotalCost.toLocaleString()} (${waivedCount} exclusions waived, ${acceptedVeCount} VE alternates accepted, -$${acceptedAlternatesDeduct.toLocaleString()} deduct).`,
        actor: "Lead Cost Estimator (ADR-0003)",
        timestamp: Date.now(),
      });
    }

    return {
      success: true,
      leveledTotalCost,
    };
  },
});

export const updateBidAdjustments = mutation({
  args: {
    bidId: v.id("bids"),
    identifiedExclusions: v.array(
      v.object({
        canonicalCode: v.optional(v.string()),
        description: v.string(),
        costImpact: v.number(),
        severity: v.string(),
        isWaived: v.optional(v.boolean()),
      })
    ),
    valueEngineeringAlternates: v.optional(
      v.array(
        v.object({
          description: v.string(),
          costDeduct: v.number(),
          isAccepted: v.boolean(),
        })
      )
    ),
    leadTimePenalty: v.optional(v.number()),
    longLeadEquipmentWeeks: v.optional(v.number()),
    coiPenalty: v.optional(v.number()),
    coiComplianceStatus: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bid = await ctx.db.get(args.bidId);
    if (!bid) throw new Error("Bid not found");

    assertBidLevelingInputs(args.identifiedExclusions, args.valueEngineeringAlternates ?? [], args.coiComplianceStatus);

    const exclusions = args.identifiedExclusions;
    const veAlternates = args.valueEngineeringAlternates ?? bid.valueEngineeringAlternates ?? [];
    const leadTimePenalty = validateNonNegativeAmount(args.leadTimePenalty !== undefined ? args.leadTimePenalty : bid.leadTimePenalty, "Lead time penalty");
    const coiPenalty = validateNonNegativeAmount(args.coiPenalty !== undefined ? args.coiPenalty : bid.coiPenalty, "COI penalty");
    const longLeadEquipmentWeeks =
      args.longLeadEquipmentWeeks !== undefined
        ? validateLongLeadWeeks(args.longLeadEquipmentWeeks)
        : bid.longLeadEquipmentWeeks;

    const activeExclusionsCost = exclusions.reduce((sum, exc) => (exc.isWaived ? sum : sum + (exc.costImpact || 0)), 0);
    const acceptedAlternatesDeduct = veAlternates.reduce((sum, ve) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum), 0);
    const leveledTotalCost = Math.max(0, bid.baseBidAmount + activeExclusionsCost + leadTimePenalty + coiPenalty - acceptedAlternatesDeduct);

    await ctx.db.patch(args.bidId, {
      identifiedExclusions: exclusions,
      valueEngineeringAlternates: veAlternates,
      leadTimePenalty,
      longLeadEquipmentWeeks,
      coiPenalty,
      coiComplianceStatus: args.coiComplianceStatus ?? bid.coiComplianceStatus,
      leveledTotalCost,
    });

    if (bid.isAwarded) {
      await syncAgreementForBid(ctx, bid._id);
    }

    const tradePkg = await ctx.db.get(bid.tradePackageId);
    if (tradePkg) {
      const waivedCount = exclusions.filter((e) => e.isWaived).length;
      const acceptedVeCount = veAlternates.filter((v) => v.isAccepted).length;
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "bid_leveled",
        title: `Bid Leveling Adjusted: ${bid.subcontractorName}`,
        description: `Manual leveling adjustments applied. Leveled Total: $${leveledTotalCost.toLocaleString()} (${waivedCount} exclusions waived, ${acceptedVeCount} VE alternates accepted, -$${acceptedAlternatesDeduct.toLocaleString()} deduct).`,
        actor: "Lead Cost Estimator",
        timestamp: Date.now(),
      });
    }

    return {
      success: true,
      leveledTotalCost,
    };
  },
});

export const submitDirectBid = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    subcontractorName: v.string(),
    baseBidAmount: v.number(),
    lineItems: v.optional(
      v.array(
        v.object({
          item: v.string(),
          unit: v.string(),
          quantity: v.number(),
          unitCost: v.number(),
          totalCost: v.number(),
        })
      )
    ),
    identifiedExclusions: v.optional(
      v.array(
        v.object({
          canonicalCode: v.optional(v.string()),
          description: v.string(),
          costImpact: v.number(),
          severity: v.string(),
          isWaived: v.optional(v.boolean()),
        })
      )
    ),
    valueEngineeringAlternates: v.optional(
      v.array(
        v.object({
          description: v.string(),
          costDeduct: v.number(),
          isAccepted: v.boolean(),
        })
      )
    ),
    longLeadEquipmentWeeks: v.optional(v.number()),
    leadTimePenalty: v.optional(v.number()),
    coiComplianceStatus: v.optional(v.string()),
    coiPenalty: v.optional(v.number()),
    leveledTotalCost: v.optional(v.number()),
    rawProposalText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    const contractor = await ctx.db.get(args.contractorId);
    if (!contractor || contractor.tradePackageId !== tradePkg._id) {
      throw new Error("The contractor is not assigned to this trade package.");
    }
    const baseBidAmount = validatePositiveAmount(args.baseBidAmount, "Base bid amount");
    assertBidAmountPlausible(tradePkg, baseBidAmount);
    assertBidLevelingInputs(args.identifiedExclusions ?? [], args.valueEngineeringAlternates ?? [], args.coiComplianceStatus);
    assertLineItemsNonNegative(args.lineItems);
    // A12-08: keep one canonical bidder name per contractor so leveling, CSV,
    // contracts, and the tour cannot disagree.
    const subcontractorName = validateProjectText(
      contractor.companyName.trim() || args.subcontractorName,
      "Subcontractor name"
    );
    // 1. Mark contractor as bid_received
    await ctx.db.patch(args.contractorId, { rfqStatus: "bid_received" });

    // 2. Set trade package status to leveling
    await ctx.db.patch(args.tradePackageId, { status: "leveling" });

    // 3. Remove any previous bid from this contractor for this package
    const existing = (await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect()).find((bid) => bid.contractorId === args.contractorId);

    const lineItems = args.lineItems ?? [
      {
        item: "Base Commercial Package Scope",
        unit: "LS",
        quantity: 1,
        unitCost: baseBidAmount,
        totalCost: baseBidAmount,
      },
    ];
    const exclusions = args.identifiedExclusions ?? [];
    const veAlternates = args.valueEngineeringAlternates ?? [];
    const leadWeeks = args.longLeadEquipmentWeeks ?? 12;
    if (!Number.isInteger(leadWeeks) || leadWeeks < 0 || leadWeeks > 520) {
      throw new Error("Long-lead equipment weeks must be a whole number between 0 and 520.");
    }
    const leadPenalty = validateNonNegativeAmount(args.leadTimePenalty ?? 0, "Lead time penalty");
    const coiStatus = args.coiComplianceStatus ?? "compliant";
    const coiPenalty = validateNonNegativeAmount(args.coiPenalty ?? 0, "COI penalty");

    // ADR-0003 Formula:
    // Leveled Cost = Base Bid + Sum(Active Exclusions) + Lead Penalty + COI Penalty - Sum(Accepted VE Alternates)
    const activeExclusionsCost = exclusions.reduce(
      (sum, exc) => (exc.isWaived ? sum : sum + exc.costImpact),
      0
    );
    const acceptedVeDeduct = veAlternates.reduce(
      (sum, ve) => (ve.isAccepted ? sum + ve.costDeduct : sum),
      0
    );
    const computedLeveledTotal = Math.max(
      0,
      baseBidAmount + activeExclusionsCost + leadPenalty + coiPenalty - acceptedVeDeduct
    );

    // 3. Update existing bid in-place or insert new to preserve agreement references
    let bidId: any;
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
        subcontractorName,
        baseBidAmount,
        lineItems,
        identifiedExclusions: exclusions,
        valueEngineeringAlternates: veAlternates,
        longLeadEquipmentWeeks: leadWeeks,
        leadTimePenalty: leadPenalty,
        coiComplianceStatus: coiStatus,
        coiPenalty,
        leveledTotalCost: computedLeveledTotal,
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
        subcontractorName,
        baseBidAmount,
        lineItems,
        identifiedExclusions: exclusions,
        valueEngineeringAlternates: veAlternates,
        longLeadEquipmentWeeks: leadWeeks,
        leadTimePenalty: leadPenalty,
        coiComplianceStatus: coiStatus,
        coiPenalty,
        leveledTotalCost: computedLeveledTotal,
        isAwarded: false,
        revisionNumber: 1,
        receivedAt: Date.now(),
      });
    }

    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "quote_received",
        title: `Direct Bid Ingested: ${subcontractorName}`,
        description: `Direct proposal ingested for Division ${tradePkg.csiDivision}: Base $${baseBidAmount.toLocaleString()} → Leveled $${computedLeveledTotal.toLocaleString()} (${exclusions.length} exclusions, ${veAlternates.length} VE alternates).`,
        actor: "General Contractor / Estimator",
        timestamp: Date.now(),
      });
    }

    return {
      success: true,
      bidId,
      subcontractorName,
      baseBidAmount,
      leveledTotalCost: computedLeveledTotal,
    };
  },
});

export const insertParsedBid = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    subcontractorName: v.string(),
    baseBidAmount: v.number(),
    lineItems: v.array(
      v.object({
        item: v.string(),
        unit: v.string(),
        quantity: v.number(),
        unitCost: v.number(),
        totalCost: v.number(),
      })
    ),
    identifiedExclusions: v.array(
      v.object({
        canonicalCode: v.optional(v.string()),
        description: v.string(),
        costImpact: v.number(),
        severity: v.string(),
        isWaived: v.optional(v.boolean()),
      })
    ),
    valueEngineeringAlternates: v.optional(
      v.array(
        v.object({
          description: v.string(),
          costDeduct: v.number(),
          isAccepted: v.boolean(),
        })
      )
    ),
    longLeadEquipmentWeeks: v.number(),
    leadTimePenalty: v.number(),
    leadTimeTargetWeeks: v.optional(v.number()),
    coiComplianceStatus: v.string(),
    coiPenalty: v.number(),
    leveledTotalCost: v.number(),
    sourceFileId: v.optional(v.id("projectFiles")),
    /** Extraction path recorded in the bid_leveled audit entry (e.g. "Anthropic claude-sonnet-5" or the deterministic engine). */
    levelingProvider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    const contractor = await ctx.db.get(args.contractorId);
    if (!contractor || contractor.tradePackageId !== tradePkg._id) {
      throw new Error("The contractor is not assigned to this trade package.");
    }
    if (args.sourceFileId) {
      const sourceFile: any = await ctx.db.get(args.sourceFileId);
      if (!sourceFile || sourceFile.projectId !== tradePkg.projectId || sourceFile.tradePackageId !== tradePkg._id) {
        throw new Error("The source quote file does not belong to this project and trade package.");
      }
    }
    const baseBidAmount = validatePositiveAmount(args.baseBidAmount, "Base bid amount");
    assertBidAmountPlausible(tradePkg, baseBidAmount);
    const longLeadEquipmentWeeks = validateLongLeadWeeks(args.longLeadEquipmentWeeks);
    // A6-05r/A6-54: the schedule penalty is always derived in code from the stored
    // weeks and the GC-owned division baseline (or an explicit target), never from
    // a producer- or model-supplied dollar amount.
    const leadTimeTargetWeeks =
      Number.isFinite(args.leadTimeTargetWeeks) && (args.leadTimeTargetWeeks as number) > 0
        ? (args.leadTimeTargetWeeks as number)
        : targetWeeksForDivision(tradePkg.csiDivision);
    const leadTimePenalty = leadTimePenaltyFor(longLeadEquipmentWeeks, leadTimeTargetWeeks);
    const coiPenalty = validateNonNegativeAmount(args.coiPenalty, "COI penalty");
    // A10-06: normalize model-extracted line items instead of persisting negative math.
    const safeLineItems = args.lineItems.map((item) => ({
      ...item,
      quantity: Math.max(0, Number(item.quantity) || 0),
      unitCost: Math.max(0, Number(item.unitCost) || 0),
      totalCost: Math.max(0, Number(item.totalCost) || 0),
    }));
    // 1. Mark contractor as bid_received
    await ctx.db.patch(args.contractorId, { rfqStatus: "bid_received" });

    // 2. Set trade package status to leveling
    await ctx.db.patch(args.tradePackageId, { status: "leveling" });

    // 3. Remove any previous bid from this contractor for this package to keep clean latest bid
    const existingBySource = args.sourceFileId
      ? await ctx.db.query("bids").withIndex("by_source_file", (q) => q.eq("sourceFileId", args.sourceFileId)).first()
      : null;
    const existing = existingBySource || (await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect()).find((bid) => bid.contractorId === args.contractorId);
    if (existingBySource && (existingBySource.tradePackageId !== args.tradePackageId || existingBySource.contractorId !== args.contractorId)) {
      throw new Error("This quote file is already linked to a different contractor or trade package.");
    }

    // 4. Calculate deterministic leveled cost with VE alternates & waived exclusions.
    // A7-03: normalize model output here so an invalid COI string or negative
    // impact can never reach storage even from the internal ingestion path.
    const safeCoiStatus = ALLOWED_COI_STATUSES.has(args.coiComplianceStatus) ? args.coiComplianceStatus : "compliant";
    const safeExclusions = args.identifiedExclusions.map((exc) => ({
      ...exc,
      costImpact: Math.max(0, Number(exc.costImpact) || 0),
    }));
    const safeVeAlternates = (args.valueEngineeringAlternates || []).map((ve) => ({
      ...ve,
      costDeduct: Math.max(0, Number(ve.costDeduct) || 0),
    }));
    const activeExclusionsCost = safeExclusions.reduce(
      (sum, exc) => (exc.isWaived ? sum : sum + exc.costImpact),
      0
    );
    const acceptedVeDeduct = safeVeAlternates.reduce(
      (sum, ve) => (ve.isAccepted ? sum + ve.costDeduct : sum),
      0
    );
    const computedLeveledTotal = Math.max(
      0,
      baseBidAmount +
      activeExclusionsCost +
      leadTimePenalty +
      coiPenalty -
      acceptedVeDeduct
    );

    // 5. Update existing bid in-place or insert new to preserve agreement references
    let bidId: any;
    if (existing) {
      bidId = existing._id;
      await ctx.db.patch(existing._id, {
        subcontractorName: args.subcontractorName,
        baseBidAmount,
        lineItems: safeLineItems,
        identifiedExclusions: safeExclusions,
        valueEngineeringAlternates: safeVeAlternates,
        longLeadEquipmentWeeks,
        leadTimePenalty,
        leadTimeTargetWeeks,
        coiComplianceStatus: safeCoiStatus,
        coiPenalty,
        leveledTotalCost: computedLeveledTotal,
        ...(args.sourceFileId ? { sourceFileId: args.sourceFileId } : {}),
        revisionNumber: ((existing as any).revisionNumber ?? 1) + 1,
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
        subcontractorName: args.subcontractorName,
        baseBidAmount,
        lineItems: safeLineItems,
        identifiedExclusions: safeExclusions,
        valueEngineeringAlternates: safeVeAlternates,
        longLeadEquipmentWeeks,
        leadTimePenalty,
        leadTimeTargetWeeks,
        coiComplianceStatus: safeCoiStatus,
        coiPenalty,
        leveledTotalCost: computedLeveledTotal,
        isAwarded: false,
        revisionNumber: 1,
        ...(args.sourceFileId ? { sourceFileId: args.sourceFileId } : {}),
        receivedAt: Date.now(),
      });
    }

    if (tradePkg) {
      const exclusionsCount = args.identifiedExclusions.length;
      const providerNote = args.levelingProvider ? ` Model path: ${args.levelingProvider}.` : "";
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "bid_leveled",
        title: `Forensic Bid Leveled: ${args.subcontractorName}`,
        description: `Normalized proposal: Base $${baseBidAmount.toLocaleString()} → Leveled $${computedLeveledTotal.toLocaleString()} (${exclusionsCount} exclusions totaling +$${activeExclusionsCost.toLocaleString()}).${providerNote}`,
        actor: "Forensic Leveling Engine (ADR-0003)",
        timestamp: Date.now(),
      });
    }

    return bidId;
  },
});
