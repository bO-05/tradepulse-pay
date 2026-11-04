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

const BPS_PER_PERCENT = 100;

/** The agreement's retainage percent: its stored terms first, then the legacy percent field. */
export function retainagePercentFor(agreement: {
  retainagePercent?: number | null;
  terms?: { retainageBps: number; retainageReductionBpsAt50?: number } | null;
}): number {
  const bps = agreement.terms?.retainageBps;
  if (typeof bps === "number" && Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000) return bps / 100;
  const pct = agreement.retainagePercent;
  return typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : RETAINAGE_PERCENT;
}

/**
 * The retainage rate for the next pay application. When the agreement stores a reduced rate at 50%
 * complete, it applies once approved billing reaches half of the contract sum. The reduction affects
 * future billing only; retainage already withheld is not retroactively released.
 */
export function retainageBpsAtProgress(
  agreement: {
    retainagePercent?: number | null;
    terms?: { retainageBps: number; retainageReductionBpsAt50?: number } | null;
  },
  priorApprovedCents: number,
  contractSumCents: number,
): number {
  const base = Math.round(retainagePercentFor(agreement) * BPS_PER_PERCENT);
  const reduced = agreement.terms?.retainageReductionBpsAt50;
  if (typeof reduced !== "number" || !Number.isSafeInteger(reduced) || reduced < 0 || reduced > 10_000) return base;
  if (!Number.isSafeInteger(priorApprovedCents) || !Number.isSafeInteger(contractSumCents)) return base;
  if (priorApprovedCents <= 0 || contractSumCents <= 0) return base;
  return priorApprovedCents * 2 >= contractSumCents ? reduced : base;
}

/**
 * The retainage rate actually stored on a pay application's G703. After a mid-project reduction this
 * is the reduced rate for the new increment, while earlier periods keep the rate they were billed at.
 */
export function payAppRetainagePercent(
  payApp: { g703?: { retainageBps: number } | null },
  agreement: {
    retainagePercent?: number | null;
    terms?: { retainageBps: number; retainageReductionBpsAt50?: number } | null;
  },
): number {
  const bps = payApp.g703?.retainageBps;
  if (typeof bps === "number" && Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000) return bps / 100;
  return retainagePercentFor(agreement);
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
