/**
 * G702/G703 pay-application math (architecture §16), in integer cents. Shared by the Convex functions
 * and the sub's continuation-sheet editor so both show and enforce the same figures.
 *
 * Column meanings per line: C scheduled value, D work completed on previous applications (excludes
 * stored material), E work this period, F materials presently stored (carried forward; it moves into E
 * when installed), G = D + E + F, H = C − G, I retainage = line rate × G, rounded half-up per line.
 *
 * Legacy pay-app code bills a per-line increment (`requestedCents`). For a G703 line that increment is
 * this application's G minus the previous application's G: E + F − previous F.
 */
import { formatCents } from "../lib/money";

export const MAX_STORED_NOTE_LENGTH = 500;

/** `bps` basis points of `cents`, halves rounded away from zero (exact BigInt arithmetic). */
export function retainageOf(cents: number, bps: number): number {
  if (!Number.isSafeInteger(cents)) throw new Error(`cents must be an integer, got ${cents}`);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`retainage bps must be 0-10000, got ${bps}`);
  const n = BigInt(Math.abs(cents)) * BigInt(bps);
  let q = n / 10_000n;
  if ((n % 10_000n) * 2n >= 10_000n) q += 1n;
  const r = Number(q);
  return cents < 0 ? -r : r;
}

/** G / C in hundredths of a percent, half-up (4444 = 44.44%); null when C is zero. */
export function percentHundredths(totalCents: number, scheduledCents: number): number | null {
  if (scheduledCents === 0) return null;
  const n = BigInt(totalCents) * 10_000n;
  const d = BigInt(scheduledCents);
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return Number(neg ? -q : q);
}

/** "44.44%" from hundredths of a percent; "—" when there is no percent. */
export function formatPercentHundredths(h: number | null): string {
  if (h === null) return "—";
  const sign = h < 0 ? "-" : "";
  const abs = Math.abs(h);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}

export type G703LineInput = {
  scheduledValueCents: number;
  previousWorkCents: number;
  workThisPeriodCents: number;
  storedCents: number;
  retainageBps: number;
};

export type G703LineFigures = {
  totalCents: number;
  percentHundredths: number | null;
  balanceCents: number;
  retainageCents: number;
  /** Part of the line's retainage on stored material (G702 5b); the rest is on completed work (5a). */
  retainageStoredCents: number;
  retainageWorkCents: number;
};

export function g703Line(l: G703LineInput): G703LineFigures {
  const totalCents = l.previousWorkCents + l.workThisPeriodCents + l.storedCents;
  const retainageCents = retainageOf(totalCents, l.retainageBps);
  const retainageStoredCents = Math.min(retainageCents, retainageOf(l.storedCents, l.retainageBps));
  return {
    totalCents,
    percentHundredths: percentHundredths(totalCents, l.scheduledValueCents),
    balanceCents: l.scheduledValueCents - totalCents,
    retainageCents,
    retainageStoredCents,
    retainageWorkCents: retainageCents - retainageStoredCents,
  };
}

export type G702Summary = {
  originalContractSumCents: number;
  netChangeOrdersCents: number;
  contractSumToDateCents: number;
  scheduledValueCents: number;
  previousWorkCents: number;
  workThisPeriodCents: number;
  storedCents: number;
  completedAndStoredCents: number;
  balanceToFinishCents: number;
  retainageCents: number;
  retainageWorkCents: number;
  retainageStoredCents: number;
  earnedLessRetainageCents: number;
  previousCertificatesCents: number;
  currentPaymentDueCents: number;
  balanceToFinishInclRetainageCents: number;
};

/**
 * G702 lines 1-9 from the G703 lines. Retainage (line 5) is the sum of the per-line rounded figures,
 * never the rounded total. Contract sum to date is the sum of the scheduled values on the sheet.
 */
export function g702Summary(
  lines: readonly G703LineInput[],
  opts: { originalContractSumCents: number; previousCertificatesCents: number },
): G702Summary {
  let scheduled = 0;
  let previous = 0;
  let work = 0;
  let stored = 0;
  let retainage = 0;
  let retainageStored = 0;
  for (const l of lines) {
    const f = g703Line(l);
    scheduled += l.scheduledValueCents;
    previous += l.previousWorkCents;
    work += l.workThisPeriodCents;
    stored += l.storedCents;
    retainage += f.retainageCents;
    retainageStored += f.retainageStoredCents;
  }
  const completed = previous + work + stored;
  const earned = completed - retainage;
  return {
    originalContractSumCents: opts.originalContractSumCents,
    netChangeOrdersCents: scheduled - opts.originalContractSumCents,
    contractSumToDateCents: scheduled,
    scheduledValueCents: scheduled,
    previousWorkCents: previous,
    workThisPeriodCents: work,
    storedCents: stored,
    completedAndStoredCents: completed,
    balanceToFinishCents: scheduled - completed,
    retainageCents: retainage,
    retainageWorkCents: retainage - retainageStored,
    retainageStoredCents: retainageStored,
    earnedLessRetainageCents: earned,
    previousCertificatesCents: opts.previousCertificatesCents,
    currentPaymentDueCents: earned - opts.previousCertificatesCents,
    balanceToFinishInclRetainageCents: scheduled - earned,
  };
}

/** Previous certificates (G702 line 7): what the previous applications earned less their retainage. */
export function previousCertificatesCents(lines: readonly { previousTotalCents: number; retainageBps: number }[]): number {
  return lines.reduce((acc, l) => acc + l.previousTotalCents - retainageOf(l.previousTotalCents, l.retainageBps), 0);
}

export type G703EntryLine = {
  sovLineId: string;
  lineNo: number;
  scheduledValueCents: number;
  previousWorkCents: number;
  previousStoredCents: number;
  /** Requested on other applications still awaiting a GC decision; counts against what remains. */
  pendingCents: number;
  workThisPeriodCents: number;
  storedCents: number;
  note?: string;
};

export type G703LineError = { sovLineId: string; lineNo: number; message: string };

/** Billing increment of a line: this application's G minus the previous application's G. */
export function lineIncrementCents(l: { workThisPeriodCents: number; storedCents: number; previousStoredCents: number }): number {
  return l.workThisPeriodCents + l.storedCents - l.previousStoredCents;
}

/** What E + F may total on a line: the scheduled value less previous work and other pending requests. */
export function lineRemainingCents(l: Pick<G703EntryLine, "scheduledValueCents" | "previousWorkCents" | "pendingCents">): number {
  if (l.scheduledValueCents < 0) return Math.min(0, l.scheduledValueCents - l.previousWorkCents);
  return Math.max(0, l.scheduledValueCents - l.previousWorkCents - l.pendingCents);
}

/** Billing on a deductive (negative) change-order line: E between the remaining deduction and 0.00, no stored material. */
function deductiveLineErrors(l: G703EntryLine, push: (message: string) => void): void {
  const remaining = lineRemainingCents(l);
  if (l.storedCents !== 0) push("a deductive change-order line has no stored materials.");
  else if (l.workThisPeriodCents > 0) push(`a deductive change-order line bills between ${formatCents(remaining)} and $0.00.`);
  else if (l.workThisPeriodCents < remaining) {
    push(`at most ${formatCents(remaining)} remains to deduct; this is ${formatCents(remaining - l.workThisPeriodCents)} beyond the scheduled value.`);
  }
}

/**
 * Every per-line problem with the entered E and F: whole non-negative cents, no line above 100% of its
 * scheduled value, and no total to date below the previous application's (stored material leaves F only
 * by being installed into E). A deductive change-order line (negative C) bills E in [C − D, 0].
 */
export function g703LineErrors(lines: readonly G703EntryLine[]): G703LineError[] {
  const errors: G703LineError[] = [];
  for (const l of lines) {
    const push = (message: string) => errors.push({ sovLineId: l.sovLineId, lineNo: l.lineNo, message: `Line ${l.lineNo}: ${message}` });
    if (!Number.isSafeInteger(l.workThisPeriodCents) || !Number.isSafeInteger(l.storedCents)) {
      push("amounts must be whole cents.");
      continue;
    }
    if (l.scheduledValueCents < 0) {
      deductiveLineErrors(l, push);
      continue;
    }
    if (l.workThisPeriodCents < 0) {
      push("work this period cannot be negative; it cannot take the total below the previous applications.");
      continue;
    }
    if (l.storedCents < 0) {
      push("materials presently stored cannot be negative.");
      continue;
    }
    if (l.note !== undefined && l.note.length > MAX_STORED_NOTE_LENGTH) {
      push(`the note must be at most ${MAX_STORED_NOTE_LENGTH} characters.`);
    }
    const remaining = lineRemainingCents(l);
    const claimed = l.workThisPeriodCents + l.storedCents;
    if (claimed > remaining) {
      push(`at most ${formatCents(remaining)} remains; this is ${formatCents(claimed - remaining)} over 100% of the scheduled value.`);
      continue;
    }
    if (lineIncrementCents(l) < 0) {
      push(
        `the total to date cannot drop below the previous application's ${formatCents(l.previousWorkCents + l.previousStoredCents)}. Stored materials leave column F only when installed (column E).`,
      );
    }
  }
  return errors;
}

/**
 * How a GC-approved line increment splits into work (E) and stored material (F): the approved E + F is
 * the increment plus the previous stored amount, and stored material is kept first, up to what was
 * claimed as stored. A negative increment is a deductive change-order credit (no stored material) and
 * stays negative work.
 */
export function approvedWorkAndStored(
  l: { previousStoredCents: number; workThisPeriodCents: number; storedCents: number },
  approvedIncrementCents: number,
): { workThisPeriodCents: number; storedCents: number } {
  if (approvedIncrementCents < 0 && l.previousStoredCents === 0 && l.storedCents === 0) {
    return { storedCents: 0, workThisPeriodCents: approvedIncrementCents };
  }
  const approvedClaim = Math.max(0, approvedIncrementCents + l.previousStoredCents);
  const storedCents = Math.min(l.storedCents, approvedClaim);
  return { storedCents, workThisPeriodCents: approvedClaim - storedCents };
}

// ---- Billing periods ----------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function parseIso(s: string): Date {
  if (!isIsoDate(s)) throw new Error(`Invalid date: ${s}`);
  const m = ISO_DATE.exec(s)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 25, 2026": the app's single date format, for server-written text. */
export function formatIsoDate(iso: string): string {
  const d = parseIso(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** The first date on or after `from` that falls on `billingDay` (1-28) of its month. */
export function nextBillingDate(from: string, billingDay: number): string {
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) throw new Error(`billing day must be 1-28, got ${billingDay}`);
  const d = parseIso(from);
  if (d.getUTCDate() <= billingDay) return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), billingDay)));
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, billingDay)));
}

export type BillingPeriod = { periodStart: string; periodEnd: string; dueDate: string };

/**
 * The next billing period: it starts the day after the previous application's period end (or on the
 * project start for the first application) and ends, and is due, on the next billing day.
 */
export function nextBillingPeriod(opts: { previousPeriodEnd: string | null; firstPeriodStart: string; billingDay: number }): BillingPeriod {
  const periodStart = opts.previousPeriodEnd !== null ? addDays(opts.previousPeriodEnd, 1) : opts.firstPeriodStart;
  const periodEnd = nextBillingDate(periodStart, opts.billingDay);
  return { periodStart, periodEnd, dueDate: periodEnd };
}
