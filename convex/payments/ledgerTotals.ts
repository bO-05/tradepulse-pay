import { sumCents } from "../lib/money";

export type LedgerPayApp = {
  status: string;
  requestedTotalCents: number;
  review?: { approvedTotalCents: number } | null;
};
export type LedgerPayment = { kind: string; status: string; netCents: number };
export type LedgerRetainageRow = { deltaCents: number };

export type LedgerTotals = {
  contractSumCents: number;
  billedCents: number;
  paidCents: number;
  retainageHeldCents: number;
  balanceCents: number;
};

const BILLED_PAY_APP_STATUSES = new Set(["approved", "paid"]);
const PAID_PAYMENT_KINDS = new Set(["payout", "retainage_release"]);

/**
 * Billed = approved pay applications (approved amount when reviewed), paid =
 * net of successful payouts and retainage releases, retainage held = ledger
 * balance, balance = contract sum less billed (balance to finish).
 */
export function computeLedgerTotals(input: {
  contractSumCents: number;
  payApps: readonly LedgerPayApp[];
  payments: readonly LedgerPayment[];
  retainage: readonly LedgerRetainageRow[];
}): LedgerTotals {
  const billedCents = sumCents(
    input.payApps
      .filter((p) => BILLED_PAY_APP_STATUSES.has(p.status))
      .map((p) => p.review?.approvedTotalCents ?? p.requestedTotalCents),
  );
  const paidCents = sumCents(
    input.payments
      .filter((p) => PAID_PAYMENT_KINDS.has(p.kind) && p.status === "success")
      .map((p) => p.netCents),
  );
  const retainageHeldCents = sumCents(input.retainage.map((r) => r.deltaCents));
  return {
    contractSumCents: input.contractSumCents,
    billedCents,
    paidCents,
    retainageHeldCents,
    balanceCents: input.contractSumCents - billedCents,
  };
}
