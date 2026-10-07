import { ConvexError } from "convex/values";

/**
 * Pure transition tables for payments and milestones (architecture §4).
 * funding: created → approved → authorized → (partially_captured) → captured | voided | expired | failed
 * payout / retainage_release: created → pending → success | failed | unclaimed | returned
 * A payout whose capture PayPal reports PENDING waits in capture_pending: back to created (then paid)
 * when the capture completes, or failed when it is denied.
 */

export type PaymentKind = "funding" | "payout" | "retainage_release";
export type FundingStatus =
  | "created"
  | "approved"
  | "authorized"
  | "partially_captured"
  | "captured"
  | "voided"
  | "expired"
  | "failed";
export type PayoutStatus = "created" | "capture_pending" | "pending" | "success" | "failed" | "unclaimed" | "returned";
export type PaymentStatus = FundingStatus | PayoutStatus;

export type MilestoneStatus = "planned" | "funding" | "funded" | "funding_expired" | "in_progress" | "complete" | "paid";

const FUNDING: Record<FundingStatus, readonly FundingStatus[]> = {
  created: ["approved", "failed", "expired"],
  approved: ["authorized", "failed", "expired"],
  // A further partial capture keeps the status at partially_captured.
  authorized: ["partially_captured", "captured", "voided", "expired"],
  partially_captured: ["partially_captured", "captured", "voided", "expired"],
  captured: [],
  voided: [],
  expired: [],
  failed: [],
};

const PAYOUT: Record<PayoutStatus, readonly PayoutStatus[]> = {
  created: ["pending", "failed", "capture_pending"],
  capture_pending: ["created", "failed"],
  pending: ["success", "failed", "unclaimed", "returned"],
  // An unclaimed item is either claimed later, returned after 30 days, or cancelled.
  unclaimed: ["success", "returned", "failed"],
  success: [],
  failed: [],
  returned: [],
};

const MILESTONE: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  planned: ["funding"],
  // Back to planned when the funding attempt fails or is abandoned.
  funding: ["funded", "planned"],
  funded: ["in_progress", "complete", "paid", "funding_expired"],
  funding_expired: ["funding", "planned"],
  in_progress: ["complete", "paid"],
  complete: ["paid"],
  paid: [],
};

function tableFor(kind: PaymentKind): Record<string, readonly string[]> {
  return kind === "funding" ? FUNDING : PAYOUT;
}

export function isPaymentStatusOf(kind: PaymentKind, status: string): boolean {
  return Object.prototype.hasOwnProperty.call(tableFor(kind), status);
}

export function canTransitionPayment(kind: PaymentKind, from: string, to: string): boolean {
  const table = tableFor(kind);
  if (!isPaymentStatusOf(kind, from) || !isPaymentStatusOf(kind, to)) return false;
  return table[from].includes(to);
}

export function isTerminalPaymentStatus(kind: PaymentKind, status: string): boolean {
  return isPaymentStatusOf(kind, status) && tableFor(kind)[status].length === 0;
}

/** Throws a ConvexError (code ILLEGAL_TRANSITION) unless `from → to` is legal for `kind`. */
export function assertPaymentTransition(kind: PaymentKind, from: string, to: string): void {
  if (!canTransitionPayment(kind, from, to)) {
    throw new ConvexError({
      code: "ILLEGAL_TRANSITION",
      message: `Illegal ${kind} payment transition: ${from} → ${to}.`,
    });
  }
}

export function canTransitionMilestone(from: string, to: string): boolean {
  const table = MILESTONE as Record<string, readonly string[]>;
  if (!Object.prototype.hasOwnProperty.call(table, from)) return false;
  return table[from].includes(to);
}

export function assertMilestoneTransition(from: string, to: string): void {
  if (!canTransitionMilestone(from, to)) {
    throw new ConvexError({ code: "ILLEGAL_TRANSITION", message: `Illegal milestone transition: ${from} → ${to}.` });
  }
}

/** Funding statuses at or past a successful authorization (the milestone is funded or was drawn on). */
export const FUNDED_FUNDING_STATUSES: readonly FundingStatus[] = ["authorized", "partially_captured", "captured"];
