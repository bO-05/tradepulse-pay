/**
 * Demo fixture for the AI pay-app review: an executed Div 26 agreement for the
 * sub1 demo contractor whose leveled bid excludes seismic bracing, with
 * Mobilization complete and Rough-in under way (milestones support 30% on base
 * lines). The main demo agreement has no excluded scope and is past those
 * milestones, so it cannot show the overbilled/excluded scenarios.
 *
 *   npx convex run payApps/reviewScenario:seedReviewScenario '{}'
 *   npx convex run payApps/reviewScenario:seedReviewScenario '{"suffix":"02"}'
 *   npx convex run payApps/reviewScenario:seedReviewScenario '{"suffix":"TDI01","contractor":"tdindustries"}'
 *
 * A suffix seeds a separate agreement (A401-DEMO-PAYREVIEW-<suffix>) so a
 * scenario can start from no prior billing. `contractor: "tdindustries"` seeds the same
 * agreement for sub2's contractor, whose CSLB license is expired.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { findDemoContractorId } from "../demoAccounts";
import { attachProjectToDemo } from "../lib/demoTenancy";
import { ensureSovAndMilestones } from "../payments/sov";
import { DEMO_SOV_APPROVER } from "../lib/demoBilling";
import { RETAINAGE_PERCENT } from "../terms";
import { seededProposalBidRow } from "../lib/bidMoney";
import { fromDollars } from "../lib/money";

export const REVIEW_SCENARIO_AGREEMENT_NUMBER = "A401-DEMO-PAYREVIEW-01";
const AGREEMENT_PREFIX = "A401-DEMO-PAYREVIEW-";
const SUFFIX_PATTERN = /^[0-9A-Z]{1,8}$/;
const CONTRACTORS = {
  rosendin: "Rosendin Electric, Inc.",
  // CSLB #512239 is expired, so this agreement exercises the license hold on payouts.
  tdindustries: "TDIndustries, Inc.",
} as const;

const LINE_ITEMS = [
  { item: "1600A main switchboard & transformers", totalCost: 340_000 },
  { item: "Branch conduit & wire feeder runs", totalCost: 300_000 },
  { item: "Grounding & bonding system", totalCost: 160_000 },
  { item: "Closeout: testing, commissioning & O&M manuals", totalCost: 50_000 },
];
const SEISMIC_EXCLUSION = {
  canonicalCode: "CSI_26_SEISMIC",
  description: "IBC Section 1613 engineered seismic bracing (excluded by the sub; by others)",
  costImpact: 55_000,
  severity: "critical",
  isWaived: false,
};

export const seedReviewScenario = internalMutation({
  args: { suffix: v.optional(v.string()), contractor: v.optional(v.union(v.literal("rosendin"), v.literal("tdindustries"))) },
  handler: async (ctx, args) => {
    const contractorName = CONTRACTORS[args.contractor ?? "rosendin"];
    const suffix = (args.suffix ?? "01").trim().toUpperCase();
    if (!SUFFIX_PATTERN.test(suffix)) throw new ConvexError("suffix must be 1-8 letters or digits.");
    const agreementNumber = `${AGREEMENT_PREFIX}${suffix}`;
    const existing = await ctx.db
      .query("agreements")
      .filter((q) => q.eq(q.field("agreementNumber"), agreementNumber))
      .first();
    if (existing) return { agreementId: existing._id, agreementNumber, created: false };

    const contractorId = await findDemoContractorId(ctx, contractorName);
    if (!contractorId) throw new ConvexError(`Demo contractor ${contractorName} not found; run demoAccounts:seedDemo first.`);
    const now = Date.now();
    const baseBid = LINE_ITEMS.reduce((a, l) => a + l.totalCost, 0);
    // The seismic plug is comparison-only: it sits in the leveled total, never in the contract sum.
    const leveledTotal = baseBid + SEISMIC_EXCLUSION.costImpact;
    const contractSum = baseBid;

    const projectId = await ctx.db.insert("projects", {
      title: "Demo · Pay-app review scenario",
      location: "Austin, TX",
      projectType: "Demo data for the AI pay-app review",
      estBudget: contractSum,
      targetCompletionWeeks: 40,
      specDocumentText: "Demo project. Div 26 electrical; seismic bracing excluded from the electrical subcontract.",
      isDemoProject: false,
      generalContractorName: "Austin Commercial, LP",
      createdAt: now,
    });
    const tradePackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      budgetEstimate: contractSum,
      agentMailbox: "demo-payreview@example.invalid",
      agentMailboxId: "demo-payreview",
      scopeSummary: "Div 26 distribution, feeders, grounding and closeout. Seismic bracing excluded.",
      mandatoryInclusions: ["Temporary power", "Testing and commissioning"],
      bidDeadline: "2026-09-30",
      status: "awarded",
    });
    const bidId = await ctx.db.insert("bids", seededProposalBidRow({
      tradePackageId,
      contractorId,
      subcontractorName: contractorName,
      baseBidAmount: baseBid,
      lineItems: LINE_ITEMS.map((l) => ({ item: l.item, unit: "LS", quantity: 1, unitCost: l.totalCost, totalCost: l.totalCost })),
      identifiedExclusions: [SEISMIC_EXCLUSION],
      valueEngineeringAlternates: [],
      longLeadEquipmentWeeks: 8,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: leveledTotal,
      isAwarded: true,
      receivedAt: now,
    }));
    const agreementId = await ctx.db.insert("agreements", {
      projectId,
      tradePackageId,
      bidId,
      contractorId,
      agreementNumber,
      documentTitle: "Subcontract agreement (demo data)",
      subcontractorName: contractorName,
      generalContractorName: "Austin Commercial, LP",
      projectTitle: "Demo · Pay-app review scenario",
      projectLocation: "Austin, TX",
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      contractSum,
      contractSumCents: fromDollars(contractSum),
      baseBidCents: fromDollars(baseBid),
      acceptedAlternates: [],
      declinedAlternates: [],
      veDeducts: [],
      excludedScopeNotes: [SEISMIC_EXCLUSION.description],
      retainagePercent: RETAINAGE_PERCENT,
      liquidatedDamagesDaily: 0,
      scopeSummary: "Div 26 distribution, feeders, grounding and closeout. Seismic bracing is excluded scope (by others).",
      mandatoryInclusions: ["Temporary power", "Testing and commissioning"],
      status: "executed",
      contractText: "Demo subcontract for the AI pay-app review scenario. Not a real contract.",
      sov: { status: "approved", approvedAt: now, approvedByName: DEMO_SOV_APPROVER },
      executedAt: now,
      createdAt: now,
    });
    await ensureSovAndMilestones(ctx, agreementId);
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
      .take(10);
    for (const m of milestones) {
      if (m.order === 1) await ctx.db.patch(m._id, { status: "complete" });
      if (m.order === 2) await ctx.db.patch(m._id, { status: "in_progress" });
    }
    await ctx.db.insert("auditLogs", {
      projectId,
      agreementId,
      eventType: "compliance_audit",
      title: "Demo pay-app review scenario seeded",
      description: `${agreementNumber}: demo agreement with excluded seismic bracing; Mobilization complete, Rough-in in progress.`,
      actor: "TradePulse Pay (demo seed)",
      timestamp: now,
    });
    await attachProjectToDemo(ctx, projectId);
    return { agreementId, agreementNumber, created: true };
  },
});

export const describeReviewScenario = internalQuery({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, args) => {
    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", args.agreementId))
      .take(50);
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", args.agreementId))
      .take(10);
    return {
      sov: sov.map((s) => ({ id: s._id, lineNo: s.lineNo, description: s.description, excludedScope: s.excludedScope, scheduledValueCents: s.scheduledValueCents })),
      milestones: milestones.map((m) => ({ name: m.name, status: m.status, amountCents: m.amountCents })),
    };
  },
});
