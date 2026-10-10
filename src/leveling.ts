import { Agreement, Bid, TradePackage } from "./types.ts";
import { LEAD_TIME_PENALTY_PER_WEEK, targetWeeksForDivision } from "../convex/terms.ts";
import { centsToDollarsForDisplay, formatCents, fromDollars } from "../convex/lib/money.ts";

/**
 * A6-05r/A6-54: the schedule penalty is computed from the persisted weeks and the
 * GC-owned baseline (12 weeks Div 26 / 16 weeks Div 22-23). Older records without a
 * persisted target fall back to the package division so the arithmetic shown in the
 * UI always matches the number the engine produced.
 */
export function leadTargetWeeksFor(
  bid: Pick<Bid, "leadTimeTargetWeeks">,
  csiDivision?: string
): number {
  return bid.leadTimeTargetWeeks ?? targetWeeksForDivision(csiDivision);
}

export function leadPenaltyArithmetic(
  bid: Pick<Bid, "longLeadEquipmentWeeks" | "leadTimePenaltyCents" | "leadTimeTargetWeeks">,
  csiDivision?: string
): string {
  const target = leadTargetWeeksFor(bid, csiDivision);
  if ((bid.leadTimePenaltyCents ?? 0) <= 0) return `within ${target}-wk baseline`;
  return `(${bid.longLeadEquipmentWeeks} − ${target}) × ${wholeDollars(fromDollars(LEAD_TIME_PENALTY_PER_WEEK))} = +${wholeDollars(bid.leadTimePenaltyCents)}`;
}

/** "$6,000" for whole-dollar amounts, otherwise "$6,000.50". */
function wholeDollars(cents: number): string {
  const formatted = formatCents(cents);
  return formatted.endsWith(".00") ? formatted.slice(0, -3) : formatted;
}

/** ADR-0003 leveled total in cents (comparison only). */
export function calculateLeveledCostCents(
  bid: Pick<Bid, "baseAmountCents" | "identifiedExclusions" | "valueEngineeringAlternates" | "leadTimePenaltyCents" | "coiPenaltyCents">
): number {
  const b = getNormalizationBreakdown(bid);
  return Math.max(0, (bid.baseAmountCents ?? 0) + b.totalUpliftCents);
}

export function getDeceptiveBidIds(bids: Bid[]): Set<string> {
  const lowestLeveledBid = bids.reduce<Bid | null>(
    (lowest, bid) => (!lowest || bid.leveledTotalCents < lowest.leveledTotalCents ? bid : lowest),
    null
  );

  if (!lowestLeveledBid) return new Set<string>();

  return new Set(
    bids
      .filter(
        (bid) =>
          bid._id !== lowestLeveledBid._id &&
          bid.baseAmountCents < lowestLeveledBid.baseAmountCents &&
          bid.leveledTotalCents > lowestLeveledBid.leveledTotalCents
      )
      .map((bid) => bid._id)
  );
}

/** One bid's ADR-0003 normalization components, in integer cents. */
export interface NormalizationBreakdown {
  exclusionsCents: number;
  leadPenaltyCents: number;
  coiPenaltyCents: number;
  veAcceptedCents: number;
  totalUpliftCents: number;
}

/**
 * Single source of truth for one bid's ADR-0003 normalization components.
 * `totalUpliftCents` is the hidden cost the leveling engine added on top of the base bid
 * (exclusions + lead-time + COI penalties − accepted VE credits).
 */
export function getNormalizationBreakdown(
  bid: Pick<Bid, "identifiedExclusions" | "valueEngineeringAlternates" | "leadTimePenaltyCents" | "coiPenaltyCents">
): NormalizationBreakdown {
  const exclusionsCents = (bid.identifiedExclusions || []).reduce(
    (sum, exclusion) => (exclusion.isWaived ? sum : sum + Math.max(0, exclusion.costImpactCents ?? 0)),
    0
  );
  const veAcceptedCents = (bid.valueEngineeringAlternates || []).reduce(
    (sum, alternate) => (alternate.isAccepted ? sum + Math.max(0, alternate.costDeductCents ?? 0) : sum),
    0
  );
  const leadPenaltyCents = bid.leadTimePenaltyCents ?? 0;
  const coiPenaltyCents = bid.coiPenaltyCents ?? 0;
  return {
    exclusionsCents,
    leadPenaltyCents,
    coiPenaltyCents,
    veAcceptedCents,
    totalUpliftCents: exclusionsCents + leadPenaltyCents + coiPenaltyCents - veAcceptedCents,
  };
}

/** Awarded bid wins; otherwise the lowest leveled bid. */
export function getEffectiveBid(bids: Bid[]): Bid | null {
  if (!bids || bids.length === 0) return null;
  const awarded = bids.find((bid) => bid.isAwarded);
  if (awarded) return awarded;
  return [...bids].sort((a, b) => a.leveledTotalCents - b.leveledTotalCents)[0];
}

/**
 * Bids whose leveled cost is less than half of the package budget are almost
 * always scope omissions, unit errors or a mis-read document. They are flagged
 * for verification rather than blocked, so a GC cannot award one by accident.
 * The package budget is a planning estimate in dollars.
 */
export function getSuspiciouslyLowBidIds(bids: Bid[], packageBudget: number): Set<string> {
  if (!Number.isFinite(packageBudget) || packageBudget <= 0) return new Set<string>();
  const thresholdCents = fromDollars(packageBudget) / 2;
  return new Set(
    bids.filter((bid) => bid.leveledTotalCents > 0 && bid.leveledTotalCents < thresholdCents).map((bid) => bid._id)
  );
}

export interface ProcurementMetrics {
  totalBudget: number;
  totalLeveledBuyout: number;
  packagesWithBids: number;
  packagesUsingBudget: number;
  variance: number;
  variancePercent: number;
  isSavings: boolean;
  /** What the leveled total is actually made of, so labels can tell the truth. */
  leveledBasis: "bids" | "mixed" | "budget" | "empty";
  /** Full caption for card surfaces. */
  leveledBuyoutCaption: string;
  /** Compact caption for the always-visible KPI strip. */
  leveledBuyoutShort: string;
  /** True only when every package has a real leveled bid (no budget fallbacks). */
  varianceIsLeveled: boolean;
  deceptiveBidIds: string[];
  deceptiveBidsCount: number;
  gapsCaught: number;
  awardedPackages: number;
  totalPackages: number;
  buyoutProgressPercent: number;
}

/**
 * Computed once per project and read by every surface (KPI bar, header stepper,
 * demo tour, contracts register) so headline numbers can never disagree.
 */
export function computeProcurementMetrics(
  project: { estBudget?: number } | null | undefined,
  tradePackages: TradePackage[],
  allBids: Bid[],
  agreements: Agreement[] = []
): ProcurementMetrics {
  const totalBudget = project?.estBudget || 0;
  // Summed in cents; the dollar figures below are for display (budgets are dollar estimates).
  let totalLeveledBuyoutCents = 0;
  let packagesWithBids = 0;
  let packagesUsingBudget = 0;
  const deceptiveBidIds = new Set<string>();
  let gapsCaughtCents = 0;

  for (const pkg of tradePackages) {
    const pkgBids = allBids.filter((bid) => bid.tradePackageId === pkg._id);
    if (pkgBids.length === 0) {
      totalLeveledBuyoutCents += pkg.budgetEstimate > 0 ? fromDollars(pkg.budgetEstimate) : 0;
      packagesUsingBudget += 1;
      continue;
    }
    packagesWithBids += 1;
    for (const bidId of getDeceptiveBidIds(pkgBids)) deceptiveBidIds.add(bidId);
    const effectiveBid = getEffectiveBid(pkgBids);
    if (effectiveBid) {
      totalLeveledBuyoutCents += effectiveBid.leveledTotalCents;
    }
  }

  // "Gaps caught" is the hidden cost exposed on flagged deceptive bids only,
  // so it reconciles with the highlighted bid card and the audit narrative.
  for (const bidId of deceptiveBidIds) {
    const bid = allBids.find((b) => b._id === bidId);
    if (bid) gapsCaughtCents += getNormalizationBreakdown(bid).totalUpliftCents;
  }
  let totalLeveledBuyout = centsToDollarsForDisplay(totalLeveledBuyoutCents);
  const gapsCaught = centsToDollarsForDisplay(gapsCaughtCents);

  if (allBids.length === 0 && tradePackages.length === 0) {
    totalLeveledBuyout = totalBudget;
  }

  const variance = totalBudget - totalLeveledBuyout;
  const variancePercent = totalBudget > 0 ? (variance / totalBudget) * 100 : 0;

  // Basis of the leveled total. Claiming "best bid per package" while any package
  // is standing on its budget estimate is a false procurement signal (F2).
  const leveledBasis: ProcurementMetrics["leveledBasis"] =
    tradePackages.length === 0
      ? "empty"
      : packagesUsingBudget === 0
      ? "bids"
      : packagesWithBids === 0
      ? "budget"
      : "mixed";

  const pkgWord = (n: number) => `${n} package${n === 1 ? "" : "s"}`;
  const leveledBuyoutCaption =
    leveledBasis === "bids"
      ? "Best leveled bid per package"
      : leveledBasis === "mixed"
      ? `Best leveled bid where available; ${packagesUsingBudget} of ${tradePackages.length} packages still on budget estimates`
      : leveledBasis === "budget"
      ? `Budget estimates only — no bids received yet (${pkgWord(packagesUsingBudget)} pending)`
      : "Project budget — no trade packages scoped yet";

  const leveledBuyoutShort =
    leveledBasis === "bids"
      ? "best bid per package"
      : leveledBasis === "mixed"
      ? `${packagesUsingBudget}/${tradePackages.length} pkgs on budget estimates`
      : leveledBasis === "budget"
      ? "budget estimates only"
      : "project budget";

  const varianceIsLeveled = leveledBasis === "bids";

  // Award source of truth: a non-superseded subcontract agreement exists,
  // or a bid is explicitly awarded, or the package status says awarded.
  const awardedPkgIds = new Set<string>();
  for (const agreement of agreements) {
    if (agreement.status !== "superseded") awardedPkgIds.add(agreement.tradePackageId);
  }
  for (const bid of allBids) {
    if (bid.isAwarded) awardedPkgIds.add(bid.tradePackageId);
  }
  for (const pkg of tradePackages) {
    if (pkg.status === "awarded") awardedPkgIds.add(pkg._id);
  }
  const awardedPackages = tradePackages.filter((pkg) => awardedPkgIds.has(pkg._id)).length;
  const totalPackages = tradePackages.length;

  return {
    totalBudget,
    totalLeveledBuyout,
    packagesWithBids,
    packagesUsingBudget,
    variance,
    variancePercent,
    isSavings: variance >= 0,
    leveledBasis,
    leveledBuyoutCaption,
    leveledBuyoutShort,
    varianceIsLeveled,
    deceptiveBidIds: [...deceptiveBidIds],
    deceptiveBidsCount: [...deceptiveBidIds].reduce(
      (count, bidId) => count + allBids.filter((bid) => bid._id === bidId).length,
      0
    ),
    gapsCaught,
    awardedPackages,
    totalPackages,
    buyoutProgressPercent: totalPackages > 0 ? (awardedPackages / totalPackages) * 100 : 0,
  };
}