/**
 * Pure pay-application review logic: the review context the model sees, the
 * deterministic offline rules engine, and the code that turns per-line
 * verdicts and recommended percentages into approved cents. The model never
 * authors dollar amounts; every cent here is computed by code.
 */

import { excludedScopeClaims, type ExcludedScopeClaims } from "./excludedScope";

export { OFFLINE_RULES_ENGINE } from "../lib/aiLabels";

export const LINE_VERDICTS = ["ok", "overbilled", "excluded_scope", "front_loaded", "out_of_sequence"] as const;
export type LineVerdict = (typeof LINE_VERDICTS)[number];

/**
 * Funding tranches (the `milestones` table) are GC-defined funding buckets, not work phases. A
 * tranche's status says something about a line's progress only when the tranche lists that line in
 * `sovLineIds`. Statuses that count as finished work, and those that count as work under way:
 */
const DONE_TRANCHE = new Set(["complete", "paid"]);
const ACTIVE_TRANCHE = new Set(["funded", "in_progress"]);
/** An under-way tranche is credited at half its share: we know it started, not how far it got. */
const ACTIVE_TRANCHE_CREDIT = 0.5;

/** Front-loading threshold: well above, and at least double, the rest of the job's progress. */
const FRONT_LOAD_MIN_GAP = 0.15;
const FRONT_LOAD_MIN_RATIO = 2;

const CLOSEOUT_WORK = /\b(close-?out|commissioning|testing|o&m|operation(?:s)? (?:and|&) maintenance|as-?builts?|punch(?:\s?list)?|training|start-?up)\b/i;

export type ReviewMilestone = {
  milestoneId: string;
  name: string;
  order: number;
  status: string;
  amountCents: number;
  sovLineIds: readonly string[];
};

export type ReviewLine = {
  sovLineId: string;
  lineNo: number;
  description: string;
  excludedScope: boolean;
  scheduledValueCents: number;
  /** GC-approved cents billed to date on earlier pay apps. */
  previouslyBilledCents: number;
  /** Fraction 0-1: approved cents to date over scheduled value (never a percentage a request claimed). */
  previousPctToDate: number;
  /** Requested on earlier pay apps still awaiting a decision; not part of the baseline. */
  pendingRequestedCents: number;
  /** Fractions 0-1 as submitted on this pay app. */
  claimedPctThisPeriod: number;
  claimedPctToDate: number;
  requestedCents: number;
  /**
   * Fraction 0-1: the most progress the statuses of the funding tranches that list this line support.
   * Null when no tranche lists the line: tranche status then says nothing about it (only the 100% cap applies).
   */
  trancheCeilingPctToDate: number | null;
  /** Fraction 0-1: scheduled-value-weighted progress of the agreement's other base-scope lines. */
  otherLinesProgressPct: number;
  /** True when this is closeout-phase work and, of the tranches that list this line, an earlier one is not complete. */
  closeoutWorkBeforeEarlierTranches: boolean;
  /** The sub's note on this line (work this period or stored material), if any. */
  note?: string | null;
};

/** An SOV line with nothing billed on this pay app; code records it as "ok" at its previous percent. */
export type UnbilledReviewLine = { sovLineId: string; lineNo: number; previousPctToDate: number };

export type ReviewContext = {
  /** Company the reviewer works for; prompts fall back to "the general contractor" when absent. */
  gcCompanyName?: string | null;
  agreement: {
    agreementNumber: string;
    subcontractorName: string;
    projectTitle: string;
    csiDivision: string;
    tradeName: string;
    contractSumCents: number;
    retainagePercent: number;
    scopeSummary: string;
    mandatoryInclusions: readonly string[];
    /** The awarded bid's exclusions: "Excluded scope (not in contract)". Never SOV lines. */
    excludedScopeNotes?: readonly string[];
  };
  /** Funding tranches in order, with the line numbers each one lists (empty: covers no line). */
  tranches: readonly { name: string; order: number; status: string; amountCents: number; coversLineNos: readonly number[] }[];
  priorPayApps: readonly {
    periodLabel: string;
    status: string;
    requestedTotalCents: number;
    approvedTotalCents: number | null;
  }[];
  license: { licenseNumber: string; status: string; checkedAt: number; summary: string } | null;
  payApp: { periodLabel: string; notes: string; lienWaiver: boolean; requestedTotalCents: number };
  lines: readonly ReviewLine[];
  /** G703 lines with no billing this period. They get no model verdict; see finalizeReview. */
  unbilledLines?: readonly UnbilledReviewLine[];
};

/** What the model (or the rules engine standing in for it) returns. No dollar fields. */
export type ReviewJudgement = {
  lines: { sovLineId: string; verdict: LineVerdict; recommendedPctToDate: number; reason: string }[];
  lienWaiverMissing: boolean;
  licenseIssue: boolean;
  notes: string;
};

export type FinalReviewLine = {
  sovLineId: string;
  verdict: LineVerdict;
  recommendedPctToDate: number;
  approvedCents: number;
  reason: string;
};

export type FinalReview = {
  lines: FinalReviewLine[];
  flags: { lienWaiverMissing: boolean; licenseIssue: boolean; licenseStatus: ReviewLicenseStatus; notes: string };
  approvedTotalCents: number;
};

const KNOWN_LICENSE_STATUSES = ["active", "expired", "suspended", "inactive", "not_found", "unverified"] as const;
export type ReviewLicenseStatus = (typeof KNOWN_LICENSE_STATUSES)[number] | "none";

const LICENSE_STATUS_TEXT: Record<ReviewLicenseStatus, string> = {
  none: "no license check yet",
  active: "active (CSLB)",
  expired: "expired",
  suspended: "suspended",
  inactive: "inactive",
  not_found: "not found at CSLB",
  unverified: "unverified",
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Fractions are kept to basis points so the stored value reproduces the approved amount exactly. */
export function toBasisPoints(fraction: number): number {
  return Math.round(clamp01(fraction) * 10_000);
}

export function normalizePct(fraction: number): number {
  return toBasisPoints(fraction) / 10_000;
}

/**
 * approvedCents = clamp(round(scheduledValueCents × recommendedPctToDate) − previouslyBilledCents − pendingRequestedCents,
 * 0, requestedCents). Earlier pending requests are subtracted so two open pay apps cannot both be
 * paid for the same progress.
 * Rounding is half-up in exact integer arithmetic on the basis-point fraction.
 */
export function approvedCentsFor(input: {
  scheduledValueCents: number;
  recommendedPctToDate: number;
  previouslyBilledCents: number;
  pendingRequestedCents?: number;
  requestedCents: number;
}): number {
  const bps = BigInt(toBasisPoints(input.recommendedPctToDate));
  const earned = Number((BigInt(input.scheduledValueCents) * bps + 5_000n) / 10_000n);
  const due = earned - input.previouslyBilledCents - (input.pendingRequestedCents ?? 0);
  return Math.min(Math.max(due, 0), Math.max(0, input.requestedCents));
}

function tranchesCovering(sovLineId: string, tranches: readonly ReviewMilestone[]): ReviewMilestone[] {
  return tranches.filter((m) => m.sovLineIds.includes(sovLineId));
}

/**
 * The most progress (fraction) the statuses of the tranches that list this line support; null when
 * no tranche lists it (or the listing tranches carry no amount), so tranche status sets no ceiling.
 */
export function trancheCeilingFor(sovLineId: string, tranches: readonly ReviewMilestone[]): number | null {
  const covering = tranchesCovering(sovLineId, tranches);
  const total = covering.reduce((a, m) => a + m.amountCents, 0);
  if (covering.length === 0 || total <= 0) return null;
  let earned = 0;
  for (const m of covering) {
    if (DONE_TRANCHE.has(m.status)) earned += m.amountCents;
    else if (ACTIVE_TRANCHE.has(m.status)) earned += m.amountCents * ACTIVE_TRANCHE_CREDIT;
  }
  return normalizePct(earned / total);
}

/** The ceiling a claim is checked against: the tranche ceiling, or 100% when no tranche lists the line. */
export function effectiveCeiling(line: Pick<ReviewLine, "trancheCeilingPctToDate">): number {
  return line.trancheCeilingPctToDate ?? 1;
}

export function isCloseoutWork(description: string): boolean {
  return CLOSEOUT_WORK.test(description);
}

/** True when, among the tranches that list this line, one before the last is not complete or paid. */
export function earlierTranchesIncomplete(sovLineId: string, tranches: readonly ReviewMilestone[]): boolean {
  const covering = tranchesCovering(sovLineId, tranches);
  if (covering.length === 0) return false;
  const lastOrder = Math.max(...covering.map((m) => m.order));
  return covering.some((m) => m.order < lastOrder && !DONE_TRANCHE.has(m.status));
}

export type SovRowInput = {
  _id: string;
  lineNo: number;
  description: string;
  excludedScope: boolean;
  scheduledValueCents: number;
};

export type ReviewPrior = { previouslyBilledCents: number; previousPctToDate: number; pendingRequestedCents: number };

const NO_PRIOR: ReviewPrior = { previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0 };

/**
 * Builds the per-line review inputs for the submitted lines. `prior` is the baseline from earlier
 * pay apps (sovBaselineByLine): approved cents, approved % to date (0-100) and pending requests.
 */
export function buildReviewLines(input: {
  sov: readonly SovRowInput[];
  milestones: readonly ReviewMilestone[];
  prior: ReadonlyMap<string, ReviewPrior>;
  lines: readonly {
    sovLineId: string;
    pctCompleteThisPeriod: number;
    pctCompleteToDate: number;
    requestedCents: number;
    note?: string | null;
  }[];
}): ReviewLine[] {
  const byId = new Map(input.sov.map((s) => [s._id, s]));
  const submitted = new Map(input.lines.map((l) => [l.sovLineId, l]));
  const progressOf = (s: SovRowInput) => {
    const line = submitted.get(s._id);
    if (line) return clamp01(line.pctCompleteToDate / 100);
    return clamp01((input.prior.get(s._id)?.previousPctToDate ?? 0) / 100);
  };
  const out: ReviewLine[] = [];
  for (const line of input.lines) {
    const sov = byId.get(line.sovLineId);
    if (!sov) continue;
    const others = input.sov.filter((s) => s._id !== sov._id && !s.excludedScope);
    const otherValue = others.reduce((a, s) => a + s.scheduledValueCents, 0);
    const otherProgress =
      otherValue > 0 ? others.reduce((a, s) => a + s.scheduledValueCents * progressOf(s), 0) / otherValue : 0;
    const prior = input.prior.get(sov._id) ?? NO_PRIOR;
    out.push({
      sovLineId: sov._id,
      lineNo: sov.lineNo,
      description: sov.description,
      excludedScope: sov.excludedScope,
      scheduledValueCents: sov.scheduledValueCents,
      previouslyBilledCents: prior.previouslyBilledCents,
      previousPctToDate: normalizePct(prior.previousPctToDate / 100),
      pendingRequestedCents: prior.pendingRequestedCents,
      claimedPctThisPeriod: normalizePct(line.pctCompleteThisPeriod / 100),
      claimedPctToDate: normalizePct(line.pctCompleteToDate / 100),
      requestedCents: line.requestedCents,
      trancheCeilingPctToDate: sov.excludedScope ? 0 : trancheCeilingFor(sov._id, input.milestones),
      otherLinesProgressPct: normalizePct(otherProgress),
      closeoutWorkBeforeEarlierTranches:
        !sov.excludedScope && isCloseoutWork(sov.description) && earlierTranchesIncomplete(sov._id, input.milestones),
      ...(line.note ? { note: line.note } : {}),
    });
  }
  return out.sort((a, b) => a.lineNo - b.lineNo);
}

const pct = (f: number) => `${(Math.round(f * 1000) / 10).toString()}%`;

export function isFrontLoaded(line: ReviewLine): boolean {
  const other = line.otherLinesProgressPct;
  return (
    other > 0 &&
    line.claimedPctToDate <= effectiveCeiling(line) + 1e-9 &&
    line.claimedPctToDate >= other * FRONT_LOAD_MIN_RATIO &&
    line.claimedPctToDate - other >= FRONT_LOAD_MIN_GAP
  );
}

/** Status of the latest completed check; unknown values are treated as unverified. */
export function reviewLicenseStatus(license: ReviewContext["license"]): ReviewLicenseStatus {
  if (license === null) return "none";
  return (KNOWN_LICENSE_STATUSES as readonly string[]).includes(license.status)
    ? (license.status as ReviewLicenseStatus)
    : "unverified";
}

/** Only an active CSLB result clears the license flag; a missing or failed check is an issue. */
export function licenseHasIssue(license: ReviewContext["license"]): boolean {
  return reviewLicenseStatus(license) !== "active";
}

export function licenseStatusText(status: ReviewLicenseStatus): string {
  return LICENSE_STATUS_TEXT[status];
}

/** Lines whose own note or the pay-app notes claim work in the agreement's excluded-scope notes. */
export function contextExcludedScopeClaims(context: ReviewContext): ExcludedScopeClaims {
  return excludedScopeClaims({
    lines: context.lines.map((l) => ({
      sovLineId: l.sovLineId,
      lineNo: l.lineNo,
      description: l.description,
      note: l.note ?? null,
      requestedCents: l.requestedCents,
    })),
    payAppNotes: context.payApp.notes,
    excludedScopeNotes: context.agreement.excludedScopeNotes ?? [],
  });
}

/** Deterministic verdicts used when no AI provider responds. Mirrors the rules the model is given. */
export function rulesEngineJudgement(context: ReviewContext): ReviewJudgement {
  const claims = contextExcludedScopeClaims(context);
  const lines = context.lines.map((line) => {
    if (line.excludedScope) {
      return {
        sovLineId: line.sovLineId,
        verdict: "excluded_scope" as const,
        recommendedPctToDate: 0,
        reason: `Line ${line.lineNo} is excluded scope (from the leveled bid exclusions) and is not billable under this agreement.`,
      };
    }
    const claim = claims.byLine.get(line.sovLineId);
    if (claim !== undefined) {
      return {
        sovLineId: line.sovLineId,
        verdict: "excluded_scope" as const,
        recommendedPctToDate: line.previousPctToDate,
        reason: `Line ${line.lineNo} bills work the agreement lists as excluded scope (not in contract): "${claim}". That work is not billable under this agreement.`,
      };
    }
    if (line.closeoutWorkBeforeEarlierTranches && line.claimedPctThisPeriod > 0) {
      return {
        sovLineId: line.sovLineId,
        verdict: "out_of_sequence" as const,
        recommendedPctToDate: line.previousPctToDate,
        reason: `Line ${line.lineNo} is closeout-phase work billed before the earlier funding tranches that cover it are complete; held at the previous ${pct(line.previousPctToDate)} to date.`,
      };
    }
    const ceiling = line.trancheCeilingPctToDate;
    if (ceiling !== null && line.claimedPctToDate > ceiling + 1e-9) {
      return {
        sovLineId: line.sovLineId,
        verdict: "overbilled" as const,
        recommendedPctToDate: ceiling,
        reason: `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)} complete to date, but the funding-tranche statuses that cover this line support at most ${pct(ceiling)}.`,
      };
    }
    if (isFrontLoaded(line)) {
      const recommended = Math.max(line.previousPctToDate, line.otherLinesProgressPct);
      return {
        sovLineId: line.sovLineId,
        verdict: "front_loaded" as const,
        recommendedPctToDate: Math.min(recommended, line.claimedPctToDate),
        reason: `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)} while the rest of the job is at ${pct(line.otherLinesProgressPct)}; reduced to the job-wide progress.`,
      };
    }
    return {
      sovLineId: line.sovLineId,
      verdict: "ok" as const,
      recommendedPctToDate: line.claimedPctToDate,
      reason:
        ceiling === null
          ? `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)}; no funding tranche covers this line, so tranche status sets no ceiling.`
          : `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)}, within the ${pct(ceiling)} the covering funding tranches support.`,
    };
  });
  const licenseIssue = licenseHasIssue(context.license);
  const flagged = lines.filter((l) => l.verdict !== "ok").length;
  const notes = [
    `${flagged} of ${lines.length} line(s) flagged by deterministic rules.`,
    ...claims.unattributed.map(
      (u) => `The pay-app notes mention excluded scope ("${u.note}") without naming a line; confirm before approving.`,
    ),
    context.payApp.lienWaiver ? "" : "Lien waiver missing.",
    licenseIssue ? `License: ${licenseStatusText(reviewLicenseStatus(context.license))}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { lines, lienWaiverMissing: !context.payApp.lienWaiver, licenseIssue, notes };
}

export class IncompleteJudgementError extends Error {
  override name = "IncompleteJudgementError";
}

/**
 * Applies code policy to a judgement and computes every dollar figure.
 * Requires exactly one verdict per submitted line. Excluded-scope SOV lines are
 * always "excluded_scope" with 0 approved; an "overbilled" recommendation never
 * exceeds the tranche ceiling of a covered line; no recommendation exceeds what was claimed.
 * The lien-waiver and license flags are decided by code, never by the model:
 * the license flag is set unless the latest completed check is active.
 */
export function finalizeReview(context: ReviewContext, judgement: ReviewJudgement): FinalReview {
  const verdicts = new Map<string, ReviewJudgement["lines"][number]>();
  for (const l of judgement.lines) {
    if (!verdicts.has(l.sovLineId)) verdicts.set(l.sovLineId, l);
  }
  const missing = context.lines.filter((l) => !verdicts.has(l.sovLineId));
  if (missing.length > 0) {
    throw new IncompleteJudgementError(`No verdict for line(s) ${missing.map((l) => l.lineNo).join(", ")}.`);
  }
  const lines: FinalReviewLine[] = context.lines.map((line) => {
    const j = verdicts.get(line.sovLineId)!;
    let verdict: LineVerdict = (LINE_VERDICTS as readonly string[]).includes(j.verdict) ? j.verdict : "ok";
    let reason = j.reason.trim() || "No reason given.";
    if (line.excludedScope && verdict !== "excluded_scope") {
      verdict = "excluded_scope";
      reason = `Excluded scope per the leveled bid. ${reason}`;
    }
    let recommended = normalizePct(j.recommendedPctToDate);
    // Excluded work earns nothing: an excluded SOV line stays at 0%, any other line at its previous percent.
    if (verdict === "excluded_scope") recommended = line.excludedScope ? 0 : line.previousPctToDate;
    if (verdict === "overbilled") recommended = Math.min(recommended, effectiveCeiling(line));
    recommended = Math.min(recommended, line.claimedPctToDate);
    // Work certified on earlier applications stays earned, so the percent to date never drops below it.
    if (!line.excludedScope) recommended = Math.max(recommended, line.previousPctToDate);
    recommended = normalizePct(recommended);
    const approvedCents =
      verdict === "excluded_scope"
        ? 0
        : approvedCentsFor({
            scheduledValueCents: line.scheduledValueCents,
            recommendedPctToDate: recommended,
            previouslyBilledCents: line.previouslyBilledCents,
            pendingRequestedCents: line.pendingRequestedCents,
            requestedCents: line.requestedCents,
          });
    return { sovLineId: line.sovLineId, verdict, recommendedPctToDate: recommended, approvedCents, reason };
  });
  const lineNo = new Map<string, number>(context.lines.map((l) => [l.sovLineId, l.lineNo]));
  for (const u of context.unbilledLines ?? []) {
    if (lineNo.has(u.sovLineId)) continue;
    lineNo.set(u.sovLineId, u.lineNo);
    lines.push({
      sovLineId: u.sovLineId,
      verdict: "ok",
      recommendedPctToDate: normalizePct(u.previousPctToDate),
      approvedCents: 0,
      reason: `Nothing billed on line ${u.lineNo} this period.`,
    });
  }
  lines.sort((a, b) => (lineNo.get(a.sovLineId) ?? 0) - (lineNo.get(b.sovLineId) ?? 0));
  return {
    lines,
    flags: {
      lienWaiverMissing: !context.payApp.lienWaiver,
      licenseIssue: licenseHasIssue(context.license),
      licenseStatus: reviewLicenseStatus(context.license),
      notes: judgement.notes.trim(),
    },
    approvedTotalCents: lines.reduce((a, l) => a + l.approvedCents, 0),
  };
}
