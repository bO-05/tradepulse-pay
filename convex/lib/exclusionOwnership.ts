import type { Doc } from "../_generated/dataModel";
import type { BidExclusion } from "./levelingPlugs";

/**
 * Exclusion rows on a bid belong either to the bidder (its proposal lists them) or to the GC (added
 * while leveling). A bidder revision replaces only the bidder's rows; GC rows and their plugs stay.
 */

type BidExclusionsView = Pick<Doc<"bids">, "identifiedExclusions" | "exclusions">;
export type ExclusionOwner = "gc" | "bidder";

const sameScope = (a: string, b: string) => a.trim() === b.trim();

/** Plug attribution is written only by GC leveling writes (Adjust Leveling, setExclusionPlug). */
function hasGcAttribution(e: BidExclusion): boolean {
  return e.plugEnteredAt !== undefined || e.plugEnteredByUserId !== undefined || e.plugEnteredByName !== undefined;
}

/**
 * Rows stored before ownership existed: a row carrying GC plug attribution is the GC's. Otherwise
 * the bidder's own exclusion list decides, since a row the bidder never listed can only have been
 * added by the GC. Older bids without a bidder list (parsed before `exclusions` was stored) treat
 * unattributed rows as the parser's, so the bidder's.
 */
export function exclusionOwner(e: BidExclusion, bidderList: readonly string[] | undefined): ExclusionOwner {
  if (e.source !== undefined) return e.source;
  if (hasGcAttribution(e)) return "gc";
  if (bidderList === undefined) return "bidder";
  return bidderList.some((d) => sameScope(d, e.description)) ? "bidder" : "gc";
}

export function gcOwnedExclusions(bid: BidExclusionsView | null): BidExclusion[] {
  if (bid === null) return [];
  return bid.identifiedExclusions
    .filter((e) => exclusionOwner(e, bid.exclusions) === "gc")
    .map((e) => ({ ...e, source: "gc" as const }));
}

/**
 * The rows after a bidder revision: the bidder's new list, then every GC-owned row. A GC row the
 * bidder now also lists stays a single GC-owned row, so a later revision dropping it keeps it.
 */
export function reconcileBidderExclusions(existing: BidExclusionsView | null, bidderRows: readonly BidExclusion[]): BidExclusion[] {
  const gcRows = gcOwnedExclusions(existing);
  const out: BidExclusion[] = bidderRows.map(
    (row) => gcRows.find((g) => sameScope(g.description, row.description)) ?? { ...row, source: "bidder" as const },
  );
  for (const g of gcRows) if (!out.includes(g)) out.push(g);
  return out;
}

/** Ownership for a GC leveling write: rows the bid already had keep their owner; rows the GC adds are GC-owned. */
export function ownedLevelingRows(previous: BidExclusionsView, next: readonly BidExclusion[]): BidExclusion[] {
  return next.map((e) => {
    const prev = previous.identifiedExclusions.find((p) => sameScope(p.description, e.description));
    return { ...e, source: prev ? exclusionOwner(prev, previous.exclusions) : ("gc" as const) };
  });
}
