import { v } from "convex/values";

/**
 * Bid validators shared by the schema and the bid functions. Every amount is integer cents
 * (`*Cents`). The dollar fields (`baseBidAmount`, `costImpact`, ...) exist only on rows written
 * before the cents migration; nothing reads them except `bidCentsMigration`.
 */

export const bidLineItemValidator = v.object({
  item: v.string(),
  unit: v.string(),
  quantity: v.number(),
  unitCostCents: v.optional(v.number()),
  totalCostCents: v.optional(v.number()),
  unitCost: v.optional(v.number()),
  totalCost: v.optional(v.number()),
});

export const bidExclusionValidator = v.object({
  canonicalCode: v.optional(v.string()),
  description: v.string(),
  costImpactCents: v.optional(v.number()),
  costImpact: v.optional(v.number()),
  severity: v.string(), // "critical" | "moderate" | "minor"
  isWaived: v.optional(v.boolean()),
  // costImpactCents is the leveling plug: comparison only, never contract sum or SOV. The
  // attribution is set by the server from the session; client-sent values are ignored.
  plugNote: v.optional(v.string()),
  plugEnteredByUserId: v.optional(v.id("users")),
  plugEnteredByName: v.optional(v.string()),
  plugEnteredAt: v.optional(v.number()),
});

export const bidVeAlternateValidator = v.object({
  description: v.string(),
  costDeductCents: v.optional(v.number()),
  costDeduct: v.optional(v.number()),
  isAccepted: v.boolean(),
});

/** A bidder's priced alternate; a negative amount is a deduct. */
export const bidAlternateValidator = v.object({
  description: v.string(),
  amountCents: v.number(),
});

export const bidUnitPriceValidator = v.object({
  item: v.string(),
  unit: v.string(),
  unitPriceCents: v.number(),
});

export const bidSourceValidator = v.union(
  v.literal("portal"),
  v.literal("gc_entered"),
  v.literal("email_ai"),
  v.literal("document_ai"),
  v.literal("seed"),
  v.literal("legacy"),
);

/** What a bid revision records: the bidder-facing terms of the bid at that revision. */
export const bidTermsFields = {
  baseAmountCents: v.number(),
  alternates: v.array(bidAlternateValidator),
  exclusions: v.array(v.string()),
  inclusions: v.array(v.string()),
  unitPrices: v.array(bidUnitPriceValidator),
  qualifications: v.optional(v.string()),
  validUntil: v.optional(v.string()),
};

export const bidTermsValidator = v.object(bidTermsFields);
