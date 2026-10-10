import { expect, test } from "vitest";
import {
  computeProcurementMetrics,
  getNormalizationBreakdown,
  getSuspiciouslyLowBidIds,
  leadPenaltyArithmetic,
  leadTargetWeeksFor,
} from "./leveling.ts";
import { LEAD_TIME_PENALTY_PER_WEEK, leadTimePenaltyFor, targetWeeksForDivision } from "../convex/terms.ts";
import type { Agreement, Bid, TradePackage } from "./types.ts";

const pkg = (id: string, budget: number, status: TradePackage["status"] = "leveling"): TradePackage => ({
  _id: id,
  projectId: "p1",
  csiDivision: "26 00 00",
  tradeName: "Trade",
  budgetEstimate: budget,
  agentMailbox: "x@agentmail.to",
  agentMailboxId: "i1",
  scopeSummary: "",
  mandatoryInclusions: [],
  bidDeadline: "2026-10-31",
  status,
});

const bid = (over: Partial<Bid> & { _id: string; tradePackageId: string; leveledTotalCents: number }): Bid => ({
  contractorId: "c1",
  subcontractorName: "Sub",
  baseAmountCents: over.leveledTotalCents,
  lineItems: [],
  identifiedExclusions: [],
  longLeadEquipmentWeeks: 10,
  leadTimePenaltyCents: 0,
  coiComplianceStatus: "compliant",
  coiPenaltyCents: 0,
  isAwarded: false,
  receivedAt: 0,
  ...over,
});

const agreement = (tradePackageId: string, status: Agreement["status"]): Agreement => ({
  _id: `a-${tradePackageId}`,
  projectId: "p1",
  tradePackageId,
  bidId: "b1",
  contractorId: "c1",
  agreementNumber: "A401-1",
  documentTitle: "AIA A401",
  subcontractorName: "Sub",
  generalContractorName: "GC",
  projectTitle: "P",
  projectLocation: "Austin, TX",
  csiDivision: "26 00 00",
  tradeName: "Trade",
  contractSum: 1_000_000,
  retainagePercent: 10,
  liquidatedDamagesDaily: 1200,
  scopeSummary: "",
  mandatoryInclusions: [],
  status,
  contractText: "",
  createdAt: 0,
});

test("Headline numbers reconcile with the seeded demo data set", () => {
  const packages = [pkg("p26", 1_250_000), pkg("p23", 1_850_000), pkg("p22", 950_000)];
  const bids: Bid[] = [
    bid({ _id: "b1", tradePackageId: "p26", subcontractorName: "Rosendin Electric, Inc.", baseAmountCents: 122_500_000, leveledTotalCents: 122_500_000 }),
    bid({
      _id: "b2",
      tradePackageId: "p26",
      subcontractorName: "Alterman, Inc.",
      baseAmountCents: 110_000_000,
      leveledTotalCents: 128_600_000,
      identifiedExclusions: [
        { description: "Crane hoisting", costImpactCents: 4_500_000, severity: "critical" },
        { description: "Firestop", costImpactCents: 2_200_000, severity: "critical" },
        { description: "Seismic", costImpactCents: 5_500_000, severity: "critical" },
        { description: "Overtime", costImpactCents: 2_500_000, severity: "moderate" },
      ],
      leadTimePenaltyCents: 2_400_000,
      coiPenaltyCents: 1_500_000,
      coiComplianceStatus: "deficiency_detected",
      longLeadEquipmentWeeks: 16,
    }),
    bid({ _id: "b3", tradePackageId: "p23", subcontractorName: "TDIndustries, Inc.", leveledTotalCents: 182_000_000 }),
    bid({
      _id: "b4",
      tradePackageId: "p23",
      subcontractorName: "The Brandt Companies, LLC",
      baseAmountCents: 165_000_000,
      leveledTotalCents: 178_500_000,
      identifiedExclusions: [{ description: "Exclusions", costImpactCents: 10_800_000, severity: "critical" }],
      leadTimePenaltyCents: 1_200_000,
      coiPenaltyCents: 1_500_000,
      coiComplianceStatus: "deficiency_detected",
    }),
    bid({ _id: "b5", tradePackageId: "p22", subcontractorName: "Clarke Kent Plumbing", leveledTotalCents: 93_500_000 }),
    bid({
      _id: "b6",
      tradePackageId: "p22",
      subcontractorName: "Limbach Facility Services LLC",
      baseAmountCents: 82_000_000,
      leveledTotalCents: 90_850_000,
      identifiedExclusions: [{ description: "Exclusions", costImpactCents: 6_150_000, severity: "critical" }],
      leadTimePenaltyCents: 1_200_000,
      coiPenaltyCents: 1_500_000,
      coiComplianceStatus: "deficiency_detected",
    }),
  ];
  const agreements = [agreement("p26", "generated")];
  const metrics = computeProcurementMetrics({ estBudget: 4_250_000 }, packages, bids, agreements);

  expect(metrics.totalBudget).toBe(4_250_000);
  expect(metrics.totalLeveledBuyout).toBe(3_918_500);
  expect(metrics.variance).toBe(331_500);
  expect(metrics.deceptiveBidsCount).toBe(1);
  // "Hidden gaps exposed" reconciles with the flagged Alterman card components:
  // 147,000 exclusions + 24,000 lead + 15,000 COI = 186,000.
  expect(metrics.gapsCaught).toBe(186_000);
  expect(getNormalizationBreakdown(bids[1]).totalUpliftCents).toBe(18_600_000);
  // Award count comes from the agreement, so KPI and stepper cannot disagree.
  expect(metrics.awardedPackages).toBe(1);
  expect(metrics.totalPackages).toBe(3);
  // Every package has a real bid, so the leveled total is bid-based (F2).
  expect(metrics.leveledBasis).toBe("bids");
  expect(metrics.varianceIsLeveled).toBe(true);
  expect(metrics.leveledBuyoutCaption).toBe("Best leveled bid per package");
  expect(metrics.leveledBuyoutShort).toBe("best bid per package");
});

test("Superseded agreements do not count as awards", () => {
  const packages = [pkg("p26", 1_000_000, "leveling")];
  const bids = [bid({ _id: "b1", tradePackageId: "p26", leveledTotalCents: 90_000_000 })];
  const metrics = computeProcurementMetrics({ estBudget: 1_000_000 }, packages, bids, [agreement("p26", "superseded")]);
  expect(metrics.awardedPackages).toBe(0);
});

test("Packages without bids use their budget estimate and expose no gaps", () => {
  const packages = [pkg("p26", 1_000_000, "draft"), pkg("p23", 2_000_000, "draft")];
  const metrics = computeProcurementMetrics({ estBudget: 3_500_000 }, packages, [], []);
  expect(metrics.totalLeveledBuyout).toBe(3_000_000);
  expect(metrics.gapsCaught).toBe(0);
  expect(metrics.packagesUsingBudget).toBe(2);
  expect(metrics.awardedPackages).toBe(0);
  // F2: zero bids means the figure is a budget estimate, never a bid-based buyout.
  expect(metrics.leveledBasis).toBe("budget");
  expect(metrics.varianceIsLeveled).toBe(false);
  expect(metrics.leveledBuyoutCaption).toContain("Budget estimates only");
  expect(metrics.leveledBuyoutCaption).not.toContain("Best leveled bid");
  expect(metrics.leveledBuyoutShort).toBe("budget estimates only");
});

test("F2: a mixed portfolio reports the budget share and never claims all-bid variance", () => {
  const packages = [pkg("p26", 1_000_000, "leveling"), pkg("p23", 2_000_000, "draft")];
  const bids = [bid({ _id: "b1", tradePackageId: "p26", leveledTotalCents: 95_000_000 })];
  const metrics = computeProcurementMetrics({ estBudget: 3_500_000 }, packages, bids, []);
  expect(metrics.totalLeveledBuyout).toBe(2_950_000);
  expect(metrics.leveledBasis).toBe("mixed");
  expect(metrics.varianceIsLeveled).toBe(false);
  expect(metrics.leveledBuyoutShort).toBe("1/2 pkgs on budget estimates");
  expect(metrics.leveledBuyoutCaption).toContain("still on budget estimates");
});

test("Buyout equals budget when a project has no packages and no bids", () => {
  const metrics = computeProcurementMetrics({ estBudget: 5_500_000 }, [], [], []);
  expect(metrics.totalLeveledBuyout).toBe(5_500_000);
  expect(metrics.variance).toBe(0);
  expect(metrics.leveledBasis).toBe("empty");
  expect(metrics.varianceIsLeveled).toBe(false);
  expect(metrics.leveledBuyoutShort).toBe("project budget");
});

test("Out-of-band low bids are flagged below 50% of the package budget", () => {
  const packages = [pkg("p26", 1_250_000, "leveling")];
  const bids = [
    bid({ _id: "b1", tradePackageId: "p26", baseAmountCents: 122_500_000, leveledTotalCents: 122_500_000 }),
    bid({ _id: "b2", tradePackageId: "p26", baseAmountCents: 25_000_000, leveledTotalCents: 25_000_000 }),
  ];
  const flagged = getSuspiciouslyLowBidIds(bids, packages[0].budgetEstimate);
  expect(flagged.has("b2")).toBe(true);
  expect(flagged.has("b1")).toBe(false);
  // No budget or a zero budget cannot flag anything.
  expect(getSuspiciouslyLowBidIds(bids, 0).size).toBe(0);
});

// A6-05r/A6-54: the lead-time penalty is code-computed, deterministic, and priced
// against the GC-owned division baseline (12 wks Div 26, 16 wks Div 22/23).
test("Lead-time penalty follows the documented $6,000/week rate against the pinned helper", () => {
  expect(LEAD_TIME_PENALTY_PER_WEEK).toBe(6000);
  expect(leadTimePenaltyFor(17, 12)).toBe(30_000);
  expect(leadTimePenaltyFor(16, 16)).toBe(0);
  expect(leadTimePenaltyFor(20, 16)).toBe(24_000);
  expect(leadTimePenaltyFor(12, 12)).toBe(0);
  expect(leadTimePenaltyFor(8, 12)).toBe(0);
});

test("Division baselines are 12 weeks electrical and 16 weeks mechanical/plumbing", () => {
  expect(targetWeeksForDivision("26 00 00")).toBe(12);
  expect(targetWeeksForDivision("03 30 00")).toBe(12);
  expect(targetWeeksForDivision("22 11 23")).toBe(16);
  expect(targetWeeksForDivision("23 00 00")).toBe(16);
  expect(targetWeeksForDivision(undefined)).toBe(12);
  // Same input twice is always identical (pure function, no model arithmetic).
  expect(leadTimePenaltyFor(20, 16)).toBe(leadTimePenaltyFor(20, 16));
});

test("Bid cards use the persisted target, and older records fall back to the division baseline", () => {
  const persisted = bid({ _id: "b1", tradePackageId: "p22", leveledTotalCents: 100, longLeadEquipmentWeeks: 17, leadTimePenaltyCents: 600_000, leadTimeTargetWeeks: 16 });
  expect(leadTargetWeeksFor(persisted, "22 00 00")).toBe(16);
  const legacy = bid({ _id: "b2", tradePackageId: "p22", leveledTotalCents: 100, longLeadEquipmentWeeks: 17, leadTimePenaltyCents: 600_000 });
  expect(leadTargetWeeksFor(legacy, "22 00 00")).toBe(16);
  expect(leadTargetWeeksFor(legacy, "26 00 00")).toBe(12);
});

test("Lead-time arithmetic is rendered from the persisted numbers", () => {
  const div22 = bid({ _id: "b1", tradePackageId: "p22", leveledTotalCents: 100, longLeadEquipmentWeeks: 17, leadTimePenaltyCents: 600_000, leadTimeTargetWeeks: 16 });
  expect(leadPenaltyArithmetic(div22, "22 00 00")).toBe("(17 − 16) × $6,000 = +$6,000");
  const div26 = bid({ _id: "b2", tradePackageId: "p26", leveledTotalCents: 100, longLeadEquipmentWeeks: 16, leadTimePenaltyCents: 2_400_000, leadTimeTargetWeeks: 12 });
  expect(leadPenaltyArithmetic(div26, "26 00 00")).toBe("(16 − 12) × $6,000 = +$24,000");
  const onTrack = bid({ _id: "b3", tradePackageId: "p26", leveledTotalCents: 100, longLeadEquipmentWeeks: 16, leadTimePenaltyCents: 0, leadTimeTargetWeeks: 16 });
  expect(leadPenaltyArithmetic(onTrack, "23 00 00")).toBe("within 16-wk baseline");
});