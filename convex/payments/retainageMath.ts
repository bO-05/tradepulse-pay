/**
 * Pure retainage-release rules shared by the release mutation, the ledger query and the GC control.
 */

/**
 * A created release older than this with no batch id is treated as interrupted (its action died before
 * PayPal answered). It is longer than the longest INSUFFICIENT_FUNDS retry delay (payouts.ts), during
 * which a created row is legitimately waiting for its scheduled retry.
 */
export const RESUME_RELEASE_AFTER_MS = 3 * 60_000;

type ReleasePaymentLike = { _id: string; kind: string; status: string };
type RetainageRowLike = { deltaCents: number; paymentId?: string | null };

/**
 * Retainage that may be paid out now: credits of source payouts PayPal reports as SUCCESS, minus prior
 * releases and reversals. A pending or unclaimed source payout can still fail or be returned, which reverses
 * its credit; releasing that credit first would let the reversal take the ledger below zero.
 */
export function releasableRetainageCents(payments: readonly ReleasePaymentLike[], rows: readonly RetainageRowLike[]): number {
  const unsettledPayouts = new Set(payments.filter((p) => p.kind === "payout" && p.status !== "success").map((p) => p._id));
  let held = 0;
  let releasable = 0;
  for (const r of rows) {
    held += r.deltaCents;
    if (r.paymentId && unsettledPayouts.has(r.paymentId)) continue;
    releasable += r.deltaCents;
  }
  return Math.max(0, Math.min(releasable, held));
}

/** True for a retainage release stuck in created with no PayPal batch long enough that no action is still sending it. */
export function isInterruptedRelease(
  p: { kind?: string; status: string; paypalPayoutBatchId?: string | null; createdAt: number; updatedAt?: number | null },
  now: number,
): boolean {
  if (p.kind !== undefined && p.kind !== "retainage_release") return false;
  if (p.status !== "created" || p.paypalPayoutBatchId) return false;
  return now - (p.updatedAt ?? p.createdAt) >= RESUME_RELEASE_AFTER_MS;
}
