import { previewAwardSum, type AwardAlternate, type BidForAward } from "../../convex/lib/awardMath";
import type { LevelingRow } from "../../convex/lib/levelingSummary";
import { formatCents } from "../ui/format";

export type AwardConfirmation = {
  contractSumCents: number;
  details: { label: string; value: string }[];
  /** Why the server would refuse this award (for example deducts that take the sum to $0.00), or null. */
  error: string | null;
};

const listed = (items: readonly AwardAlternate[], sign: "" | "−") =>
  items.map((a) => `${a.description} (${sign}${formatCents(a.amountCents)})`).join("; ");

/**
 * What every award confirmation shows: the contract sum from the shared award math
 * (convex/lib/awardMath.ts, the same computation generateAgreement stores) and the items in it.
 */
export function awardConfirmation(
  bid: BidForAward,
  acceptedAlternateIndexes: readonly number[],
  options: { noAlternatesNote?: string } = {},
): AwardConfirmation {
  const { sum, error } = previewAwardSum(bid, acceptedAlternateIndexes);
  const details = [
    { label: "Base bid", value: formatCents(sum.baseBidCents) },
    {
      label: "Accepted alternates",
      value: sum.acceptedAlternates.length > 0 ? listed(sum.acceptedAlternates, "") : (options.noAlternatesNote ?? "None"),
    },
    ...(sum.veDeducts.length > 0 ? [{ label: "Accepted VE deducts", value: listed(sum.veDeducts, "−") }] : []),
    { label: "Leveling plugs", value: "Not included" },
  ];
  return { contractSumCents: sum.contractSumCents, details, error };
}

/** The leveling row in the shape the award math reads. */
export function levelingRowAwardInput(row: Pick<LevelingRow, "baseAmountCents" | "alternates" | "veDeducts">): BidForAward {
  return {
    baseAmountCents: row.baseAmountCents,
    alternates: row.alternates,
    valueEngineeringAlternates: row.veDeducts.map((d) => ({ description: d.description, costDeductCents: d.amountCents, isAccepted: true })),
  };
}
