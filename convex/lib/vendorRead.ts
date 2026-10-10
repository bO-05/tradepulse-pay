import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Merged duplicate vendor rows are kept as tombstones (status "merged", mergedIntoVendorId) rather
 * than deleted, so an id stored anywhere (invite, bidder, project member, notification link) still
 * resolves. Every read of a vendor by id goes through liveVendor.
 */

const MAX_MERGE_HOPS = 10;

/** The vendor row an id refers to now, following merges; null when missing. */
export async function liveVendor(ctx: QueryCtx, vendorId: Id<"vendors">): Promise<Doc<"vendors"> | null> {
  let vendor = await ctx.db.get(vendorId);
  for (let hop = 0; vendor !== null && vendor.status === "merged" && hop < MAX_MERGE_HOPS; hop++) {
    vendor = vendor.mergedIntoVendorId === undefined ? null : await ctx.db.get(vendor.mergedIntoVendorId);
  }
  return vendor !== null && vendor.status === "merged" ? null : vendor;
}

/** liveVendor for an untrusted id string. */
export async function liveVendorByRawId(ctx: QueryCtx, raw: string): Promise<Doc<"vendors"> | null> {
  const id = ctx.db.normalizeId("vendors", raw);
  return id === null ? null : await liveVendor(ctx, id);
}

export function isMergedVendor(vendor: Doc<"vendors">): boolean {
  return vendor.status === "merged";
}
