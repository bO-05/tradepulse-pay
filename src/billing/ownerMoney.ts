/**
 * Owner-money totals for the GC's owner-billing panel.
 *
 * This tallies the amounts the panel already shows on each owner pay app; it does not recompute
 * G702 figures, retainage or rollups. Drafts are not billed and `changes_requested` apps are not
 * owed, so neither contributes. `approved_invoiced` is approved money the owner has an invoice
 * for but has not paid yet, so it stays in the owed bucket.
 */
export type OwnerAppMoneyRow = { status: string; currentPaymentDueCents: number };

export type OwnerMoneyTotals = {
  /** Submitted to the owner and waiting on a decision. */
  submittedCents: number;
  /** Approved (invoiced or not) and not paid. */
  owedCents: number;
  /** Paid by the owner. */
  paidCents: number;
};

const OWED_STATUSES = new Set(["approved", "approved_invoiced"]);

export function ownerMoneyTotals(rows: readonly OwnerAppMoneyRow[]): OwnerMoneyTotals {
  let submittedCents = 0;
  let owedCents = 0;
  let paidCents = 0;
  for (const row of rows) {
    const cents = Number.isFinite(row.currentPaymentDueCents)
      ? Math.max(0, Math.round(row.currentPaymentDueCents))
      : 0;
    if (row.status === "submitted_to_owner") submittedCents += cents;
    else if (OWED_STATUSES.has(row.status)) owedCents += cents;
    else if (row.status === "paid") paidCents += cents;
  }
  return { submittedCents, owedCents, paidCents };
}
