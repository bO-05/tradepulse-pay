/**
 * Pure schedule-of-values and milestone math. Every amount is integer cents and
 * every split sums exactly to its total.
 */
import { assertCents } from "../lib/money";

/**
 * Splits `totalCents` across `weights` in proportion, flooring each share and
 * putting the whole rounding remainder on the last entry. All-zero weights
 * split evenly.
 */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  assertCents(totalCents, "totalCents");
  if (totalCents < 0) throw new Error(`Cannot allocate a negative total: ${totalCents}`);
  if (weights.length === 0) throw new Error("allocateCents needs at least one weight");
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? BigInt(Math.round(w)) : 0n));
  let weightSum = safe.reduce((a, b) => a + b, 0n);
  const effective = weightSum === 0n ? safe.map(() => 1n) : safe;
  if (weightSum === 0n) weightSum = BigInt(effective.length);
  const total = BigInt(totalCents);
  const shares = effective.map((w) => Number((total * w) / weightSum));
  const allocatedBeforeLast = shares.slice(0, -1).reduce((a, b) => a + b, 0);
  shares[shares.length - 1] = totalCents - allocatedBeforeLast;
  return shares;
}

export type BidLineItemInput = { item: string; totalCostCents?: number };
export type BidExclusionInput = {
  description: string;
  costImpactCents?: number;
  isWaived?: boolean;
  canonicalCode?: string;
};

export type SovLineDraft = {
  lineNo: number;
  description: string;
  csiCode?: string;
  scheduledValueCents: number;
  excludedScope: boolean;
  sourceBidLineRef: string;
};

function nonNegativeCents(cents: number | undefined): number {
  return typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

/**
 * Builds SOV lines from a leveled bid: one line per bid line item, then one
 * excluded-scope line per leveled exclusion. Un-waived exclusions carry their
 * leveling plug (it is part of the leveled contract sum); waived ones carry $0.
 * The base-scope lines share the rest of the contract sum (base bid plus any
 * leveling penalties less accepted VE) in proportion to their bid totals, with
 * the rounding remainder on the last base-scope line. If the plugs alone exceed
 * the contract sum, every line is scaled proportionally instead.
 */
export function buildSovLines(input: {
  contractSumCents: number;
  lineItems: readonly BidLineItemInput[];
  exclusions: readonly BidExclusionInput[];
  csiDivision?: string;
  tradeName: string;
}): SovLineDraft[] {
  const contractSumCents = assertCents(input.contractSumCents, "contractSumCents");
  if (contractSumCents < 0) throw new Error("Contract sum cannot be negative");

  const base = input.lineItems.length
    ? input.lineItems.map((li, i) => ({
        description: li.item.trim() || `Bid line ${i + 1}`,
        weight: nonNegativeCents(li.totalCostCents),
        ref: `lineItems[${i}]`,
      }))
    : [{ description: `${input.tradeName} — base scope`, weight: 1, ref: "baseAmountCents" }];

  const excluded = input.exclusions.map((ex, i) => ({
    description: `Excluded scope${ex.isWaived ? " (waived)" : ""}: ${ex.description.trim() || `exclusion ${i + 1}`}`,
    plugCents: ex.isWaived ? 0 : nonNegativeCents(ex.costImpactCents),
    csiCode: ex.canonicalCode,
    ref: `identifiedExclusions[${i}]`,
  }));

  const plugTotal = excluded.reduce((a, e) => a + e.plugCents, 0);
  let baseValues: number[];
  let excludedValues: number[];
  if (plugTotal <= contractSumCents) {
    excludedValues = excluded.map((e) => e.plugCents);
    baseValues = allocateCents(contractSumCents - plugTotal, base.map((b) => b.weight));
  } else {
    const all = allocateCents(contractSumCents, [...base.map((b) => b.weight), ...excluded.map((e) => e.plugCents)]);
    baseValues = all.slice(0, base.length);
    excludedValues = all.slice(base.length);
  }

  const lines: SovLineDraft[] = base.map((b, i) => ({
    lineNo: i + 1,
    description: b.description,
    csiCode: input.csiDivision,
    scheduledValueCents: baseValues[i],
    excludedScope: false,
    sourceBidLineRef: b.ref,
  }));
  excluded.forEach((e, i) => {
    lines.push({
      lineNo: lines.length + 1,
      description: e.description,
      csiCode: e.csiCode ?? input.csiDivision,
      scheduledValueCents: excludedValues[i],
      excludedScope: true,
      sourceBidLineRef: e.ref,
    });
  });
  return lines;
}

/**
 * Canonical description of everything the SOV and milestones are derived from
 * (awarded bid, contract sum, bid lines, leveled exclusions and their plugs,
 * lead weeks). Two awards with the same total but different scope differ here.
 */
export function sovSourceFingerprint(input: {
  bidId: string;
  contractSumCents: number;
  lineItems: readonly BidLineItemInput[];
  exclusions: readonly BidExclusionInput[];
  leadWeeks: number;
}): string {
  return JSON.stringify({
    v: 1,
    bid: input.bidId,
    sum: input.contractSumCents,
    lines: input.lineItems.map((li) => [li.item.trim(), nonNegativeCents(li.totalCostCents)]),
    excl: input.exclusions.map((ex) => [
      ex.canonicalCode ?? null,
      ex.description.trim(),
      ex.isWaived ? 0 : nonNegativeCents(ex.costImpactCents),
      ex.isWaived === true,
    ]),
    lead: Number.isFinite(input.leadWeeks) && input.leadWeeks > 0 ? input.leadWeeks : 0,
  });
}

/** Default milestones in order, with their share of the contract sum in basis points. */
export const DEFAULT_MILESTONES = [
  { name: "Mobilization", order: 1, shareBps: 1000 },
  { name: "Rough-in", order: 2, shareBps: 4000 },
  { name: "Trim-out", order: 3, shareBps: 3500 },
  { name: "Closeout", order: 4, shareBps: 1500 },
] as const;

/** Milestone amounts; the rounding remainder lands on Closeout. */
export function splitMilestoneAmounts(contractSumCents: number): number[] {
  return allocateCents(contractSumCents, DEFAULT_MILESTONES.map((m) => m.shareBps));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Planned milestone dates (UTC midnight). Mobilization is two weeks after
 * project start but never earlier than a week after execution; rough-in waits
 * for the bid's long-lead equipment; trim-out and closeout track the project's
 * target duration, each at least a couple of weeks after the previous one.
 */
export function planMilestoneDates(input: {
  projectStartMs: number;
  executedAtMs: number;
  leadWeeks: number;
  durationWeeks: number;
}): number[] {
  const start = startOfUtcDay(input.projectStartMs);
  const executed = startOfUtcDay(input.executedAtMs);
  const lead = Number.isFinite(input.leadWeeks) && input.leadWeeks > 0 ? input.leadWeeks : 0;
  const duration =
    Number.isFinite(input.durationWeeks) && input.durationWeeks > 0 ? input.durationWeeks : 52;
  const mobilization = Math.max(start + 2 * WEEK_MS, executed + WEEK_MS);
  const roughIn = mobilization + Math.max(4, Math.ceil(lead)) * WEEK_MS;
  const trimOut = Math.max(roughIn + 4 * WEEK_MS, start + Math.round(duration * 0.75) * WEEK_MS);
  const closeout = Math.max(trimOut + 2 * WEEK_MS, start + Math.round(duration) * WEEK_MS);
  return [mobilization, roughIn, trimOut, closeout];
}
