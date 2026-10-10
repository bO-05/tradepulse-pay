import { formatCents } from "../lib/money";

/**
 * Pure rules for GC-defined funding tranches (architecture §16): amounts in integer cents, the
 * tranche total capped at the contract sum to date, and planned dates that default to the project
 * start rather than anything earlier.
 */

export const MAX_TRANCHE_NAME_LENGTH = 80;

/** One documented capacity: every read of an agreement's tranches loads all of them or refuses. */
export const MAX_TRANCHES_PER_AGREEMENT = 50;
export const TRANCHE_LIMIT_MESSAGE = `An agreement can have at most ${MAX_TRANCHES_PER_AGREEMENT} funding tranches. Combine or delete a tranche before adding another.`;
export const TRANCHE_CAPACITY_MESSAGE = `This agreement has more than ${MAX_TRANCHES_PER_AGREEMENT} funding tranches, more than TradePulse supports. Delete unfunded tranches until at most ${MAX_TRANCHES_PER_AGREEMENT} remain.`;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrancheCheck = { ok: true } | { ok: false; message: string };

export function checkTrancheName(name: string): TrancheCheck {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, message: "Enter a tranche name." };
  if (trimmed.length > MAX_TRANCHE_NAME_LENGTH) return { ok: false, message: `A tranche name must be at most ${MAX_TRANCHE_NAME_LENGTH} characters.` };
  return { ok: true };
}

export function checkTrancheAmount(amountCents: number): TrancheCheck {
  if (!Number.isSafeInteger(amountCents)) return { ok: false, message: "The tranche amount must be whole cents." };
  if (amountCents <= 0) return { ok: false, message: "The tranche amount must be more than $0.00." };
  return { ok: true };
}

/** The total of every tranche on the agreement (with the new or changed amount) may not exceed the contract sum to date. */
export function checkTrancheTotal(otherTrancheCents: readonly number[], amountCents: number, contractSumToDateCents: number): TrancheCheck {
  const total = otherTrancheCents.reduce((a, c) => a + c, 0) + amountCents;
  if (total > contractSumToDateCents) {
    return {
      ok: false,
      message: `Tranches total ${formatCents(total)}, more than the contract sum to date ${formatCents(contractSumToDateCents)}`,
    };
  }
  return { ok: true };
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function calendarDateToMs(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The project start as UTC midnight, or null when the project has no valid start date. */
export function projectStartMs(project: { startDate?: string } | null | undefined): number | null {
  const s = project?.startDate;
  return s !== undefined && isCalendarDate(s) ? calendarDateToMs(s) : null;
}

/** Default planned date for a new tranche: the project start, never earlier; today when there is no start date. */
export function defaultTranchePlannedDate(startMs: number | null, nowMs: number): number {
  return startMs ?? startOfUtcDay(nowMs);
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** A warning (not an error) when the GC plans a tranche before the project starts. */
export function plannedDateWarning(plannedMs: number, startMs: number | null): string | null {
  if (startMs === null || plannedMs >= startMs) return null;
  return `The planned date ${formatUtcDate(plannedMs)} is before the project start ${formatUtcDate(startMs)}.`;
}
