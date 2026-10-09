import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { formatCents } from "./money";

export type BidTerms = {
  baseAmountCents: number;
  alternates: { description: string; amountCents: number }[];
  exclusions: string[];
  inclusions: string[];
  unitPrices: { item: string; unit: string; unitPriceCents: number }[];
  qualifications?: string;
  validUntil?: string;
};

export type RevisionSource = Doc<"bidRevisions">["source"];

/** The bidder-facing terms currently stored on a bid row. */
export function termsOfBid(bid: Doc<"bids">): BidTerms {
  return {
    baseAmountCents: bid.baseAmountCents ?? 0,
    alternates: bid.alternates ?? [],
    exclusions: bid.exclusions ?? bid.identifiedExclusions.map((e) => e.description),
    inclusions: bid.inclusions ?? [],
    unitPrices: bid.unitPrices ?? [],
    ...(bid.qualifications !== undefined ? { qualifications: bid.qualifications } : {}),
    ...(bid.validUntil !== undefined ? { validUntil: bid.validUntil } : {}),
  };
}

/** Appends the bid's current revision to its history (revision number = the bid's revisionNumber). */
export async function recordBidRevision(
  ctx: MutationCtx,
  bid: Doc<"bids">,
  opts: {
    source: RevisionSource;
    terms: BidTerms;
    note?: string;
    submittedByUserId?: Id<"users">;
    submittedByName: string;
    submittedByCompanyId?: Id<"companies">;
    sourceInboundEmailId?: Id<"inboundEmails">;
  },
): Promise<Id<"bidRevisions">> {
  return await ctx.db.insert("bidRevisions", {
    bidId: bid._id,
    tradePackageId: bid.tradePackageId,
    contractorId: bid.contractorId,
    revisionNumber: bid.revisionNumber ?? 1,
    source: opts.source,
    ...opts.terms,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.submittedByUserId ? { submittedByUserId: opts.submittedByUserId } : {}),
    submittedByName: opts.submittedByName,
    ...(opts.submittedByCompanyId ? { submittedByCompanyId: opts.submittedByCompanyId } : {}),
    ...(opts.sourceInboundEmailId ? { sourceInboundEmailId: opts.sourceInboundEmailId } : {}),
    createdAt: Date.now(),
  });
}

function listDiff(label: string, before: readonly string[], after: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of after) if (!before.includes(x)) out.push(`Added ${label} "${x}"`);
  for (const x of before) if (!after.includes(x)) out.push(`Removed ${label} "${x}"`);
  return out;
}

/** Plain-language changes from one revision to the next, e.g. `Base $174,900.00 → $172,400.00`. */
export function describeTermChanges(before: BidTerms, after: BidTerms): string[] {
  const out: string[] = [];
  if (before.baseAmountCents !== after.baseAmountCents) {
    out.push(`Base ${formatCents(before.baseAmountCents)} → ${formatCents(after.baseAmountCents)}`);
  }
  const alt = (a: BidTerms["alternates"][number]) => `${a.description} ${formatCents(a.amountCents)}`;
  out.push(...listDiff("alternate", before.alternates.map(alt), after.alternates.map(alt)));
  out.push(...listDiff("exclusion", before.exclusions, after.exclusions));
  out.push(...listDiff("inclusion", before.inclusions, after.inclusions));
  const up = (u: BidTerms["unitPrices"][number]) => `${u.item} (${u.unit}) ${formatCents(u.unitPriceCents)}`;
  out.push(...listDiff("unit price", before.unitPrices.map(up), after.unitPrices.map(up)));
  if ((before.qualifications ?? "") !== (after.qualifications ?? "")) out.push("Qualifications changed");
  if ((before.validUntil ?? "") !== (after.validUntil ?? "")) {
    out.push(`Valid until ${before.validUntil ?? "not set"} → ${after.validUntil ?? "not set"}`);
  }
  return out;
}
