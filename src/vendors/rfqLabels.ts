import type { StatusTone } from "../ui";

/** Bidder-facing RFQ email outcome wording. "Invited" is never used for an email that did not go out. */
export const RFQ_EMAIL_LABELS: Record<string, { label: string; tone: StatusTone }> = {
  sent: { label: "RFQ sent", tone: "info" },
  failed: { label: "RFQ failed", tone: "danger" },
  bounced: { label: "RFQ bounced", tone: "danger" },
  replied: { label: "Replied", tone: "success" },
  skipped_budget: { label: "RFQ not sent (daily email limit)", tone: "warning" },
  blocked_recipient: { label: "RFQ blocked (test recipient allowlist)", tone: "warning" },
  not_sent: { label: "Demo: no email sent", tone: "muted" },
};

/** States shown while the GC reviews the recipient list, and per-recipient results after sending. */
export const RFQ_RECIPIENT_LABELS: Record<string, { label: string; tone: StatusTone }> = {
  ready: { label: "Will be emailed", tone: "info" },
  not_selected: { label: "Not selected", tone: "muted" },
  demo_ready: { label: "Demo: no email", tone: "muted" },
  already_sent: { label: "Already sent", tone: "muted" },
  no_email: { label: "No email", tone: "warning" },
  email_unconfirmed: { label: "Email not confirmed", tone: "warning" },
  email_changed: { label: "Email changed; review again", tone: "warning" },
  not_in_package: { label: "Not on this package", tone: "muted" },
  ...RFQ_EMAIL_LABELS,
};

export const RETRYABLE_RFQ_STATUSES = new Set(["failed", "bounced", "skipped_budget", "blocked_recipient"]);

export const RFQ_BUDGET_MESSAGE = "Email limit reached for today — copy the RFQ link instead.";

export function rfqPortalLink(): string {
  return `${window.location.origin}/#/bids`;
}

export async function copyRfqLink(): Promise<string> {
  const link = rfqPortalLink();
  await navigator.clipboard.writeText(link);
  return link;
}
