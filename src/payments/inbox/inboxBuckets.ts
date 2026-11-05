const STATUS_LABEL: Record<string, string> = {
  submitted: "Submitted",
  under_review: "Under review",
  reviewed: "Ready for decision",
  approved: "Approved",
  approved_as_noted: "Approved as noted",
  revision_requested: "Revision requested",
  paid: "Paid",
  rejected: "Rejected",
};

const ACTIVE_STATUSES = new Set(["submitted", "under_review", "reviewed"]);
const WAITING_STATUSES = new Set(["approved", "approved_as_noted"]);

export type InboxGroup = "active" | "waiting" | "history";

/** Daily inbox buckets: work in front of the GC, approved work awaiting payment, then settled history. */
export function inboxGroup(status: string): InboxGroup {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (WAITING_STATUSES.has(status)) return "waiting";
  return "history";
}

export function payAppStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}
