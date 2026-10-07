/**
 * "Retry payout" rules for a release whose capture succeeded but whose payout ended failed or returned.
 * The retry is a new payout row for the same capture with sender_batch_id `<original key>_r<n>`, so
 * PayPal sees a new batch while every retry of a release stays traceable to the original.
 * Retainage follows the policy in payoutMath.ts: the retry credits its withheld retainage once when
 * PayPal accepts its batch; the failed original never kept a credit (it was reversed or never written).
 */

export type ReleaseAttempt = { _id: string; status: string; retryOfPaymentId?: string };

/** Payout states that mean money is out with PayPal or about to be: a retry would risk paying twice. */
export const BLOCKING_PAYOUT_STATUSES: readonly string[] = ["created", "capture_pending", "pending", "success", "unclaimed"];
/** Final states after which the sub has not been paid and nothing is in flight. */
export const RETRYABLE_PAYOUT_STATUSES: readonly string[] = ["failed", "returned"];

export function retryKey(originalIdempotencyKey: string, n: number): string {
  return `${originalIdempotencyKey}_r${n}`;
}

/** All attempts (the original release plus its retries) for `rootId`, in the given order. */
export function attemptsFor<T extends ReleaseAttempt>(rows: readonly T[], rootId: string): T[] {
  return rows.filter((r) => r._id === rootId || r.retryOfPaymentId === rootId);
}

export type RetryCheck = { ok: true; n: number } | { ok: false; code: string; message: string };

/** Whether a new payout may be sent for the release `rootId`, given every attempt for it. */
export function checkRetry(attempts: readonly ReleaseAttempt[], rootId: string, captured: boolean): RetryCheck {
  if (!captured) {
    return {
      ok: false,
      code: "NOT_CAPTURED",
      message: "Nothing was captured for this release, so there is nothing to pay out. Start a new release instead.",
    };
  }
  const blocking = attempts.find((a) => BLOCKING_PAYOUT_STATUSES.includes(a.status));
  if (blocking) {
    return {
      ok: false,
      code: blocking.status === "success" ? "ALREADY_PAID" : "PAYOUT_IN_FLIGHT",
      message:
        blocking.status === "success"
          ? "This release was already paid out. It will not be paid twice."
          : `A payout for this release is ${blocking.status}. Wait for it to settle; it will not be paid twice.`,
    };
  }
  if (!attempts.every((a) => RETRYABLE_PAYOUT_STATUSES.includes(a.status))) {
    return { ok: false, code: "NOT_RETRYABLE", message: "This release has no failed payout to retry." };
  }
  return { ok: true, n: attempts.filter((a) => a._id !== rootId).length + 1 };
}
