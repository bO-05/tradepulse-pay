import type { Doc } from "../_generated/dataModel";
import { fromDollars } from "./money";

/**
 * Integer-cents bid money. Stored bids carry only `*Cents` amounts; dollar inputs (AI parser
 * output, seed specs, legacy penalty constants) are converted here, at the storage boundary.
 */

export type BidLineItemCents = { item: string; unit: string; quantity: number; unitCostCents: number; totalCostCents: number };
export type BidExclusionCents = {
  canonicalCode?: string;
  description: string;
  costImpactCents: number;
  severity: string;
  isWaived?: boolean;
};
export type BidVeAlternateCents = { description: string; costDeductCents: number; isAccepted: boolean };

/** Non-negative cents from a dollar number of unknown quality (model output, seed literal). */
export function nonNegativeCentsFromDollars(dollars: unknown): number {
  const n = typeof dollars === "number" ? dollars : Number(dollars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return fromDollars(n);
}

function safeCents(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}

/** A scope gap's comparison plug in cents (0 when waived). */
export function exclusionPlugCents(e: { costImpactCents?: number; isWaived?: boolean }): number {
  return e.isWaived ? 0 : Math.max(0, safeCents(e.costImpactCents));
}

export function acceptedVeDeductCents(alternates: ReadonlyArray<{ costDeductCents?: number; isAccepted: boolean }>): number {
  return alternates.reduce((s, a) => (a.isAccepted ? s + Math.max(0, safeCents(a.costDeductCents)) : s), 0);
}

/** ADR-0003, in cents: base + un-waived gaps + lead-time penalty + COI penalty - accepted VE, floored at 0. */
export function computeLeveledTotalCents(input: {
  baseAmountCents: number;
  exclusions: ReadonlyArray<{ costImpactCents?: number; isWaived?: boolean }>;
  veAlternates: ReadonlyArray<{ costDeductCents?: number; isAccepted: boolean }>;
  leadTimePenaltyCents: number;
  coiPenaltyCents: number;
}): number {
  const gaps = input.exclusions.reduce((s, e) => s + exclusionPlugCents(e), 0);
  return Math.max(
    0,
    input.baseAmountCents + gaps + input.leadTimePenaltyCents + input.coiPenaltyCents - acceptedVeDeductCents(input.veAlternates),
  );
}

/** The bid's top-level amounts in cents. */
export function bidCents(bid: Pick<Doc<"bids">, "baseAmountCents" | "leveledTotalCents" | "leadTimePenaltyCents" | "coiPenaltyCents">) {
  return {
    baseAmountCents: safeCents(bid.baseAmountCents),
    leveledTotalCents: safeCents(bid.leveledTotalCents),
    leadTimePenaltyCents: safeCents(bid.leadTimePenaltyCents),
    coiPenaltyCents: safeCents(bid.coiPenaltyCents),
  };
}

export function lineItemsToCents(
  items: ReadonlyArray<{ item: string; unit: string; quantity: unknown; unitCost?: unknown; totalCost?: unknown }>,
): BidLineItemCents[] {
  return items.map((li) => ({
    item: String(li.item ?? ""),
    unit: String(li.unit ?? ""),
    quantity: Math.max(0, Number(li.quantity) || 0),
    unitCostCents: nonNegativeCentsFromDollars(li.unitCost),
    totalCostCents: nonNegativeCentsFromDollars(li.totalCost),
  }));
}

export function exclusionsToCents(
  items: ReadonlyArray<{ canonicalCode?: string; description: string; costImpact?: unknown; severity?: string; isWaived?: boolean }>,
): BidExclusionCents[] {
  return items.map((e) => ({
    ...(e.canonicalCode ? { canonicalCode: e.canonicalCode } : {}),
    description: e.description,
    costImpactCents: nonNegativeCentsFromDollars(e.costImpact),
    severity: e.severity ?? "moderate",
    ...(e.isWaived !== undefined ? { isWaived: e.isWaived } : {}),
  }));
}

export function veAlternatesToCents(
  items: ReadonlyArray<{ description: string; costDeduct?: unknown; isAccepted: boolean }>,
): BidVeAlternateCents[] {
  return items.map((a) => ({
    description: a.description,
    costDeductCents: nonNegativeCentsFromDollars(a.costDeduct),
    isAccepted: a.isAccepted,
  }));
}

/**
 * Patched into a row whenever its cents change, so a stale legacy dollar value can never disagree
 * with the stored cents.
 */
export const CLEAR_LEGACY_BID_DOLLARS = {
  baseBidAmount: undefined,
  leveledTotalCost: undefined,
  leadTimePenalty: undefined,
  coiPenalty: undefined,
} as const;

/** A bid spec written in dollars (seed data, fixtures). */
export type DollarBidSpec = {
  baseBidAmount: number;
  lineItems?: ReadonlyArray<{ item: string; unit: string; quantity: number; unitCost: number; totalCost: number }>;
  identifiedExclusions?: ReadonlyArray<{ canonicalCode?: string; description: string; costImpact: number; severity: string; isWaived?: boolean }>;
  valueEngineeringAlternates?: ReadonlyArray<{ description: string; costDeduct: number; isAccepted: boolean }>;
  leadTimePenalty?: number;
  coiPenalty?: number;
  leveledTotalCost?: number;
};

/**
 * Converts the money of a dollar bid spec into the stored cents fields. The leveled total is the
 * spec's stated total when given (seed scenarios pin it), otherwise computed.
 */
export function centsFieldsFromDollarSpec(spec: DollarBidSpec) {
  const baseAmountCents = nonNegativeCentsFromDollars(spec.baseBidAmount);
  const lineItems = lineItemsToCents(spec.lineItems ?? []);
  const identifiedExclusions = exclusionsToCents(spec.identifiedExclusions ?? []);
  const valueEngineeringAlternates = veAlternatesToCents(spec.valueEngineeringAlternates ?? []);
  const leadTimePenaltyCents = nonNegativeCentsFromDollars(spec.leadTimePenalty ?? 0);
  const coiPenaltyCents = nonNegativeCentsFromDollars(spec.coiPenalty ?? 0);
  const leveledTotalCents =
    spec.leveledTotalCost !== undefined
      ? nonNegativeCentsFromDollars(spec.leveledTotalCost)
      : computeLeveledTotalCents({
          baseAmountCents,
          exclusions: identifiedExclusions,
          veAlternates: valueEngineeringAlternates,
          leadTimePenaltyCents,
          coiPenaltyCents,
        });
  return {
    baseAmountCents,
    lineItems,
    identifiedExclusions,
    valueEngineeringAlternates,
    leadTimePenaltyCents,
    coiPenaltyCents,
    leveledTotalCents,
  };
}

/** Replaces the dollar money fields of a spec with cents fields; everything else is kept. */
export function bidRowFromDollars<T extends DollarBidSpec>(spec: T) {
  const { baseBidAmount: _b, lineItems: _l, identifiedExclusions: _e, valueEngineeringAlternates: _v, leadTimePenalty: _p, coiPenalty: _c, leveledTotalCost: _t, ...rest } =
    spec;
  return { ...rest, ...centsFieldsFromDollarSpec(spec) };
}
