/**
 * Pure planning for the pay agent's proposals. Every amount here is computed by code from the stored
 * review (approved cents per line) and the agreement terms; the model only chooses which proposals to
 * make and writes their rationale.
 */
import { computePayoutSplit, remainingAuthorizedCents } from "../payments/payoutMath";

export type PlanLicenseStatus = "active" | "expired" | "suspended" | "inactive" | "not_found" | "unverified" | "none";

export type PlanMilestone = {
  milestoneId: string;
  name: string;
  order: number;
  status: string;
  sovLineIds: readonly string[];
  /** The funded authorization behind the milestone, when it can still be captured. */
  funding: { status: string; grossCents: number; capturedCents: number } | null;
};

export type PlanInput = {
  requestedTotalCents: number;
  lienWaiver: boolean;
  approvedTotalCents: number;
  lines: readonly { sovLineId: string; verdict: string; approvedCents: number; requestedCents: number }[];
  milestones: readonly PlanMilestone[];
  retainagePercent: number;
  licenseStatus: PlanLicenseStatus;
};

export type ProposalPlan = {
  approvedTotalCents: number;
  /** Funded milestone to capture from, or null when none can cover the approved total. */
  captureMilestoneId: string | null;
  captureMilestoneName: string | null;
  /** Shared review flags (verdicts, lien waiver, license, reductions). */
  reviewFlags: string[];
  captureFlags: string[];
  payoutFlags: string[];
  payoutSplit: { grossCents: number; retainageCents: number; netCents: number } | null;
  licenseHold: boolean;
  /** Reasons a hold proposal is required (license not active, nothing approvable). */
  holdReasons: string[];
  /** Lines billed out of sequence or front-loaded, which call for a reschedule. */
  rescheduleLineIds: string[];
};

const CAPTURABLE = new Set(["authorized", "partially_captured"]);

export const LICENSE_STATUS_TEXT: Record<PlanLicenseStatus, string> = {
  active: "active at CSLB",
  expired: "expired at CSLB",
  suspended: "suspended at CSLB",
  inactive: "inactive at CSLB",
  not_found: "not found at CSLB",
  unverified: "unverified (the CSLB lookup did not complete)",
  none: "not checked",
};

export function licenseFlag(status: PlanLicenseStatus): string | null {
  return status === "active" ? null : `license_${status}`;
}

/** The milestone a capture comes from: the earliest capturable one covering the billed lines, then any capturable one. */
export function chooseCaptureMilestone(
  milestones: readonly PlanMilestone[],
  billedLineIds: readonly string[],
  amountCents: number,
): PlanMilestone | null {
  const capturable = milestones
    .filter((m) => m.funding !== null && CAPTURABLE.has(m.funding.status))
    .filter((m) => remainingAuthorizedCents(m.funding!) >= amountCents)
    .sort((a, b) => a.order - b.order);
  const covering = capturable.find((m) => m.sovLineIds.some((id) => billedLineIds.includes(id)));
  return covering ?? capturable[0] ?? null;
}

export function planProposals(input: PlanInput): ProposalPlan {
  const approved = Math.max(0, input.approvedTotalCents);
  const verdictCount = (v: string) => input.lines.filter((l) => l.verdict === v).length;
  const reviewFlags: string[] = [];
  for (const [verdict, flag] of [
    ["overbilled", "overbilled_lines"],
    ["excluded_scope", "excluded_scope_lines"],
    ["front_loaded", "front_loaded_lines"],
    ["out_of_sequence", "out_of_sequence_lines"],
  ] as const) {
    if (verdictCount(verdict) > 0) reviewFlags.push(flag);
  }
  if (!input.lienWaiver) reviewFlags.push("lien_waiver_missing");
  if (approved < input.requestedTotalCents) reviewFlags.push("reduced_from_request");
  const lf = licenseFlag(input.licenseStatus);
  if (lf) reviewFlags.push(lf);

  const licenseHold = input.licenseStatus !== "active";
  const billedLineIds = input.lines.filter((l) => l.approvedCents > 0).map((l) => l.sovLineId);
  const milestone = approved > 0 ? chooseCaptureMilestone(input.milestones, billedLineIds, approved) : null;
  const anyFunded = input.milestones.some((m) => m.funding !== null && CAPTURABLE.has(m.funding.status));

  const captureFlags = [...reviewFlags];
  const payoutFlags = [...reviewFlags];
  if (approved > 0 && milestone === null) {
    const fundingFlag = anyFunded ? "exceeds_remaining_authorization" : "milestone_not_funded";
    captureFlags.push(fundingFlag);
    payoutFlags.push(fundingFlag);
  }
  if (licenseHold) payoutFlags.push("license_hold");

  const holdReasons: string[] = [];
  if (licenseHold) holdReasons.push(`The contractor's license is ${LICENSE_STATUS_TEXT[input.licenseStatus]}.`);
  if (approved === 0) holdReasons.push("The review approved nothing on this pay application.");

  return {
    approvedTotalCents: approved,
    captureMilestoneId: milestone?.milestoneId ?? null,
    captureMilestoneName: milestone?.name ?? null,
    reviewFlags,
    captureFlags,
    payoutFlags,
    payoutSplit: approved > 0 ? computePayoutSplit(approved, input.retainagePercent) : null,
    licenseHold,
    holdReasons,
    rescheduleLineIds: input.lines
      .filter((l) => l.verdict === "out_of_sequence" || l.verdict === "front_loaded")
      .map((l) => l.sovLineId),
  };
}

/** Proposal kinds the plan requires, so the agent run can fill in any the model skipped. */
export function requiredKinds(plan: ProposalPlan): Array<"capture" | "payout" | "hold" | "reschedule"> {
  const kinds: Array<"capture" | "payout" | "hold" | "reschedule"> = [];
  if (plan.approvedTotalCents > 0) kinds.push("capture", "payout");
  if (plan.holdReasons.length > 0) kinds.push("hold");
  if (plan.rescheduleLineIds.length > 0) kinds.push("reschedule");
  return kinds;
}

export type AmountCheck = { ok: true; amountCents: number } | { ok: false; message: string };

/** A GC-edited proposal amount: whole cents, above zero, and no more than the pay app requested. */
export function checkEditedAmount(amountCents: number, requestedTotalCents: number): AmountCheck {
  if (!Number.isSafeInteger(amountCents)) return { ok: false, message: "The amount must be a whole number of cents." };
  if (amountCents < 0) return { ok: false, message: "The amount cannot be negative." };
  if (amountCents === 0) return { ok: false, message: "The amount must be above $0.00. Reject the proposal to pay nothing." };
  if (amountCents > requestedTotalCents) {
    return { ok: false, message: "The amount cannot exceed what the pay application requested." };
  }
  return { ok: true, amountCents };
}

/** The amount a proposal moves when executed: the GC's edit if any, else the code-computed amount. */
export function effectiveAmount(p: { amountCents?: number; editedAmountCents?: number }): number | undefined {
  return p.editedAmountCents ?? p.amountCents;
}
