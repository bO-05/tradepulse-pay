import type { Doc } from "../_generated/dataModel";

/**
 * A contractor may bid on a trade package it was discovered for, or on a package that explicitly
 * invited it (an existing contractor bidding on a second package keeps its one record, so its
 * portal account and history stay attached).
 */
export function contractorCanBidOnPackage(
  contractor: Pick<Doc<"contractors">, "_id" | "tradePackageId">,
  tradePkg: Pick<Doc<"tradePackages">, "_id" | "invitedContractorIds">,
): boolean {
  if (contractor.tradePackageId === tradePkg._id) return true;
  return (tradePkg.invitedContractorIds ?? []).includes(contractor._id);
}
