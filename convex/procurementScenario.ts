import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { sub1Account } from "./judgeDemo/runs";
import { attachProjectToDemo } from "./lib/demoTenancy";
import { attachBidderVendor } from "./lib/vendorDirectory";

/**
 * Internal fixture: a fresh project with one Div 26 trade package in bid leveling, where sub1's
 * existing contractor is invited to bid next to a second, competing electrical contractor. Nothing is
 * awarded or generated, so the GC awards and executes it through the regular procurement views.
 * Existing contractors, agreements and history are never modified; re-running with the same suffix
 * returns the rows created the first time.
 */

export const PROCUREMENT_SCENARIO_TITLE = "Procurement scenario";

export const SCENARIO_SUB1_LINE_ITEMS = [
  { item: "Switchgear, panelboards & transformers", totalCost: 26_000 },
  { item: "Branch conduit, wire & devices", totalCost: 21_000 },
  { item: "Lighting fixtures & controls", totalCost: 9_000 },
  { item: "Closeout: testing, commissioning & O&M manuals", totalCost: 4_000 },
] as const;

export const SCENARIO_SUB1_EXCLUSION = {
  canonicalCode: "CSI_26_SEISMIC",
  description: "IBC Section 1613 engineered seismic bracing (excluded by the bidder; by others)",
  costImpact: 4_500,
  severity: "critical",
  isWaived: false,
} as const;

export const SCENARIO_COMPETING_NAME = "Cupertino Electric, Inc. (scenario bidder)";

export const SCENARIO_COMPETING_LINE_ITEMS = [
  { item: "Switchgear, panelboards & transformers", totalCost: 29_000 },
  { item: "Branch conduit, wire & devices", totalCost: 23_500 },
  { item: "Lighting fixtures & controls", totalCost: 10_500 },
  { item: "Closeout: testing, commissioning & O&M manuals", totalCost: 4_500 },
] as const;

export const SCENARIO_COMPETING_EXCLUSION = {
  canonicalCode: "CSI_26_TEMP_POWER",
  description: "Temporary construction power distribution (excluded by the bidder)",
  costImpact: 3_000,
  severity: "moderate",
  isWaived: false,
} as const;

const sum = (items: ReadonlyArray<{ totalCost: number }>) => items.reduce((a, l) => a + l.totalCost, 0);

export const SCENARIO_SUB1_LEVELED = sum(SCENARIO_SUB1_LINE_ITEMS) + SCENARIO_SUB1_EXCLUSION.costImpact;
export const SCENARIO_COMPETING_LEVELED = sum(SCENARIO_COMPETING_LINE_ITEMS) + SCENARIO_COMPETING_EXCLUSION.costImpact;

const SUFFIX = /^[A-Za-z0-9-]{1,24}$/;

export function scenarioProjectTitle(suffix: string): string {
  return `${PROCUREMENT_SCENARIO_TITLE} · ${suffix}`;
}

function lineItems(items: ReadonlyArray<{ item: string; totalCost: number }>) {
  return items.map((l) => ({ item: l.item, unit: "LS", quantity: 1, unitCost: l.totalCost, totalCost: l.totalCost }));
}

export const seedProcurementScenario = internalMutation({
  args: { suffix: v.string() },
  handler: async (ctx, args) => {
    if (!SUFFIX.test(args.suffix)) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "suffix must be 1-24 letters, digits or hyphens." });
    }
    const title = scenarioProjectTitle(args.suffix);
    const sub1 = await sub1Account(ctx);
    const contractor = await ctx.db.get(sub1.contractorId);
    if (contractor === null) throw new ConvexError({ code: "DEMO_NOT_SEEDED", message: "sub1's contractor record is missing." });

    const projects = await ctx.db.query("projects").order("desc").take(500);
    const existing = projects.find((p) => p.title === title);
    if (existing) {
      const pkg = await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", existing._id))
        .first();
      const bids = pkg
        ? await ctx.db.query("bids").withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id)).take(10)
        : [];
      return {
        created: false,
        projectId: existing._id,
        projectTitle: title,
        tradePackageId: pkg?._id ?? null,
        sub1ContractorId: sub1.contractorId,
        sub1BidId: bids.find((b) => b.contractorId === sub1.contractorId)?._id ?? null,
        competingBidId: bids.find((b) => b.contractorId !== sub1.contractorId)?._id ?? null,
      };
    }

    const now = Date.now();
    const scope =
      "Div 26 power distribution, branch wiring, lighting and closeout. Seismic bracing is listed as an exclusion in the leveled bid.";
    const projectId = await ctx.db.insert("projects", {
      title,
      location: "Austin, TX",
      projectType: "Procurement scenario (test data)",
      estBudget: SCENARIO_COMPETING_LEVELED,
      targetCompletionWeeks: 40,
      specDocumentText: "Scenario project. Div 26 electrical subcontract including seismic bracing per IBC 1613.",
      isDemoProject: false,
      generalContractorName: "Austin Commercial, LP",
      createdAt: now,
    });
    const tradePackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      budgetEstimate: SCENARIO_COMPETING_LEVELED,
      agentMailbox: "procurement-scenario@example.invalid",
      agentMailboxId: "procurement-scenario",
      scopeSummary: scope,
      mandatoryInclusions: ["Seismic bracing", "Temporary power", "Testing and commissioning"],
      bidDeadline: new Date(now).toISOString().slice(0, 10),
      status: "leveling",
      invitedContractorIds: [sub1.contractorId],
    });
    const competingContractorId = await ctx.db.insert("contractors", {
      tradePackageId,
      companyName: SCENARIO_COMPETING_NAME,
      contactEmail: "estimating@cupertino-scenario.example.invalid",
      licenseNumber: "Scenario data (not verified)",
      licenseStatus: "Unverified - verify before execution",
      sourceUrl: "https://example.invalid/procurement-scenario",
      rfqStatus: "bid_received",
    });
    await attachBidderVendor(ctx, competingContractorId);
    const bidBase = {
      tradePackageId,
      valueEngineeringAlternates: [],
      leadTimePenalty: 0,
      leadTimeTargetWeeks: 12,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      isAwarded: false,
      revisionNumber: 1,
      receivedAt: now,
    };
    const sub1BidId = await ctx.db.insert("bids", {
      ...bidBase,
      contractorId: sub1.contractorId,
      subcontractorName: contractor.companyName,
      baseBidAmount: sum(SCENARIO_SUB1_LINE_ITEMS),
      lineItems: lineItems(SCENARIO_SUB1_LINE_ITEMS),
      identifiedExclusions: [{ ...SCENARIO_SUB1_EXCLUSION }],
      longLeadEquipmentWeeks: 8,
      leveledTotalCost: SCENARIO_SUB1_LEVELED,
    });
    const competingBidId = await ctx.db.insert("bids", {
      ...bidBase,
      contractorId: competingContractorId,
      subcontractorName: SCENARIO_COMPETING_NAME,
      baseBidAmount: sum(SCENARIO_COMPETING_LINE_ITEMS),
      lineItems: lineItems(SCENARIO_COMPETING_LINE_ITEMS),
      identifiedExclusions: [{ ...SCENARIO_COMPETING_EXCLUSION }],
      longLeadEquipmentWeeks: 10,
      leveledTotalCost: SCENARIO_COMPETING_LEVELED,
    });
    await ctx.db.insert("auditLogs", {
      projectId,
      tradePackageId,
      eventType: "bid_leveled",
      title: `Procurement scenario seeded: ${args.suffix}`,
      description: `Two leveled Div 26 bids: ${contractor.companyName} $${SCENARIO_SUB1_LEVELED.toLocaleString("en-US")} (seismic bracing excluded) and ${SCENARIO_COMPETING_NAME} $${SCENARIO_COMPETING_LEVELED.toLocaleString("en-US")}. Nothing awarded.`,
      actor: "Procurement scenario fixture",
      timestamp: now,
    });
    await attachProjectToDemo(ctx, projectId);
    return {
      created: true,
      projectId,
      projectTitle: title,
      tradePackageId,
      sub1ContractorId: sub1.contractorId,
      sub1BidId,
      competingBidId,
    };
  },
});
