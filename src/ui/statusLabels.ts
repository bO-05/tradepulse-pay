/**
 * The single status-code -> human label + color map. Screens never render a raw status code; they
 * pass it to <StatusPill> or `statusLabel()`. `statusLabels.test.ts` fails when convex/schema.ts
 * gains a status literal that is missing here.
 */

export type StatusTone = "neutral" | "info" | "progress" | "success" | "warning" | "danger" | "muted";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

export const STATUS_LABELS = {
  // Generic lifecycle
  draft: { label: "Draft", tone: "neutral" },
  pending: { label: "Pending", tone: "warning" },
  created: { label: "Created", tone: "neutral" },
  active: { label: "Active", tone: "success" },
  inactive: { label: "Inactive", tone: "muted" },
  merged: { label: "Merged", tone: "muted" },
  linked: { label: "Linked", tone: "info" },

  // Payee control (vendor payout email)
  payee_pending: { label: "Payee change pending", tone: "warning" },
  payee_confirmed: { label: "Payee confirmed", tone: "success" },
  payee_none: { label: "No payout email", tone: "muted" },
  payee_awaiting_gc: { label: "Pending GC confirmation", tone: "warning" },
  removed: { label: "Removed", tone: "muted" },
  archived: { label: "Archived", tone: "muted" },
  closed: { label: "Closed", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
  void: { label: "Void", tone: "muted" },
  failed: { label: "Failed", tone: "danger" },
  succeeded: { label: "Succeeded", tone: "success" },
  success: { label: "Paid out", tone: "success" },
  indeterminate: { label: "Outcome unknown", tone: "warning" },
  running: { label: "Running", tone: "progress" },
  done: { label: "Done", tone: "success" },
  none: { label: "Not checked", tone: "muted" },
  ok: { label: "OK", tone: "success" },
  PASS: { label: "Pass", tone: "success" },
  FAIL: { label: "Fail", tone: "danger" },

  // Invites and email
  accepted: { label: "Accepted", tone: "success" },
  revoked: { label: "Revoked", tone: "muted" },
  expired: { label: "Expired", tone: "danger" },
  sent: { label: "Sent", tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  bounced: { label: "Bounced", tone: "danger" },
  replied: { label: "Replied", tone: "success" },
  not_sent: { label: "Email not sent", tone: "muted" },
  skipped_budget: { label: "Email not sent (daily limit)", tone: "warning" },
  uncertain: { label: "Email unconfirmed", tone: "warning" },
  delivery_failed: { label: "Email not delivered", tone: "danger" },
  unrouted: { label: "Unrouted", tone: "muted" },

  // Funding tranches / milestones
  planned: { label: "Planned", tone: "neutral" },
  funding: { label: "Funding", tone: "progress" },
  funded: { label: "Funded", tone: "success" },
  funding_expired: { label: "Funding expired", tone: "danger" },
  in_progress: { label: "In progress", tone: "progress" },
  complete: { label: "Complete", tone: "success" },
  paid: { label: "Paid", tone: "success" },

  // Pay applications
  submitted: { label: "Submitted", tone: "info" },
  under_review: { label: "Under review", tone: "progress" },
  reviewed: { label: "Reviewed", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  approved_as_noted: { label: "Approved as noted", tone: "success" },
  revision_requested: { label: "Revision requested", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "muted" },

  // Payout proposals
  executed: { label: "Executed", tone: "success" },
  capture: { label: "Capture", tone: "info" },
  payout: { label: "Payout", tone: "info" },
  retainage_release: { label: "Retainage release", tone: "info" },
  reschedule: { label: "Reschedule", tone: "neutral" },
  hold: { label: "Hold", tone: "warning" },

  // PayPal payments (funding and payout lifecycles)
  authorized: { label: "Authorized", tone: "info" },
  partially_captured: { label: "Partially captured", tone: "progress" },
  captured: { label: "Captured", tone: "success" },
  voided: { label: "Voided", tone: "muted" },
  capture_pending: { label: "Capture pending", tone: "progress" },
  unclaimed: { label: "Unclaimed by recipient", tone: "warning" },
  returned: { label: "Returned", tone: "danger" },
  denied: { label: "Denied", tone: "danger" },

  // Change orders
  invoiced: { label: "Invoiced", tone: "info" },

  // Licenses and compliance
  suspended: { label: "Suspended", tone: "danger" },
  not_found: { label: "Not found", tone: "danger" },
  unverified: { label: "Unverified", tone: "warning" },
  pending_review: { label: "Pending review", tone: "warning" },
  compliant: { label: "Compliant", tone: "success" },
  expiring: { label: "Expiring soon", tone: "warning" },
  missing: { label: "Missing", tone: "danger" },
  deficiency_detected: { label: "Deficiency found", tone: "danger" },
  cslb_live: { label: "CSLB lookup", tone: "info" },
  manual: { label: "Manual record", tone: "neutral" },

  // Lien waivers
  requested: { label: "Requested", tone: "warning" },
  signed: { label: "Signed", tone: "success" },
  conditional_progress: { label: "Conditional progress", tone: "neutral" },
  unconditional_progress: { label: "Unconditional progress", tone: "neutral" },
  conditional_final: { label: "Conditional final", tone: "neutral" },
  unconditional_final: { label: "Unconditional final", tone: "neutral" },

  // AI review line verdicts
  overbilled: { label: "Overbilled", tone: "danger" },
  excluded_scope: { label: "Excluded scope", tone: "danger" },
  front_loaded: { label: "Front-loaded", tone: "warning" },
  out_of_sequence: { label: "Out of sequence", tone: "warning" },

  // Procurement (trade packages, bidders, RFIs, agreements, scope gaps)
  rfqs_dispatched: { label: "RFQs sent", tone: "info" },
  leveling: { label: "Leveling", tone: "progress" },
  awarded: { label: "Awarded", tone: "success" },
  discovered: { label: "Discovered", tone: "neutral" },
  invited: { label: "Invited", tone: "info" },
  rfi_submitted: { label: "RFI submitted", tone: "info" },
  bid_received: { label: "Bid received", tone: "success" },
  pending_analysis: { label: "Awaiting analysis", tone: "progress" },
  clarified: { label: "Clarified", tone: "success" },
  escalated_to_pm: { label: "Escalated to PM", tone: "warning" },
  failed_analysis: { label: "Analysis failed", tone: "danger" },
  generated: { label: "Generated", tone: "info" },
  deducted: { label: "Deducted", tone: "warning" },
  assigned: { label: "Assigned", tone: "info" },

  // PayPal raw codes that can surface from payouts and invoices
  UNCLAIMED: { label: "Unclaimed by recipient", tone: "warning" },
  RECEIVER_UNREGISTERED: { label: "Recipient has no PayPal account yet", tone: "warning" },
  PENDING: { label: "Pending at PayPal", tone: "warning" },
  SUCCESS: { label: "Paid out", tone: "success" },
  COMPLETED: { label: "Completed", tone: "success" },
  DENIED: { label: "Denied by PayPal", tone: "danger" },
  FAILED: { label: "Failed at PayPal", tone: "danger" },
  RETURNED: { label: "Returned", tone: "danger" },
  BLOCKED: { label: "Blocked by PayPal", tone: "danger" },
  ONHOLD: { label: "On hold at PayPal", tone: "warning" },
  REFUNDED: { label: "Refunded", tone: "muted" },
  REVERSED: { label: "Reversed", tone: "danger" },
  SENT: { label: "Invoice sent", tone: "info" },
  PAID: { label: "Paid", tone: "success" },
  MARKED_AS_PAID: { label: "Marked as paid", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  DRAFT: { label: "Draft", tone: "neutral" },
  SCHEDULED: { label: "Scheduled", tone: "info" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "progress" },
  UNPAID: { label: "Unpaid", tone: "warning" },
} as const satisfies Record<string, StatusMeta>;

export type StatusCode = keyof typeof STATUS_LABELS;

export function isKnownStatus(code: string): code is StatusCode {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, code);
}

/** Last-resort label for an unmapped code so a raw `snake_case` token is never shown. */
export function humanizeStatus(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function statusMeta(code: string | null | undefined): StatusMeta {
  if (!code) return { label: "Unknown", tone: "muted" };
  if (isKnownStatus(code)) return STATUS_LABELS[code];
  return { label: humanizeStatus(code), tone: "neutral" };
}

export function statusLabel(code: string | null | undefined): string {
  return statusMeta(code).label;
}

/** Background/text/border classes per tone; each pair meets 4.5:1 on the dark surfaces. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-slate-800 text-slate-200 border-slate-600",
  info: "bg-sky-950 text-sky-200 border-sky-800",
  progress: "bg-indigo-950 text-indigo-200 border-indigo-800",
  success: "bg-emerald-950 text-emerald-200 border-emerald-800",
  warning: "bg-amber-950 text-amber-200 border-amber-800",
  danger: "bg-rose-950 text-rose-200 border-rose-800",
  muted: "bg-slate-900 text-slate-300 border-slate-700",
};
