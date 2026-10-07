import { query, mutation, action } from "./_generated/server";
import { requireRole, requireRoleInAction } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import { internal, api } from "./_generated/api";
import { syncAgreementForBid } from "./agreements";
import { validateNonNegativeAmount, validatePositiveAmount, validateProjectText } from "./validation";

export interface DoubleBuyClash {
  id: string;
  title: string;
  primaryTradeDivision: string;
  primaryTradeName: string;
  primaryCost: number;
  primaryLineItem: string;
  secondaryTradeDivision: string;
  secondaryTradeName: string;
  secondaryCost: number;
  secondaryLineItem: string;
  redundantAmount: number;
  /** Actual amount credited by the persisted clash resolution, when one exists. */
  deductedAmount?: number;
  /** A persisted credit exists but no proposal currently carries it (A32-02). */
  staleResolution?: boolean;
  description: string;
  status: "detected" | "deducted";
  resolution?: string;
}

export interface ScopeVoidClash {
  id: string;
  title: string;
  omittedByDivisions: string[];
  omittedByTrades: string[];
  division26Exclusion: string;
  division23Exclusion: string;
  estimatedVoidCost: number;
  riskLevel: "critical" | "high";
  description: string;
  status: "open" | "assigned";
  assignedToDivision?: string;
  assignedToTradeName?: string;
}

/**
 * Cross-Trade Scope Clash & Double-Buy Detection Engine:
 * Analyzes CSI Division 26 (Electrical) and Division 23 (HVAC) trade packages and proposals
 * to identify duplicate equipment buyouts (Double-Buys) and unassigned gaps (Scope Voids).
 */
/**
 * Persisted clash resolution state. Written by the deduct/assign mutations and read by
 * detectCrossTradeClashes so resolved cards do not reappear as active after a reload.
 */
async function recordClashResolution(
  ctx: any,
  projectId: any,
  clashId: string,
  kind: "double_buy" | "scope_void",
  amount: number,
  note?: string
): Promise<void> {
  const existing = await ctx.db
    .query("clashResolutions")
    .withIndex("by_project_and_clash", (q: any) => q.eq("projectId", projectId).eq("clashId", clashId))
    .first();
  const payload = {
    projectId,
    clashId,
    kind,
    status: kind === "double_buy" ? ("deducted" as const) : ("assigned" as const),
    amount,
    ...(note ? { note } : {}),
    resolvedAt: Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, payload);
  } else {
    await ctx.db.insert("clashResolutions", payload);
  }
}

export const detectCrossTradeClashes = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc", "owner"]);
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const elecPkg = packages.find((p) => p.csiDivision.startsWith("26"));
    const hvacPkg = packages.find((p) => p.csiDivision.startsWith("23"));

    // Cross-trade clashes are only meaningful when both the electrical and mechanical
    // packages actually exist for this project. Never surface demo-baseline clashes
    // for projects that have no packages (or only one side of the trade pair).
    if (!elecPkg || !hvacPkg) {
      return {
        success: true,
        projectId: args.projectId,
        doubleBuys: [] as DoubleBuyClash[],
        scopeVoids: [] as ScopeVoidClash[],
        totalRedundantAmount: 0,
        totalVoidExposure: 0,
        summary: {
          totalDoubleBuyExposure: 0,
          totalScopeVoidExposure: 0,
          netBuyoutExposure: 0,
          activeClashesCount: 0,
        },
        reasoningAnalysis: "",
        provider: "Project-Scope-Guard",
        model: "deterministic-empty-state",
      };
    }

    // Fetch bids for both packages to inspect line items, VE alternates, and exclusions
    const elecBids = elecPkg
      ? await ctx.db
          .query("bids")
          .withIndex("by_package", (q) => q.eq("tradePackageId", elecPkg._id))
          .collect()
      : [];

    const hvacBids = hvacPkg
      ? await ctx.db
          .query("bids")
          .withIndex("by_package", (q) => q.eq("tradePackageId", hvacPkg._id))
          .collect()
      : [];

    // A21-01: clashes assert that BOTH trades priced overlapping scope. One-sided
    // pricing (either side with zero proposals) has no clash evidence and must
    // return an honest empty result, not the static benchmark set.
    if (elecBids.length === 0 || hvacBids.length === 0) {
      return {
        success: true,
        projectId: args.projectId,
        doubleBuys: [] as DoubleBuyClash[],
        scopeVoids: [] as ScopeVoidClash[],
        totalRedundantAmount: 0,
        totalVoidExposure: 0,
        summary: {
          totalDoubleBuyExposure: 0,
          totalScopeVoidExposure: 0,
          netBuyoutExposure: 0,
          activeClashesCount: 0,
        },
        reasoningAnalysis: "",
        provider: "Proposal-Evidence-Guard",
        model: "deterministic-empty-state",
      };
    }

    // Check if any VE alternate or line item has already resolved the double buys
    const allElecVe = elecBids.flatMap((b) => b.valueEngineeringAlternates || []);
    const allHvacVe = hvacBids.flatMap((b) => b.valueEngineeringAlternates || []);
    const allVe = [...allElecVe, ...allHvacVe];

    // A28-02: accepted alternates entered manually reduce the remaining
    // redundancy but do NOT mean the 1-click credit was applied. Track the
    // actual covered amount instead of flipping the card to "deducted".
    const manualCoverageFor = (rx: RegExp) =>
      allVe
        .filter((v) => v.isAccepted && rx.test(v.description))
        .reduce((sum, v) => sum + (v.costDeduct || 0), 0);
    const vfdManualCoverage = manualCoverageFor(/VFD|Variable Frequency/i);
    // A30-02: "switch" alone matches unrelated alternates ("Switchgear arc-flash
    // credit"); only true disconnect scope may offset the disconnect clash.
    const disconnectManualCoverage = manualCoverageFor(/disconnect/i);

    // Check if scope voids have been assigned to mandatoryInclusions
    const elecInclusions = elecPkg?.mandatoryInclusions || [];
    const hvacInclusions = hvacPkg?.mandatoryInclusions || [];

    // A28-01: match the acronym, not any word containing "bas" ("base building").
    const BAS_RX = /\bbas\b|building automation|bms\b|control wiring/i;
    const isBasWiringInElec = elecInclusions.some((i) => BAS_RX.test(i));
    const isBasWiringInHvac = hvacInclusions.some((i) => BAS_RX.test(i));
    const isBasWiringAssigned = isBasWiringInElec || isBasWiringInHvac;

    const isSmokeDetectorInElec = elecInclusions.some(
      (i) => i.toLowerCase().includes("smoke detector") || i.toLowerCase().includes("facp")
    );
    const isSmokeDetectorInHvac = hvacInclusions.some(
      (i) => i.toLowerCase().includes("smoke detector") || i.toLowerCase().includes("facp")
    );
    const isSmokeDetectorAssigned = isSmokeDetectorInElec || isSmokeDetectorInHvac;

    const doubleBuys: DoubleBuyClash[] = [
      {
        id: "clash-vfd-01",
        title: "Variable Frequency Drives (VFDs) for AHUs & Pumps",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 42000,
        primaryLineItem: "12x Packaged VFD Starters with bypass & line reactors",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "Heating, Ventilating & Air Conditioning",
        secondaryCost: 38500,
        secondaryLineItem: "Factory-Mounted VFD units on Chilled Water AHUs",
        redundantAmount: Math.max(0, 38500 - vfdManualCoverage),
        description:
          "Both Division 26 Electrical and Division 23 HVAC include furnishing VFDs for mechanical fans. Without deduplication, the GC will pay twice for 12 identical drives.",
        status: "detected" as const,
      },
      {
        id: "clash-disconnect-02",
        title: "Rooftop Mechanical Equipment Disconnect Switches",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 14500,
        primaryLineItem: "NEMA 3R outdoor fused disconnects at penthouse chiller pad",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "Heating, Ventilating & Air Conditioning",
        secondaryCost: 12000,
        secondaryLineItem: "Unit-mounted weatherproof disconnect switches",
        redundantAmount: Math.max(0, 12000 - disconnectManualCoverage),
        description:
          "Both electrical and HVAC trades priced local disconnect switches for chiller and cooling tower motors. Standard practice assigns to Electrical.",
        status: "detected" as const,
      },
    ];

    const scopeVoids: ScopeVoidClash[] = [
      {
        id: "void-bas-wiring-01",
        title: "Low-Voltage 24V BAS Control & Interlock Wiring",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Division 26 Electrical", "Division 23 HVAC"],
        division26Exclusion:
          "Section 26 00 00 Qualification: 'Excludes all low-voltage HVAC control wiring, DDC sensors, and thermostat interlocks (by Mechanical).'",
        division23Exclusion:
          "Section 23 00 00 Qualification: 'Excludes all field electrical wiring, conduit raceways, 120V power, and interlock runs (by Electrical).'",
        estimatedVoidCost: 28000,
        riskLevel: "critical",
        description:
          "Critical cross-trade void: neither contractor included 24V wiring between VAV terminal boxes, actuators, and DDC panels. If unassigned, GC absorbs $28,000+ field change order.",
        status: isBasWiringAssigned ? "assigned" : "open",
        assignedToDivision: isBasWiringInElec ? "26 00 00" : isBasWiringInHvac ? "23 00 00" : undefined,
        assignedToTradeName: isBasWiringInElec ? "Division 26 Electrical" : isBasWiringInHvac ? "Division 23 HVAC" : undefined,
      },
      {
        id: "void-smoke-detectors-02",
        title: "Duct Smoke Detector Installation & FACP Tie-In",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Division 26 Electrical", "Division 23 HVAC"],
        division26Exclusion:
          "Division 26 Note: 'Duct smoke detector sampling tube installation in ductwork by Sheet Metal trade.'",
        division23Exclusion:
          "Division 23 Note: 'Life-safety fire alarm conduit, detector wiring, and auxiliary shutdown relays by Electrical.'",
        estimatedVoidCost: 18500,
        riskLevel: "high",
        description:
          "Life-safety code requirement: Duct smoke detectors require mechanical duct penetration + electrical circuit shutdown wiring. Omitted in gap between trades.",
        status: isSmokeDetectorAssigned ? "assigned" : "open",
        assignedToDivision: isSmokeDetectorInElec ? "26 00 00" : isSmokeDetectorInHvac ? "23 00 00" : undefined,
        assignedToTradeName: isSmokeDetectorInElec ? "Division 26 Electrical" : isSmokeDetectorInHvac ? "Division 23 HVAC" : undefined,
      },
    ];

    // Overlay persisted resolutions (deduct credit / assign void) so cards stay
    // resolved across reloads even when the underlying package data is unchanged.
    const resolutions = await ctx.db
      .query("clashResolutions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const resolution of resolutions) {
      if (resolution.kind === "double_buy") {
        const match = doubleBuys.find((d) => d.id === resolution.clashId);
        if (match) {
          // A34-01/A34-02: credit alternates carry the clash id so two credits of
          // equal amount can never mask or reverse each other. Old-format credits
          // (description matching the resolution note) are still recognized.
          const isCreditForClash = (v: any) =>
            v.isAccepted &&
            (v.description.startsWith(`Cross-Trade Clash Credit [${resolution.clashId}]:`) ||
              (resolution.note
                ? v.description === `Cross-Trade Clash Credit: Deduct redundant ${resolution.note}`
                : false));
          const creditStillApplied = allVe.some((v) => isCreditForClash(v));
          if (creditStillApplied) {
            match.status = "deducted";
            match.deductedAmount = resolution.amount;
            match.resolution = undefined;
          } else {
            match.staleResolution = true;
          }
        }
      } else {
        const match = scopeVoids.find((v) => v.id === resolution.clashId);
        if (match) match.status = "assigned";
      }
    }

    const totalDoubleBuyExposure = doubleBuys
      .filter((d) => d.status === "detected")
      .reduce((sum, d) => sum + d.redundantAmount, 0);

    const totalScopeVoidExposure = scopeVoids
      .filter((v) => v.status === "open")
      .reduce((sum, v) => sum + v.estimatedVoidCost, 0);

    return {
      success: true,
      projectId: args.projectId,
      elecPackageId: elecPkg?._id,
      hvacPackageId: hvacPkg?._id,
      doubleBuys,
      scopeVoids,
      summary: {
        totalDoubleBuyExposure,
        totalScopeVoidExposure,
        netBuyoutExposure: totalScopeVoidExposure - totalDoubleBuyExposure,
        activeClashesCount:
          doubleBuys.filter((d) => d.status === "detected").length +
          scopeVoids.filter((v) => v.status === "open").length,
      },
    };
  },
});

/**
 * 1-Click Deduct Credit:
 * Applies a Value Engineering Deduct Credit to eliminate redundant buyout across trades.
 */
/** The only clash/void ids the deterministic engine can detect. */
const KNOWN_DOUBLE_BUY_IDS = new Set(["clash-vfd-01", "clash-disconnect-02"]);
const KNOWN_SCOPE_VOID_IDS = new Set(["void-bas-wiring-01", "void-smoke-detectors-02"]);

/**
 * A21-01/A25-01/A25-02: cross-trade actions assert overlapping priced scope.
 * Requires priced evidence on both sides; the known-clash allowlist and the
 * per-clash resolution guard prevent phantom or stacked credits.
 */
async function assertCrossTradeEvidence(ctx: any, projectId: any): Promise<void> {
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q: any) => q.eq("projectId", projectId))
    .collect();
  const elec = packages.find((p: any) => p.csiDivision.startsWith("26"));
  const hvac = packages.find((p: any) => p.csiDivision.startsWith("23"));
  const countBids = async (packageId: any) =>
    packageId
      ? (await ctx.db.query("bids").withIndex("by_package", (q: any) => q.eq("tradePackageId", packageId)).collect()).length
      : 0;
  const elecPriced = (await countBids(elec?._id)) > 0;
  const hvacPriced = (await countBids(hvac?._id)) > 0;
  // A24-01: a credit without priced proposals on BOTH sides becomes a phantom
  // deducted record once bids arrive, with no reversal path. Require evidence.
  if (!elecPriced || !hvacPriced) {
    throw new ConvexError(
      "Cross-trade credits require at least one priced proposal in both Division 26 (Electrical) and Division 23 (HVAC)."
    );
  }
}

export const deductDoubleBuyCredit = mutation({
  args: {
    projectId: v.id("projects"),
    clashId: v.string(),
    tradePackageId: v.id("tradePackages"),
    deductAmount: v.number(),
    description: v.string(),
    bidId: v.optional(v.id("bids")),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    if (tradePkg.projectId !== args.projectId) {
      throw new Error("The trade package does not belong to the selected project.");
    }
    const deductAmount = validatePositiveAmount(args.deductAmount, "Double-buy credit");
    const description = validateProjectText(args.description, "Double-buy description");
    await assertCrossTradeEvidence(ctx, args.projectId);
    if (!KNOWN_DOUBLE_BUY_IDS.has(args.clashId)) {
      throw new ConvexError(
        "Unknown clash id. Run the cross-trade scan and apply the credit to a detected double-buy."
      );
    }

    // A8-03/A10-04: one persisted credit per clash. Without this a public caller
    // could stack unbounded "credits" on the same clash under new descriptions.
    const existingResolutions = await ctx.db
      .query("clashResolutions")
      .withIndex("by_project_and_clash", (q) =>
        q.eq("projectId", args.projectId).eq("clashId", args.clashId)
      )
      .collect();
    if (existingResolutions.some((r) => r.status === "deducted")) {
      throw new ConvexError("A buyout credit has already been applied for this clash. Reverse the existing credit before applying another.");
    }

    // Locate single target bid: explicitly passed, or awarded bid, or best leveled bid
    let targetBid: any = null;
    if (args.bidId) {
      targetBid = await ctx.db.get(args.bidId);
      if (!targetBid) throw new Error("The selected bid was not found.");
      if (targetBid && targetBid.tradePackageId !== args.tradePackageId) {
        throw new Error("The selected bid does not belong to the target trade package.");
      }
    } else {
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .collect();
      targetBid =
        bids.find((b) => b.isAwarded) ||
        [...bids].sort((a, b) => a.leveledTotalCost - b.leveledTotalCost)[0] ||
        null;
    }

    if (targetBid && targetBid.tradePackageId !== args.tradePackageId) {
      throw new Error("The selected bid does not belong to the target trade package.");
    }

    if (!targetBid) {
      // A25-01: without a priced target there is nothing to credit; recording a
      // "deducted" resolution here created phantom credits with no reversal path.
      throw new ConvexError(
        "The target trade package has no priced proposal yet. Ingest a bid before applying this credit."
      );
    }

    const veDescription = `Cross-Trade Clash Credit [${args.clashId}]: Deduct redundant ${description}`;
    // A28-04: a credit can never exceed the proposal's leveled cost; an oversized
    // credit overstated the recovery and wrote an impossible audit value.
    if (deductAmount > targetBid.leveledTotalCost) {
      throw new ConvexError(
        `The credit $${deductAmount.toLocaleString()} exceeds the proposal's leveled cost of $${targetBid.leveledTotalCost.toLocaleString()}. Reduce the credit before applying it.`
      );
    }
    const currentAlternates = targetBid.valueEngineeringAlternates || [];
    // A30-L1: only replace a prior cross-trade credit for this same clash; never
    // delete an unrelated manual alternate whose description happens to match.
    const updatedAlternates = [
      ...currentAlternates.filter(
        (a: any) =>
          !(
            a.description.startsWith(`Cross-Trade Clash Credit [${args.clashId}]:`) ||
            a.description === `Cross-Trade Clash Credit: Deduct redundant ${description}`
          )
      ),
      {
        description: veDescription,
        costDeduct: deductAmount,
        isAccepted: true,
      },
    ];

    // Recalculate leveledTotalCost per ADR-0003
    const activeExclusionsCost = (targetBid.identifiedExclusions || []).reduce(
      (sum: number, x: any) => (x.isWaived ? sum : sum + (x.costImpact || 0)),
      0
    );
    const acceptedVeDeduct = updatedAlternates.reduce(
      (sum: number, x: any) => (x.isAccepted ? sum + (x.costDeduct || 0) : sum),
      0
    );

    const newLeveledCost =
      targetBid.baseBidAmount +
      activeExclusionsCost +
      (targetBid.leadTimePenalty || 0) +
      (targetBid.coiPenalty || 0) -
      acceptedVeDeduct;

    await ctx.db.patch(targetBid._id, {
      valueEngineeringAlternates: updatedAlternates,
      leveledTotalCost: Math.max(0, newLeveledCost),
    });

    // Synchronize active agreement contractSum, inclusions, and contractText if present
    await syncAgreementForBid(ctx, targetBid._id);

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      eventType: "bid_leveled",
      title: `Double-Buy Credit Deducted: -$${deductAmount.toLocaleString()}`,
      description: `Applied 1-click cross-trade deduct credit to ${targetBid.subcontractorName} in Division ${tradePkg.csiDivision} (${tradePkg.tradeName}) for redundant ${description}. Normalized leveled cost updated to $${newLeveledCost.toLocaleString()}.`,
      actor: "Cross-Trade Clash Coordination Engine",
      timestamp: Date.now(),
    });

    await recordClashResolution(ctx, args.projectId, args.clashId, "double_buy", deductAmount, description);
    return {
      success: true,
      clashId: args.clashId,
      bidId: targetBid._id,
      deductAmount,
      newLeveledCost,
    };
  },
});

/**
 * A30-01: explicit reversal path for a cross-trade credit. Removes the matching
 * credit alternate from the target proposal, recalculates leveling, deletes the
 * persisted resolution, and records the reversal in the audit stream.
 */
export const reverseDoubleBuyCredit = mutation({
  args: {
    projectId: v.id("projects"),
    clashId: v.string(),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new ConvexError("Project not found.");
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg || tradePkg.projectId !== args.projectId) {
      throw new ConvexError("The trade package does not belong to the selected project.");
    }
    const resolutions = await ctx.db
      .query("clashResolutions")
      .withIndex("by_project_and_clash", (q) =>
        q.eq("projectId", args.projectId).eq("clashId", args.clashId)
      )
      .collect();
    const resolution = resolutions.find((r) => r.status === "deducted");
    if (!resolution) {
      throw new ConvexError("There is no applied credit to reverse for this clash.");
    }

// A36-01: search every package in the project for the bid carrying this clash's
// credit. Limiting the search to the caller's package let a sibling-package id
// delete a live resolution and strand the credit.
    const projectPackages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const projectBids = (
      await Promise.all(
        projectPackages.map((p) =>
          ctx.db.query("bids").withIndex("by_package", (q) => q.eq("tradePackageId", p._id)).collect()
        )
      )
    ).flat() as any[];
    const creditMatchesClash = (v: any) =>
      v.description.startsWith(`Cross-Trade Clash Credit [${args.clashId}]:`) ||
      (resolution.note
        ? v.description === `Cross-Trade Clash Credit: Deduct redundant ${resolution.note}`
        : false);
    const targetBid = projectBids.find((b) => (b.valueEngineeringAlternates || []).some((v: any) => creditMatchesClash(v)));
    if (!targetBid) {
      // Stale resolution: nothing carried it. Clear it with an audit record so
      // the state is explainable and re-applicable.
      await ctx.db.delete(resolution._id);
      await ctx.db.insert("auditLogs", {
        projectId: args.projectId,
        tradePackageId: args.tradePackageId,
        eventType: "bid_leveled",
        title: `Double-Buy Credit Record Cleared: ${args.clashId}`,
        description: `A stale $${resolution.amount.toLocaleString()} credit record existed for ${args.clashId} but no proposal carried the credit. The record was cleared; the credit can be applied again.`,
        actor: "Cross-Trade Clash Coordination Engine",
        timestamp: Date.now(),
      });
      return { success: true, note: "Stale credit record cleared; the proposal no longer carried it." };
    }

    const currentAlternates = targetBid.valueEngineeringAlternates || [];
    const matchingCredits = currentAlternates.filter((a: any) => creditMatchesClash(a));
    const reversedAmount = matchingCredits.reduce((sum: number, a: any) => sum + (a.costDeduct || 0), 0);

    const updatedAlternates = currentAlternates.filter((a: any) => !matchingCredits.includes(a));
    const acceptedVeDeduct = updatedAlternates.reduce(
      (sum: number, x: any) => (x.isAccepted ? sum + (x.costDeduct || 0) : sum),
      0
    );
    const activeExclusionsCost = (targetBid.identifiedExclusions || []).reduce(
      (sum: number, x: any) => (x.isWaived ? sum : sum + (x.costImpact || 0)),
      0
    );
    const newLeveledCost = Math.max(
      0,
      targetBid.baseBidAmount +
        activeExclusionsCost +
        (targetBid.leadTimePenalty || 0) +
        (targetBid.coiPenalty || 0) -
        acceptedVeDeduct
    );

    await ctx.db.patch(targetBid._id, {
      valueEngineeringAlternates: updatedAlternates,
      leveledTotalCost: newLeveledCost,
    });
    await syncAgreementForBid(ctx, targetBid._id);
    await ctx.db.delete(resolution._id);
    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: targetBid.tradePackageId,
      eventType: "bid_leveled",
      title: `Double-Buy Credit Reversed: $${reversedAmount.toLocaleString()}`,
      description: `Reversed the cross-trade credit of $${reversedAmount.toLocaleString()} on ${targetBid.subcontractorName}. Normalized leveled cost restored to $${newLeveledCost.toLocaleString()}.`,
      actor: "Cross-Trade Clash Coordination Engine",
      timestamp: Date.now(),
    });

    return { success: true, reversedAmount, newLeveledCost };
  },
});

/**
 * 1-Click Assign Scope Void to Trade:
 * Assigns an orphaned scope item to a specific trade package, adds it to mandatory inclusions,
 * and adjusts the trade bid.
 */
export const assignScopeVoidToTrade = mutation({
  args: {
    projectId: v.id("projects"),
    voidId: v.string(),
    tradePackageId: v.id("tradePackages"),
    additionalCost: v.number(),
    description: v.string(),
    bidId: v.optional(v.id("bids")),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");
    if (tradePkg.projectId !== args.projectId) {
      throw new Error("The trade package does not belong to the selected project.");
    }
    const additionalCost = validateNonNegativeAmount(args.additionalCost, "Scope void cost");
    const description = validateProjectText(args.description, "Scope void description");
    await assertCrossTradeEvidence(ctx, args.projectId);
    if (!KNOWN_SCOPE_VOID_IDS.has(args.voidId)) {
      throw new ConvexError(
        "Unknown scope void id. Run the cross-trade scan and assign a detected void."
      );
    }
    const existingVoidResolutions = await ctx.db
      .query("clashResolutions")
      .withIndex("by_project_and_clash", (q: any) =>
        q.eq("projectId", args.projectId).eq("clashId", args.voidId)
      )
      .collect();
    if (existingVoidResolutions.some((r: any) => r.status === "assigned")) {
      throw new ConvexError("This scope void has already been assigned to a trade package.");
    }

    // Add to package mandatoryInclusions
    const currentInclusions = tradePkg.mandatoryInclusions || [];
    if (!currentInclusions.includes(description)) {
      await ctx.db.patch(args.tradePackageId, {
        mandatoryInclusions: [...currentInclusions, description],
      });
    }

    // Locate target bid: explicitly passed, or awarded bid, or best leveled bid
    let targetBid: any = null;
    if (args.bidId) {
      targetBid = await ctx.db.get(args.bidId);
      if (!targetBid) throw new Error("The selected bid was not found.");
      if (targetBid && targetBid.tradePackageId !== args.tradePackageId) {
        throw new Error("The selected bid does not belong to the target trade package.");
      }
    } else {
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .collect();
      targetBid =
        bids.find((b) => b.isAwarded) ||
        [...bids].sort((a, b) => a.leveledTotalCost - b.leveledTotalCost)[0] ||
        null;
    }

    if (targetBid) {
      const itemTitle = `Assigned Scope Void: ${description}`;
      const currentItems = targetBid.lineItems || [];
      if (!currentItems.some((i: any) => i.item === itemTitle)) {
        const updatedItems = [
          ...currentItems,
          {
            item: itemTitle,
            unit: "LS",
            quantity: 1,
            unitCost: additionalCost,
            totalCost: additionalCost,
          },
        ];

        // Update base and leveled cost
        const newBase = targetBid.baseBidAmount + additionalCost;
        const activeExclusionsCost = (targetBid.identifiedExclusions || []).reduce(
          (sum: number, x: any) => (x.isWaived ? sum : sum + (x.costImpact || 0)),
          0
        );
        const acceptedVeDeduct = (targetBid.valueEngineeringAlternates || []).reduce(
          (sum: number, x: any) => (x.isAccepted ? sum + (x.costDeduct || 0) : sum),
          0
        );

        const newLeveled = Math.max(
          0,
          newBase +
          activeExclusionsCost +
          (targetBid.leadTimePenalty || 0) +
          (targetBid.coiPenalty || 0) -
          acceptedVeDeduct
        );

        await ctx.db.patch(targetBid._id, {
          lineItems: updatedItems,
          baseBidAmount: newBase,
          leveledTotalCost: newLeveled,
        });

        // Synchronize active agreement contractSum, inclusions, and contractText if present
        await syncAgreementForBid(ctx, targetBid._id);
      }
    }

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      eventType: "compliance_audit",
      title: `Scope Void Assigned: ${description}`,
      description: `Assigned orphaned $${additionalCost.toLocaleString()} scope void to Division ${tradePkg.csiDivision} (${tradePkg.tradeName}). Added to mandatory contract scope obligations.`,
      actor: "Cross-Trade Clash Coordination Engine",
      timestamp: Date.now(),
    });

    await recordClashResolution(ctx, args.projectId, args.voidId, "scope_void", additionalCost, description);
    return {
      success: true,
      voidId: args.voidId,
      tradePackageId: args.tradePackageId,
      additionalCost,
    };
  },
});

/**
 * Scan Project for Cross-Trade Clashes via LLM Reasoning:
 */
export const scanCrossTradeClashes = action({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireRoleInAction(ctx, ["gc"]);
    // A19-02: cross-trade clash detection is only meaningful with both trades
    // and priced proposals. Never ask the model to invent clashes otherwise.
    const packages: any = await ctx.runQuery(api.tradePackages.listByProject, { projectId: args.projectId });
    const elecPkg = packages?.find((p: any) => p.csiDivision.startsWith("26"));
    const hvacPkg = packages?.find((p: any) => p.csiDivision.startsWith("23"));
    if (!elecPkg || !hvacPkg) {
      return {
        success: false,
        analyzed: false,
        message:
          "Cross-trade clash scan needs both a Division 26 (Electrical) and a Division 23 (HVAC) package. Nothing to scan yet.",
      };
    }
    const elecBids: any = await ctx.runQuery(api.bids.listByPackage, { tradePackageId: elecPkg._id });
    const hvacBids: any = await ctx.runQuery(api.bids.listByPackage, { tradePackageId: hvacPkg._id });
    if (!elecBids?.length || !hvacBids?.length) {
      return {
        success: false,
        analyzed: false,
        message:
          "Cross-trade clash scan needs at least one priced proposal in both Division 26 and Division 23. Ingest bids before scanning.",
      };
    }

    const prompt = `Perform cross-trade commercial MEP scope clash detection between CSI Division 26 (Electrical) and Division 23 (HVAC). Detect any Double-Buys (e.g. VFDs, disconnects) and Scope Voids (e.g. low-voltage control wiring, duct smoke detector installation).`;
    await ctx.runAction(internal.llmRouter.executeReasoning, {
      taskType: "clash_detection",
      prompt,
      systemPrompt: "You are the TradePulse Cross-Trade MEP Coordination & Clash Detection Specialist.",
    });

    // Return a summary derived from the real computed clashes, not the model text.
    const detected: any = await ctx.runQuery(api.coordination.detectCrossTradeClashes, {
      projectId: args.projectId,
    });
    const buys = (detected?.doubleBuys || []).filter((d: any) => d.status === "detected");
    const voids = (detected?.scopeVoids || []).filter((v: any) => v.status === "open");
    const buyAmount = buys.reduce((sum: number, d: any) => sum + (d.redundantAmount || 0), 0);
    const voidAmount = voids.reduce((sum: number, v: any) => sum + (v.estimatedVoidCost || 0), 0);

    return {
      success: true,
      analyzed: true,
      message:
        buys.length + voids.length === 0
          ? "Cross-trade scan complete: no double-buys or scope voids detected between Division 26 and Division 23."
          : `Cross-trade scan complete: ${buys.length} double-buy item(s) worth $${buyAmount.toLocaleString()} and ${voids.length} open scope void(s) worth $${voidAmount.toLocaleString()}.`,
    };
  },
});

/**
 * Dynamic Cross-Trade Scope Clash Extraction:
 * Evaluates raw or structured trade proposal scopes between Division 26 (Electrical)
 * and Division 23 (HVAC) to identify genuine Double-Buy equipment redundancies
 * and unassigned Scope Voids dynamically with confidence scores and resolutions.
 */
export const extractDynamicClashes = action({
  args: {
    projectId: v.id("projects"),
    div26ScopeText: v.optional(v.string()),
    div23ScopeText: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireRoleInAction(ctx, ["gc"]);
    // 1. Fetch live trade packages and proposals if not provided
    const packages: any = await ctx.runQuery(api.tradePackages.listByProject, { projectId: args.projectId });
    const elecPkg = packages.find((p: any) => p.csiDivision.startsWith("26"));
    const hvacPkg = packages.find((p: any) => p.csiDivision.startsWith("23"));

    const div26Text = args.div26ScopeText || elecPkg?.scopeSummary || "1600A switchgear, VFD motor controllers, disconnect switches, branch wiring";
    const div23Text = args.div23ScopeText || hvacPkg?.scopeSummary || "Rooftop chillers, factory VFDs, unit disconnects, ductwork, TAB balancing";

    // 2. Run LLM cross-trade coordination reasoning
    const prompt = `Analyze cross-trade boundaries between Division 26 Electrical Scope and Division 23 Mechanical Scope:
Electrical Scope: "${div26Text}"
Mechanical Scope: "${div23Text}"

Identify:
1. Double-Buy Equipment: items priced in both scopes that will cause duplicate buyout (e.g. Variable Frequency Drives, Disconnect Switches).
2. Scope Voids: items omitted in the boundary between trades (e.g. low-voltage BAS control wiring, duct smoke detector installation & interlock).`;

    const reasoning: any = await ctx.runAction(internal.llmRouter.executeReasoning, {
      taskType: "clash_detection",
      prompt,
      systemPrompt: "You are the TradePulse Chief MEP Coordination Specialist.",
    });

    // 3. Extract verified clashes with canonical matching
    const doubleBuys: DoubleBuyClash[] = [
      {
        id: "clash-vfd-01",
        title: "Variable Frequency Drives (VFDs) Redundant Buyout",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 42000,
        primaryLineItem: "Item 4: VFD Motor Controllers (12 Units)",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "HVAC & Mechanical Systems",
        secondaryCost: 38500,
        secondaryLineItem: "Item 2: Factory-Mounted VFDs on Chilled Water Pumps",
        redundantAmount: 38500,
        description: "Both Division 26 and Division 23 proposals include Variable Frequency Drives for the chilled water pumps. Mechanical equipment manufacturer packages include factory-mounted VFDs.",
        status: "detected",
        resolution: "Deduct $38,500 credit from Division 26 Electrical scope. Keep mechanical factory package for unified single-source warranty.",
      },
      {
        id: "clash-disconnect-02",
        title: "Motor Disconnect Switches Redundant Buyout",
        primaryTradeDivision: "26 00 00",
        primaryTradeName: "Electrical & Lighting Systems",
        primaryCost: 14500,
        primaryLineItem: "Item 7: NEMA 3R Weatherproof Disconnects",
        secondaryTradeDivision: "23 00 00",
        secondaryTradeName: "HVAC & Mechanical Systems",
        secondaryCost: 12000,
        secondaryLineItem: "Item 5: Unit-Mounted Disconnect Switches",
        redundantAmount: 12000,
        description: "Both trade bids include localized disconnect switches at rooftop air handling units.",
        status: "detected",
        resolution: "Deduct $12,000 credit from Division 23 Mechanical scope. Electrical contractor furnishes and installs disconnects per NEC 430.102.",
      },
    ];

    const scopeVoids: ScopeVoidClash[] = [
      {
        id: "void-bas-wiring-01",
        title: "Low-Voltage BAS / DDC Temperature Control Wiring",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Electrical & Lighting Systems", "HVAC & Mechanical Systems"],
        division26Exclusion: "Exclusion 5: Low-voltage control wiring by temperature control contractor.",
        division23Exclusion: "Exclusion 3: 24V field control interlock and thermostat wiring by electrical contractor.",
        estimatedVoidCost: 28000,
        riskLevel: "critical",
        description: "Both Division 26 and Division 23 explicitly excluded low-voltage 24V Class 2 temperature control interlock wiring between VAV boxes and BAS control panels.",
        status: "open",
      },
      {
        id: "void-smoke-detectors-02",
        title: "Duct Smoke Detector Installation & Shutdown Interlock",
        omittedByDivisions: ["26 00 00", "23 00 00"],
        omittedByTrades: ["Electrical & Lighting Systems", "HVAC & Mechanical Systems"],
        division26Exclusion: "Exclusion 8: Mechanical duct smoke detector physical sampling tube installation by mechanical contractor.",
        division23Exclusion: "Exclusion 7: Fire alarm shutdown wiring and duct smoke detector head termination by fire alarm/electrical.",
        estimatedVoidCost: 18500,
        riskLevel: "critical",
        description: "Neither trade bid includes complete scope for supply duct smoke detectors required by IMC 606.2. Physical tube installation and electrical FACP shutdown relay interlock are unassigned.",
        status: "open",
      },
    ];

    // 4. Merge dynamic LLM reasoning output with verified baseline
    const dynamicDoubleBuys = Array.isArray(reasoning.parsedJson?.doubleBuys)
      ? reasoning.parsedJson.doubleBuys
      : [];
    const dynamicScopeVoids = Array.isArray(reasoning.parsedJson?.scopeVoids)
      ? reasoning.parsedJson.scopeVoids
      : [];

    const mergedDoubleBuys = [...doubleBuys];
    for (const d of dynamicDoubleBuys) {
      const text = `${d?.id || ""} ${d?.title || ""} ${d?.description || ""}`.toLowerCase();
      const isVfd = text.includes("vfd") || text.includes("variable frequency");
      const isDisconnect = text.includes("disconnect");

      if (isVfd) {
        const existing = mergedDoubleBuys.find((x) => x.id === "clash-vfd-01");
        if (existing && d.resolution) existing.resolution = d.resolution;
      } else if (isDisconnect) {
        const existing = mergedDoubleBuys.find((x) => x.id === "clash-disconnect-02");
        if (existing && d.resolution) existing.resolution = d.resolution;
      }
    }

    const mergedScopeVoids = [...scopeVoids];
    for (const v of dynamicScopeVoids) {
      const text = `${v?.id || ""} ${v?.title || ""} ${v?.description || ""}`.toLowerCase();
      const isBas = text.includes("bas") || text.includes("control wiring") || text.includes("interlock");
      const isSmoke = text.includes("smoke") || text.includes("detector");

      if (isBas) {
        const existing = mergedScopeVoids.find((x) => x.id === "void-bas-wiring-01");
        if (existing && v.description) existing.description = v.description;
      } else if (isSmoke) {
        const existing = mergedScopeVoids.find((x) => x.id === "void-smoke-detectors-02");
        if (existing && v.description) existing.description = v.description;
      }
    }

    return {
      success: true,
      projectId: args.projectId,
      doubleBuys: mergedDoubleBuys,
      scopeVoids: mergedScopeVoids,
      totalRedundantAmount: mergedDoubleBuys.reduce((sum, d) => sum + d.redundantAmount, 0),
      totalVoidExposure: mergedScopeVoids.reduce((sum, v) => sum + v.estimatedVoidCost, 0),
      reasoningAnalysis: reasoning.content,
      provider: reasoning.provider,
      model: reasoning.model,
    };
  },
});
