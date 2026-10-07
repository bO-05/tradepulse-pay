import { RETAINAGE_PERCENT } from "../terms";
import { assertCents, splitRetainage, toDollarString } from "../lib/money";
import type { PayoutStatus } from "./stateMachine";

/**
 * Pure release & pay rules (architecture §4 steps 2–3): retainage split, capture finality,
 * PayPal payout item status mapping and duplicate-batch detection.
 *
 * Retainage policy for payouts that do not reach the sub: the ledger is credited when the payout
 * batch is created. If the item later ends FAILED or RETURNED (or the batch is denied), the credit is
 * reversed with one negative ledger row, because no progress payment was made and a new release will
 * withhold retainage again. UNCLAIMED keeps the credit: the funds sit with PayPal until the sub claims
 * them (SUCCESS) or PayPal returns them after 30 days (RETURNED, which reverses the credit then).
 * So the balance always equals the retainage of payouts in created, pending, unclaimed or success.
 */

export const RETAINAGE_REVERSING_STATUSES: readonly PayoutStatus[] = ["failed", "returned"];

export function retainagePercentFor(agreement: { retainagePercent?: number | null }): number {
  const pct = agreement.retainagePercent;
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : RETAINAGE_PERCENT;
}

/** gross → retainage = round(gross × pct), net = gross − retainage, all integer cents. */
export function computePayoutSplit(
  grossCents: number,
  retainagePercent: number,
): { grossCents: number; retainageCents: number; netCents: number } {
  assertCents(grossCents, "gross");
  if (grossCents <= 0) throw new Error(`Gross must be positive, got ${grossCents} cents`);
  const { retainageCents, netCents } = splitRetainage(grossCents, retainagePercent);
  return { grossCents, retainageCents, netCents };
}

/** Remaining capturable amount on a funding authorization. */
export function remainingAuthorizedCents(funding: { grossCents: number; capturedCents?: number | null }): number {
  return funding.grossCents - (funding.capturedCents ?? 0);
}

export type CaptureCheck =
  | { ok: true; finalCapture: boolean; remainingAfterCents: number }
  | { ok: false; message: string };

/** A capture equal to the remaining authorized amount is final; more than that is never sent. */
export function checkCaptureAmount(amountCents: number, remainingCents: number): CaptureCheck {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ok: false, message: "The release amount must be a positive whole number of cents." };
  }
  if (remainingCents <= 0) return { ok: false, message: "Nothing remains to capture on this authorization." };
  if (amountCents > remainingCents) {
    return {
      ok: false,
      message: `The release amount exceeds the ${toDollarString(remainingCents)} USD still authorized for this milestone.`,
    };
  }
  return { ok: true, finalCapture: amountCents === remainingCents, remainingAfterCents: remainingCents - amountCents };
}

/**
 * Maps a PayPal payout item `transaction_status` (and the batch status) to our payout status.
 * Returns null while PayPal has not settled the item yet.
 */
export type SettledPayoutStatus = Extract<PayoutStatus, "success" | "failed" | "unclaimed" | "returned">;

export function payoutStatusFromPayPal(itemStatus: string | undefined, batchStatus?: string): SettledPayoutStatus | null {
  const item = (itemStatus ?? "").toUpperCase();
  switch (item) {
    case "SUCCESS":
      return "success";
    case "UNCLAIMED":
      return "unclaimed";
    case "RETURNED":
      return "returned";
    case "FAILED":
    case "BLOCKED":
    case "REFUNDED":
    case "REVERSED":
    case "DENIED":
      return "failed";
    default:
      break;
  }
  const batch = (batchStatus ?? "").toUpperCase();
  if (batch === "DENIED" || batch === "CANCELED") return "failed";
  return null;
}

/** True when the PayPal error is the "Batch with given sender_batch_id already exists" 400. */
export function isDuplicateBatchError(data: { status?: number; issues?: string[] } | null | undefined): boolean {
  if (!data || data.status !== 400) return false;
  return (data.issues ?? []).some((i) => /sender_batch_id already exists/i.test(i));
}

/** The existing payout_batch_id from the duplicate-batch error's links, when PayPal included one. */
export function batchIdFromLinks(links: readonly string[] | undefined): string | undefined {
  for (const href of links ?? []) {
    const m = href.match(/\/v1\/payments\/payouts\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
    if (m) return m[1];
  }
  return undefined;
}

/** A milestone is paid once successful payouts cover its full amount. */
export function isMilestoneFullyPaid(milestoneAmountCents: number, successfulGrossCents: readonly number[]): boolean {
  return successfulGrossCents.reduce((a, c) => a + c, 0) >= milestoneAmountCents;
}

const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidRequestKey(key: string): boolean {
  return REQUEST_KEY_RE.test(key);
}
