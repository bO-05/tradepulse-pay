import type { Doc } from "../_generated/dataModel";
import { acceptedVeDeducts } from "./awardMath";
import { acceptedVeDeductCents, bidCents, computeLeveledTotalCents, exclusionPlugCents } from "./bidMoney";

/**
 * GC leveling view of one package (§15). The apparent low is the lowest base bid; the leveled low
 * is the lowest leveled total (base + plugs + penalties − accepted VE), which is for comparison only.
 */

export type LevelingStatus = "awarded" | "not_awarded" | "under_review";

export type LevelingPlug = {
  index: number;
  description: string;
  amountCents: number;
  waived: boolean;
  note: string | null;
  enteredByName: string | null;
  enteredAt: number | null;
};

export type LevelingRow = {
  bidId: Doc<"bids">["_id"];
  contractorId: Doc<"bids">["contractorId"];
  subcontractorName: string;
  baseAmountCents: number;
  exclusions: LevelingPlug[];
  plugTotalCents: number;
  leadTimePenaltyCents: number;
  coiPenaltyCents: number;
  veDeductCents: number;
  /** Accepted VE deducts, listed the way the award and the agreement list them. */
  veDeducts: { description: string; amountCents: number }[];
  leveledTotalCents: number;
  alternates: { description: string; amountCents: number }[];
  isApparentLow: boolean;
  isLeveledLow: boolean;
  status: LevelingStatus;
  revisionNumber: number;
  receivedAt: number;
};

export function buildLevelingRows(pkg: Pick<Doc<"tradePackages">, "status">, bids: readonly Doc<"bids">[]): LevelingRow[] {
  const packageAwarded = pkg.status === "awarded" || bids.some((b) => b.isAwarded);
  const rows = bids.map((bid): Omit<LevelingRow, "isApparentLow" | "isLeveledLow"> => {
    const c = bidCents(bid);
    const exclusions = bid.identifiedExclusions.map((e, index) => ({
      index,
      description: e.description,
      amountCents: exclusionPlugCents({ costImpactCents: e.costImpactCents }),
      waived: e.isWaived === true,
      note: e.plugNote ?? null,
      enteredByName: e.plugEnteredByName ?? null,
      enteredAt: e.plugEnteredAt ?? null,
    }));
    const plugTotalCents = bid.identifiedExclusions.reduce((s, e) => s + exclusionPlugCents(e), 0);
    const veAlternates = bid.valueEngineeringAlternates ?? [];
    return {
      bidId: bid._id,
      contractorId: bid.contractorId,
      subcontractorName: bid.subcontractorName,
      baseAmountCents: c.baseAmountCents,
      exclusions,
      plugTotalCents,
      leadTimePenaltyCents: c.leadTimePenaltyCents,
      coiPenaltyCents: c.coiPenaltyCents,
      veDeductCents: acceptedVeDeductCents(veAlternates),
      veDeducts: acceptedVeDeducts(bid),
      // Recomputed rather than read so the view always matches its own components.
      leveledTotalCents: computeLeveledTotalCents({
        baseAmountCents: c.baseAmountCents,
        exclusions: bid.identifiedExclusions,
        veAlternates,
        leadTimePenaltyCents: c.leadTimePenaltyCents,
        coiPenaltyCents: c.coiPenaltyCents,
      }),
      alternates: (bid.alternates ?? []).map((a) => ({ description: a.description, amountCents: a.amountCents })),
      status: bid.isAwarded ? "awarded" : packageAwarded ? "not_awarded" : "under_review",
      revisionNumber: bid.revisionNumber ?? 1,
      receivedAt: bid.receivedAt,
    };
  });
  const lowest = (key: "baseAmountCents" | "leveledTotalCents") =>
    rows.reduce<(typeof rows)[number] | null>(
      (min, r) => (!min || r[key] < min[key] || (r[key] === min[key] && r.receivedAt < min.receivedAt) ? r : min),
      null,
    )?.bidId ?? null;
  const apparentLowId = lowest("baseAmountCents");
  const leveledLowId = lowest("leveledTotalCents");
  return rows
    .map((r) => ({ ...r, isApparentLow: r.bidId === apparentLowId, isLeveledLow: r.bidId === leveledLowId }))
    .sort((a, b) => a.leveledTotalCents - b.leveledTotalCents || a.receivedAt - b.receivedAt);
}
