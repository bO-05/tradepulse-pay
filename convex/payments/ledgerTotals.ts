import { sumCents } from "../lib/money";
import { attemptsFor } from "./payoutRetryMath";
import { approvedTotalFor } from "../payApps/validation";

export type LedgerPayApp = {
  status: string;
  requestedTotalCents: number;
  review?: { approvedTotalCents: number } | null;
  finalApproval?: { totalCents: number } | null;
};
export type LedgerPayment = {
  _id?: string;
  kind: string;
  status: string;
  netCents: number;
  grossCents?: number;
  capturedCents?: number;
  captures?: readonly { amountCents: number; status: string; releasePaymentId?: string }[];
  retryOfPaymentId?: string;
};
export type LedgerRetainageRow = { deltaCents: number; paymentId?: string };
export type LedgerChangeOrder = { status: string; amountCents: number };

export type LedgerTotals = {
  contractSumCents: number;
  billedCents: number;
  /** Authorized on the GC's card and not yet captured (authorized + partially captured remainders). */
  fundedCents: number;
  /** Captured from milestone authorizations into the platform account. */
  capturedCents: number;
  /** Captured, but no payout for that release has succeeded yet (pending, failed or awaiting retry). */
  capturedNotPaidCents: number;
  /** Net of successful payouts plus successful retainage releases. */
  paidCents: number;
  retainageHeldCents: number;
  retainageReleasedCents: number;
  changeOrdersInvoicedCents: number;
  changeOrdersPaidCents: number;
  /** Contract sum − (paid + retainage held): contract value not yet paid to or held for the sub. */
  balanceCents: number;
};

/** The documented balance formula, shown on the ledger view and in the README. */
export const BALANCE_FORMULA = "Balance = contract sum − (paid + retainage held)";

const BILLED_PAY_APP_STATUSES = new Set(["approved", "paid"]);
const PAID_PAYMENT_KINDS = new Set(["payout", "retainage_release"]);
const OPEN_AUTHORIZATION_STATUSES = new Set(["authorized", "partially_captured"]);
const VOID_CAPTURE_STATUSES = new Set(["DENIED", "DECLINED", "FAILED"]);

/**
 * Billed = approved pay applications (final GC-approved amount, else the review's); funded = open authorization
 * remainders; captured = recorded captures; paid = net of successful payouts and retainage releases;
 * retainage held = ledger balance; balance = contract sum − (paid + retainage held).
 */
export function computeLedgerTotals(input: {
  contractSumCents: number;
  payApps: readonly LedgerPayApp[];
  payments: readonly LedgerPayment[];
  retainage: readonly LedgerRetainageRow[];
  changeOrders?: readonly LedgerChangeOrder[];
}): LedgerTotals {
  const billedCents = sumCents(
    input.payApps
      .filter((p) => BILLED_PAY_APP_STATUSES.has(p.status))
      .map(approvedTotalFor),
  );
  const funding = input.payments.filter((p) => p.kind === "funding");
  const fundedCents = sumCents(
    funding
      .filter((p) => OPEN_AUTHORIZATION_STATUSES.has(p.status))
      .map((p) => (p.grossCents ?? p.netCents) - (p.capturedCents ?? 0)),
  );
  const captures = funding.flatMap((p) => p.captures ?? []).filter((c) => !VOID_CAPTURE_STATUSES.has(c.status));
  const capturedCents = sumCents(captures.map((c) => c.amountCents));
  const payouts = input.payments.filter((p) => p.kind === "payout") as (LedgerPayment & { _id: string })[];
  const releasePaid = (rootId: string) => attemptsFor(payouts, rootId).some((a) => a.status === "success");
  const capturedNotPaidCents = sumCents(
    captures.filter((c) => !c.releasePaymentId || !releasePaid(c.releasePaymentId)).map((c) => c.amountCents),
  );
  const paidCents = sumCents(
    input.payments
      .filter((p) => PAID_PAYMENT_KINDS.has(p.kind) && p.status === "success")
      .map((p) => p.netCents),
  );
  const retainageHeldCents = sumCents(input.retainage.map((r) => r.deltaCents));
  const releaseIds = new Set(input.payments.filter((p) => p.kind === "retainage_release").map((p) => p._id));
  const retainageReleasedCents = -sumCents(
    input.retainage.filter((r) => r.paymentId !== undefined && releaseIds.has(r.paymentId)).map((r) => r.deltaCents),
  );
  const changeOrders = input.changeOrders ?? [];
  const changeOrdersInvoicedCents = sumCents(changeOrders.filter((c) => c.status === "invoiced").map((c) => c.amountCents));
  const changeOrdersPaidCents = sumCents(changeOrders.filter((c) => c.status === "paid").map((c) => c.amountCents));
  return {
    contractSumCents: input.contractSumCents,
    billedCents,
    fundedCents,
    capturedCents,
    capturedNotPaidCents,
    paidCents,
    retainageHeldCents,
    retainageReleasedCents: retainageReleasedCents === 0 ? 0 : retainageReleasedCents,
    changeOrdersInvoicedCents,
    changeOrdersPaidCents,
    balanceCents: input.contractSumCents - (paidCents + retainageHeldCents),
  };
}
