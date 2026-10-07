/**
 * Pure pay-application rules shared by the submit mutation and the sub portal
 * form, so the browser shows the same errors the backend enforces.
 */
import { formatCents } from "../lib/money";

export type PayAppLineInput = {
  sovLineId: string;
  pctCompleteThisPeriod: number;
  pctCompleteToDate: number;
  requestedCents: number;
};

export type SovLineContext = {
  _id: string;
  lineNo: number;
  description: string;
  scheduledValueCents: number;
  previouslyBilledCents: number;
};

export type PayAppFieldError = { field: string; message: string };

export const MAX_PERIOD_LABEL_LENGTH = 100;
export const MAX_NOTES_LENGTH = 4000;

/** Pay apps in these states count against a line's remaining scheduled value. */
export const BILLING_PAY_APP_STATUSES = new Set(["submitted", "under_review", "reviewed", "approved", "paid"]);
export const WITHDRAWABLE_PAY_APP_STATUSES = new Set(["submitted", "under_review"]);

type PriorPayApp = {
  status: string;
  lines: readonly { sovLineId: string; requestedCents: number; pctCompleteToDate: number }[];
  review?: { lines: readonly { sovLineId: string; approvedCents: number }[] } | null;
  finalApproval?: { lines: readonly { sovLineId: string; approvedCents: number }[] } | null;
};

/** The per-line cents an approved pay app bills: the GC's final allocation, else the review recommendation. */
function approvedLinesFor(app: PriorPayApp) {
  return app.finalApproval?.lines ?? app.review?.lines ?? null;
}

/** Total billed by an approved or paid pay app: the GC's final total, else the review's, else the request. */
export function approvedTotalFor(app: {
  requestedTotalCents: number;
  review?: { approvedTotalCents: number } | null;
  finalApproval?: { totalCents: number } | null;
}): number {
  return app.finalApproval?.totalCents ?? app.review?.approvedTotalCents ?? app.requestedTotalCents;
}

/**
 * Per SOV line: cents already billed by open or approved pay apps (the final
 * approved cents once an app is approved) and the highest % to date claimed.
 */
export function priorBillingByLine(payApps: readonly PriorPayApp[]): Map<string, { billedCents: number; pctToDate: number }> {
  const out = new Map<string, { billedCents: number; pctToDate: number }>();
  for (const app of payApps) {
    if (!BILLING_PAY_APP_STATUSES.has(app.status)) continue;
    const approvedLines = approvedLinesFor(app);
    const useApproved = (app.status === "approved" || app.status === "paid") && approvedLines !== null;
    const approved = new Map((approvedLines ?? []).map((l) => [l.sovLineId, l.approvedCents]));
    for (const line of app.lines) {
      const cents = useApproved ? (approved.get(line.sovLineId) ?? 0) : line.requestedCents;
      const prev = out.get(line.sovLineId) ?? { billedCents: 0, pctToDate: 0 };
      out.set(line.sovLineId, {
        billedCents: prev.billedCents + cents,
        pctToDate: Math.max(prev.pctToDate, line.pctCompleteToDate),
      });
    }
  }
  return out;
}

function isPercent(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * Checks a pay application against the agreement's SOV. Returns the lines to
 * store (all-zero lines dropped), their integer-cent total and every error found.
 */
export function validatePayApp(
  input: { periodLabel: string; notes: string; lines: readonly PayAppLineInput[] },
  sov: readonly SovLineContext[],
): { errors: PayAppFieldError[]; lines: PayAppLineInput[]; requestedTotalCents: number } {
  const errors: PayAppFieldError[] = [];
  const period = input.periodLabel.trim();
  if (period === "") errors.push({ field: "periodLabel", message: "Period label is required." });
  else if (period.length > MAX_PERIOD_LABEL_LENGTH) {
    errors.push({ field: "periodLabel", message: `Period label must be at most ${MAX_PERIOD_LABEL_LENGTH} characters.` });
  }
  if (input.notes.length > MAX_NOTES_LENGTH) {
    errors.push({ field: "notes", message: `Notes must be at most ${MAX_NOTES_LENGTH} characters.` });
  }

  const byId = new Map(sov.map((s) => [s._id, s]));
  const seen = new Set<string>();
  const kept: PayAppLineInput[] = [];
  for (const line of input.lines) {
    const sovLine = byId.get(line.sovLineId);
    if (sovLine === undefined) {
      errors.push({ field: "lines", message: "A line does not belong to this agreement's schedule of values." });
      continue;
    }
    const label = `Line ${sovLine.lineNo} (${sovLine.description})`;
    const field = `line:${line.sovLineId}`;
    if (seen.has(line.sovLineId)) {
      errors.push({ field, message: `${label} appears more than once.` });
      continue;
    }
    seen.add(line.sovLineId);
    let ok = true;
    if (!isPercent(line.pctCompleteThisPeriod)) {
      errors.push({ field, message: `${label}: % complete this period must be between 0 and 100.` });
      ok = false;
    }
    if (!isPercent(line.pctCompleteToDate)) {
      errors.push({ field, message: `${label}: % complete to date must be between 0 and 100.` });
      ok = false;
    }
    if (ok && line.pctCompleteToDate < line.pctCompleteThisPeriod) {
      errors.push({ field, message: `${label}: % complete to date cannot be less than % complete this period.` });
      ok = false;
    }
    if (!Number.isSafeInteger(line.requestedCents)) {
      errors.push({ field, message: `${label}: requested amount must be a whole number of cents.` });
      ok = false;
    } else if (line.requestedCents < 0) {
      errors.push({ field, message: `${label}: requested amount cannot be negative.` });
      ok = false;
    } else {
      const remaining = Math.max(0, sovLine.scheduledValueCents - sovLine.previouslyBilledCents);
      if (line.requestedCents > remaining) {
        errors.push({
          field,
          message: `${label}: requested amount exceeds the remaining scheduled value of ${formatCents(remaining)}.`,
        });
        ok = false;
      }
    }
    if (ok && (line.requestedCents > 0 || line.pctCompleteThisPeriod > 0 || line.pctCompleteToDate > 0)) {
      kept.push({ ...line });
    }
  }
  if (!kept.some((l) => l.requestedCents > 0) && !errors.some((e) => e.field.startsWith("line"))) {
    errors.push({ field: "lines", message: "Enter a requested amount on at least one line." });
  }
  const requestedTotalCents = kept.reduce((acc, l) => acc + l.requestedCents, 0);
  return { errors, lines: kept, requestedTotalCents };
}
