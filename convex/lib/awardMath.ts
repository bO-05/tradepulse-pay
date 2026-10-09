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

type BidForAward = Pick<Doc<"bids">, "baseAmountCents" | "alternates" | "valueEngineeringAlternates">;

function cents(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
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
  const baseBidCents = cents(bid.baseAmountCents);
  const acceptedAlternates: AwardAlternate[] = [];
  const declinedAlternates: AwardAlternate[] = [];
  alternates.forEach((a, i) => {
    const row = { description: a.description, amountCents: cents(a.amountCents) };
    (accepted.has(i) ? acceptedAlternates : declinedAlternates).push(row);
  });
  const veDeducts = (bid.valueEngineeringAlternates ?? [])
    .filter((a) => a.isAccepted && cents(a.costDeductCents) > 0)
    .map((a) => ({ description: a.description, amountCents: cents(a.costDeductCents) }));
  const contractSumCents =
    baseBidCents +
    acceptedAlternates.reduce((s, a) => s + a.amountCents, 0) -
    veDeducts.reduce((s, a) => s + a.amountCents, 0);
  if (contractSumCents <= 0) {
    throw new ConvexError({
      code: "INVALID",
      message: `The contract sum would be ${formatCents(contractSumCents)}. Accepted deducts cannot reduce the sum to zero or below.`,
    });
  }
  return { baseBidCents, acceptedAlternates, declinedAlternates, veDeducts, contractSumCents };
}

/** Indexes of the bid's current alternates that match previously accepted ones (by description). */
export function acceptedIndexesFor(bid: BidForAward, previouslyAccepted: readonly AwardAlternate[] | undefined): number[] {
  const wanted = new Set((previouslyAccepted ?? []).map((a) => a.description.trim().toLowerCase()));
  return (bid.alternates ?? []).flatMap((a, i) => (wanted.has(a.description.trim().toLowerCase()) ? [i] : []));
}

/** Bid exclusions carried to the agreement as notes (never SOV lines), de-duplicated in order. */
export function excludedScopeNotesFor(bid: Pick<Doc<"bids">, "exclusions" | "identifiedExclusions">): string[] {
  const source = bid.exclusions && bid.exclusions.length > 0 ? bid.exclusions : bid.identifiedExclusions.map((e) => e.description);
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
