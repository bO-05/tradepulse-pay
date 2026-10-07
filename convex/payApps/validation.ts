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
  /** Approved billing to date (see sovBaselineByLine). */
  previouslyBilledCents: number;
  /** Requested on earlier pay apps that are still open; counts against what remains. */
  pendingRequestedCents: number;
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
  finalApproval?: { lines: readonly { sovLineId: string; approvedCents: number }[] } | null;
};

export const APPROVED_PAY_APP_STATUSES = new Set(["approved", "paid"]);

export const MISSING_FINAL_APPROVAL =
  "An approved pay application has no recorded final GC-approved amount, so billed-to-date cannot be computed.";

/**
 * Total billed by an approved or paid pay app: only the GC's final approved total. The review's
 * recommendation is never a substitute, because the GC may have edited it. Throws without one;
 * billingHistory.ts rebuilds legacy approvals from the GC's decision before rows get here.
 */
export function approvedTotalFor(app: { finalApproval?: { totalCents: number } | null }): number {
  if (!app.finalApproval) throw new Error(MISSING_FINAL_APPROVAL);
  return app.finalApproval.totalCents;
}

export type PriorBillingLine = {
  /** Final GC-approved cents of approved or paid pay apps: the billed-to-date baseline. */
  approvedCents: number;
  /** Requested cents of pay apps still awaiting a decision; reserved, never part of the baseline. */
  pendingRequestedCents: number;
};

const NO_PRIOR_BILLING: PriorBillingLine = { approvedCents: 0, pendingRequestedCents: 0 };

/**
 * Per SOV line: the final approved cents of approved or paid pay apps, and the requested cents of
 * pay apps still open. Withdrawn and rejected apps count for nothing. An approved app without a final
 * allocation throws, unless `unresolvedApprovedAs: "requested"` asks for its requested cents as a
 * conservative upper bound (counted as pending, so it limits what remains but is not a baseline).
 */
export function priorBillingByLine(
  payApps: readonly PriorPayApp[],
  opts: { unresolvedApprovedAs?: "throw" | "requested" } = {},
): Map<string, PriorBillingLine> {
  const out = new Map<string, PriorBillingLine>();
  for (const app of payApps) {
    if (!BILLING_PAY_APP_STATUSES.has(app.status)) continue;
    const isApproved = APPROVED_PAY_APP_STATUSES.has(app.status);
    if (isApproved && !app.finalApproval && opts.unresolvedApprovedAs !== "requested") throw new Error(MISSING_FINAL_APPROVAL);
    const useApproved = isApproved && !!app.finalApproval;
    const approved = new Map((app.finalApproval?.lines ?? []).map((l) => [l.sovLineId, l.approvedCents]));
    for (const line of app.lines) {
      const prev = out.get(line.sovLineId) ?? NO_PRIOR_BILLING;
      out.set(
        line.sovLineId,
        useApproved
          ? { ...prev, approvedCents: prev.approvedCents + (approved.get(line.sovLineId) ?? 0) }
          : { ...prev, pendingRequestedCents: prev.pendingRequestedCents + line.requestedCents },
      );
    }
  }
  return out;
}

/** Cents a line's earlier pay apps hold against its scheduled value: approved plus still pending. */
export function committedCents(prior: PriorBillingLine | undefined): number {
  return prior ? prior.approvedCents + prior.pendingRequestedCents : 0;
}

/** Approved cents as a percent (0-100, two decimals) of the line's scheduled value. */
export function approvedPctToDate(approvedCents: number, scheduledValueCents: number): number {
  if (scheduledValueCents <= 0 || approvedCents <= 0) return 0;
  const hundredths = Math.min(10_000, Math.round((approvedCents * 10_000) / scheduledValueCents));
  return hundredths / 100;
}

export type SovBaseline = {
  previouslyBilledCents: number;
  previousPctToDate: number;
  pendingRequestedCents: number;
  remainingCents: number;
};

/**
 * The one previous-to-date baseline per SOV line shared by the sub portal form, submit validation
 * and the AI review: approved billing only. Pending requests reduce what remains but never raise
 * the baseline, and the percent comes from approved cents, not from any percentage a request claimed.
 */
export function sovBaselineByLine(
  payApps: readonly PriorPayApp[],
  sov: readonly { _id: string; scheduledValueCents: number }[],
): Map<string, SovBaseline> {
  const prior = priorBillingByLine(payApps);
  return new Map(
    sov.map((s) => {
      const p = prior.get(s._id) ?? NO_PRIOR_BILLING;
      return [
        s._id,
        {
          previouslyBilledCents: p.approvedCents,
          previousPctToDate: approvedPctToDate(p.approvedCents, s.scheduledValueCents),
          pendingRequestedCents: p.pendingRequestedCents,
          remainingCents: Math.max(0, s.scheduledValueCents - committedCents(p)),
        },
      ];
    }),
  );
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
      const remaining = Math.max(
        0,
        sovLine.scheduledValueCents - sovLine.previouslyBilledCents - sovLine.pendingRequestedCents,
      );
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
