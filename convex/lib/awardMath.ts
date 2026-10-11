import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { centsToDollarsForDisplay, formatCents } from "./money";

/**
 * Award contract sum (§15): selected bid base + accepted bid alternates − accepted value-engineering
 * deducts. Leveling plugs, lead-time and COI penalties are comparison-only and never enter it.
 * Pure TS, integer cents.
 */

export type AwardAlternate = { description: string; amountCents: number };

export type AwardSum = {
  baseBidCents: number;
  acceptedAlternates: AwardAlternate[];
  declinedAlternates: AwardAlternate[];
  /** Value-engineering deducts the GC accepted while leveling (positive cents, subtracted). */
  veDeducts: AwardAlternate[];
  contractSumCents: number;
};

/** The bid fields the award reads; the stored bid doc and the client `Bid` both satisfy it. */
export type BidForAward = {
  baseAmountCents?: number;
  alternates?: readonly { description: string; amountCents: number }[];
  valueEngineeringAlternates?: readonly { description: string; costDeductCents?: number; isAccepted?: boolean }[];
};

function cents(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** Accepted value-engineering deducts as listed on the agreement (positive cents, subtracted). */
export function acceptedVeDeducts(bid: Pick<BidForAward, "valueEngineeringAlternates">): AwardAlternate[] {
  return (bid.valueEngineeringAlternates ?? [])
    .filter((a) => a.isAccepted && cents(a.costDeductCents) > 0)
    .map((a) => ({ description: a.description, amountCents: cents(a.costDeductCents) }));
}

/**
 * The award as a confirmation dialog shows it, without throwing for a non-positive sum, so the
 * dialog can explain why the award would be refused. Same math as `computeAwardSum`.
 */
export function previewAwardSum(
  bid: BidForAward,
  acceptedAlternateIndexes: readonly number[],
): { sum: AwardSum; error: string | null } {
  try {
    return { sum: computeAwardSum(bid, acceptedAlternateIndexes), error: null };
  } catch (err) {
    const data = (err as { data?: { message?: string } }).data;
    return {
      sum: awardSumParts(bid, acceptedAlternateIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < (bid.alternates ?? []).length)),
      error: data?.message ?? (err as Error).message,
    };
  }
}

function awardSumParts(bid: BidForAward, accepted: readonly number[]): AwardSum {
  const acceptedSet = new Set(accepted);
  const baseBidCents = cents(bid.baseAmountCents);
  const acceptedAlternates: AwardAlternate[] = [];
  const declinedAlternates: AwardAlternate[] = [];
  (bid.alternates ?? []).forEach((a, i) => {
    const row = { description: a.description, amountCents: cents(a.amountCents) };
    (acceptedSet.has(i) ? acceptedAlternates : declinedAlternates).push(row);
  });
  const veDeducts = acceptedVeDeducts(bid);
  const contractSumCents =
    baseBidCents +
    acceptedAlternates.reduce((s, a) => s + a.amountCents, 0) -
    veDeducts.reduce((s, a) => s + a.amountCents, 0);
  return { baseBidCents, acceptedAlternates, declinedAlternates, veDeducts, contractSumCents };
}

export function computeAwardSum(bid: BidForAward, acceptedAlternateIndexes: readonly number[]): AwardSum {
  const alternates = bid.alternates ?? [];
  const accepted = new Set<number>();
  for (const i of acceptedAlternateIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= alternates.length) {
      throw new ConvexError({ code: "INVALID", message: "Select alternates from this bid only." });
    }
    accepted.add(i);
  }
  const sum = awardSumParts(bid, [...accepted]);
  const { contractSumCents } = sum;
  if (contractSumCents <= 0) {
    throw new ConvexError({
      code: "INVALID",
      message: `The contract sum would be ${formatCents(contractSumCents)}. Accepted deducts cannot reduce the sum to zero or below.`,
    });
  }
  return sum;
}

/** Indexes of the bid's current alternates that match previously accepted ones (by description). */
export function acceptedIndexesFor(bid: BidForAward, previouslyAccepted: readonly AwardAlternate[] | undefined): number[] {
  const wanted = new Set((previouslyAccepted ?? []).map((a) => a.description.trim().toLowerCase()));
  return (bid.alternates ?? []).flatMap((a, i) => (wanted.has(a.description.trim().toLowerCase()) ? [i] : []));
}

/**
 * Bid exclusions carried to the agreement as notes (never SOV lines), de-duplicated in order. The
 * single source for agreement notes, the subcontract text and the pay-app review context: the
 * bidder's stated exclusions (`exclusions`) followed by every leveling exclusion
 * (`identifiedExclusions`), which includes those the GC added while leveling. Waived exclusions stay
 * listed because waiving only removes the plug from the comparison; the scope is still excluded.
 */
export function excludedScopeNotesFor(bid: Pick<Doc<"bids">, "exclusions" | "identifiedExclusions">): string[] {
  const source = [...(bid.exclusions ?? []), ...(bid.identifiedExclusions ?? []).map((e) => e.description)];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const raw of source) {
    const note = raw.trim();
    const key = note.toLowerCase();
    if (!note || seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }
  return notes;
}

/** Agreement fields derived from an award. `contractSum` is the legacy dollar mirror. */
export function agreementAwardFields(sum: AwardSum, excludedScopeNotes: string[]) {
  return {
    contractSum: centsToDollarsForDisplay(sum.contractSumCents),
    contractSumCents: sum.contractSumCents,
    baseBidCents: sum.baseBidCents,
    acceptedAlternates: sum.acceptedAlternates,
    declinedAlternates: sum.declinedAlternates,
    veDeducts: sum.veDeducts,
    excludedScopeNotes,
  };
}
