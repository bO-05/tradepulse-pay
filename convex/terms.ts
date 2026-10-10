/**
 * Leveling constants for TradePulse Pay (ADR-0003). Subcontract commercial terms (retainage,
 * payment terms, liquidated damages, insurance, warranty, governing state) are per agreement:
 * see convex/lib/agreementTerms.ts.
 */

/**
 * Retainage percent of the seeded Demo company's Texas scenarios, and the fallback for a legacy
 * agreement row whose stored percent is unusable.
 */
export const RETAINAGE_PERCENT = 10;

/**
 * ADR-0003 lead-time penalty rate applied when a bidder's equipment lead time
 * exceeds the project milestone (schedule-impact rate, not the contract LD rate).
 */
export const LEAD_TIME_PENALTY_PER_WEEK = 6000;

/** Target equipment lead times used by the leveling engine (weeks). */
export const LEAD_TIME_TARGET_WEEKS_ELECTRICAL = 12;
export const LEAD_TIME_TARGET_WEEKS_MECHANICAL = 16;

/**
 * DECISION (A6-05r/A6-54): the lead-time baseline is a GC-owned schedule
 * milestone, not a bidder-stated number. Division 26 electrical switchgear uses
 * a 12-week milestone; Division 22 plumbing and Division 23 HVAC equipment use a
 * 16-week milestone. Both the LLM extraction path and the deterministic fallback
 * read the target from here, and the UI renders which target was used, so the
 * same bid can never be priced against two different baselines.
 */
export function targetWeeksForDivision(division: string | undefined | null): number {
  const prefix = String(division || "").trim().slice(0, 2);
  return prefix === "22" || prefix === "23"
    ? LEAD_TIME_TARGET_WEEKS_MECHANICAL
    : LEAD_TIME_TARGET_WEEKS_ELECTRICAL;
}

/** Standard COI deficiency penalty applied by ADR-0003. */
export const COI_DEFICIENCY_PENALTY = 15000;

export function leadTimePenaltyFor(actualWeeks: number, targetWeeks: number): number {
  if (!Number.isFinite(actualWeeks)) return 0;
  return Math.max(0, actualWeeks - targetWeeks) * LEAD_TIME_PENALTY_PER_WEEK;
}