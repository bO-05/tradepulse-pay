/**
 * Pure pay-application review logic: the review context the model sees, the
 * deterministic offline rules engine, and the code that turns per-line
 * verdicts and recommended percentages into approved cents. The model never
 * authors dollar amounts; every cent here is computed by code.
 */

export { OFFLINE_RULES_ENGINE } from "../lib/aiLabels";

export const LINE_VERDICTS = ["ok", "overbilled", "excluded_scope", "front_loaded", "out_of_sequence"] as const;
export type LineVerdict = (typeof LINE_VERDICTS)[number];

/** Milestone statuses that count as finished work, and those that count as work under way. */
const DONE_MILESTONE = new Set(["complete", "paid"]);
const ACTIVE_MILESTONE = new Set(["funded", "in_progress"]);
/** An under-way milestone is credited at half its share: we know it started, not how far it got. */
const ACTIVE_MILESTONE_CREDIT = 0.5;

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
  /** Fraction 0-1: the most progress the milestone statuses support for this line. */
  milestoneCeilingPctToDate: number;
  /** Fraction 0-1: scheduled-value-weighted progress of the agreement's other base-scope lines. */
  otherLinesProgressPct: number;
  /** True when this is closeout-phase work and the milestones before Closeout are not all complete. */
  closeoutWorkBeforeEarlierMilestones: boolean;
};

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
  milestones: readonly { name: string; order: number; status: string; amountCents: number }[];
  priorPayApps: readonly {
    periodLabel: string;
    status: string;
    requestedTotalCents: number;
    approvedTotalCents: number | null;
  }[];
  license: { licenseNumber: string; status: string; checkedAt: number; summary: string } | null;
  payApp: { periodLabel: string; notes: string; lienWaiver: boolean; requestedTotalCents: number };
  lines: readonly ReviewLine[];
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

/** The most progress (fraction) the milestone statuses support for a line; 1 when no milestone covers it. */
export function milestoneCeilingFor(sovLineId: string, milestones: readonly ReviewMilestone[]): number {
  const covering = milestones.filter((m) => m.sovLineIds.includes(sovLineId));
  const total = covering.reduce((a, m) => a + m.amountCents, 0);
  if (covering.length === 0 || total <= 0) return 1;
  let earned = 0;
  for (const m of covering) {
    if (DONE_MILESTONE.has(m.status)) earned += m.amountCents;
    else if (ACTIVE_MILESTONE.has(m.status)) earned += m.amountCents * ACTIVE_MILESTONE_CREDIT;
  }
  return normalizePct(earned / total);
}

export function isCloseoutWork(description: string): boolean {
  return CLOSEOUT_WORK.test(description);
}

/** True unless every milestone before the last one (Closeout) is complete or paid. */
export function earlierMilestonesIncomplete(milestones: readonly ReviewMilestone[]): boolean {
  if (milestones.length === 0) return false;
  const lastOrder = Math.max(...milestones.map((m) => m.order));
  return milestones.some((m) => m.order < lastOrder && !DONE_MILESTONE.has(m.status));
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
  lines: readonly { sovLineId: string; pctCompleteThisPeriod: number; pctCompleteToDate: number; requestedCents: number }[];
}): ReviewLine[] {
  const byId = new Map(input.sov.map((s) => [s._id, s]));
  const submitted = new Map(input.lines.map((l) => [l.sovLineId, l]));
  const progressOf = (s: SovRowInput) => {
    const line = submitted.get(s._id);
    if (line) return clamp01(line.pctCompleteToDate / 100);
    return clamp01((input.prior.get(s._id)?.previousPctToDate ?? 0) / 100);
  };
  const closeoutBlocked = earlierMilestonesIncomplete(input.milestones);
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
      milestoneCeilingPctToDate: sov.excludedScope ? 0 : milestoneCeilingFor(sov._id, input.milestones),
      otherLinesProgressPct: normalizePct(otherProgress),
      closeoutWorkBeforeEarlierMilestones: !sov.excludedScope && closeoutBlocked && isCloseoutWork(sov.description),
    });
  }
  return out.sort((a, b) => a.lineNo - b.lineNo);
}

const pct = (f: number) => `${(Math.round(f * 1000) / 10).toString()}%`;

export function isFrontLoaded(line: ReviewLine): boolean {
  const other = line.otherLinesProgressPct;
  return (
    other > 0 &&
    line.claimedPctToDate <= line.milestoneCeilingPctToDate + 1e-9 &&
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

/** Deterministic verdicts used when no AI provider responds. Mirrors the rules the model is given. */
export function rulesEngineJudgement(context: ReviewContext): ReviewJudgement {
  const lines = context.lines.map((line) => {
    if (line.excludedScope) {
      return {
        sovLineId: line.sovLineId,
        verdict: "excluded_scope" as const,
        recommendedPctToDate: 0,
        reason: `Line ${line.lineNo} is excluded scope (from the leveled bid exclusions) and is not billable under this agreement.`,
      };
    }
    if (line.closeoutWorkBeforeEarlierMilestones && line.claimedPctThisPeriod > 0) {
      return {
        sovLineId: line.sovLineId,
        verdict: "out_of_sequence" as const,
        recommendedPctToDate: line.previousPctToDate,
        reason: `Line ${line.lineNo} is closeout-phase work billed before the earlier milestones are complete; held at the previous ${pct(line.previousPctToDate)} to date.`,
      };
    }
    if (line.claimedPctToDate > line.milestoneCeilingPctToDate + 1e-9) {
      return {
        sovLineId: line.sovLineId,
        verdict: "overbilled" as const,
        recommendedPctToDate: line.milestoneCeilingPctToDate,
        reason: `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)} complete to date, but the milestone statuses support at most ${pct(line.milestoneCeilingPctToDate)}.`,
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
      reason: `Line ${line.lineNo} claims ${pct(line.claimedPctToDate)}, within the ${pct(line.milestoneCeilingPctToDate)} the milestones support.`,
    };
  });
  const licenseIssue = licenseHasIssue(context.license);
  const flagged = lines.filter((l) => l.verdict !== "ok").length;
  const notes = [
    `${flagged} of ${lines.length} line(s) flagged by deterministic rules.`,
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
 * exceeds the milestone ceiling; no recommendation exceeds what was claimed.
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
    if (verdict === "excluded_scope") recommended = 0;
    if (verdict === "overbilled") recommended = Math.min(recommended, line.milestoneCeilingPctToDate);
    recommended = normalizePct(Math.min(recommended, line.claimedPctToDate));
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
