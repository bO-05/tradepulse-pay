/**
 * Honor-period watcher decisions (architecture §4 step 6). Pure so the rules are unit tested:
 * - an uncaptured authorization past its 3-day honor period and before its 29-day expiry is reauthorized;
 * - an authorization at or past its expiry is marked expired (no PayPal call);
 * - captured, voided, expired and failed rows are never touched.
 * PayPal allows one reauthorization per authorization, so a row that was reauthorized once is only watched for expiry.
 */

export const HOUR_MS = 60 * 60 * 1000;
/** After PayPal rejects a reauthorization, wait this long before asking again (the cron runs hourly). */
export const REAUTHORIZE_RETRY_MS = 6 * HOUR_MS;

export type WatchedAuthorization = {
  kind: string;
  status: string;
  paypalAuthorizationId?: string;
  honorPeriodEndsAt?: number;
  authorizationExpiresAt?: number;
  reauthorizationCount?: number;
  reauthorizeRetryAfter?: number;
};

export type HonorPeriodDecision =
  | { action: "expire" }
  | { action: "reauthorize" }
  | { action: "skip"; reason: string };

const WATCHED: readonly string[] = ["authorized", "partially_captured"];

export function decideHonorPeriodAction(p: WatchedAuthorization, now: number): HonorPeriodDecision {
  if (p.kind !== "funding") return { action: "skip", reason: "not a funding payment" };
  if (!p.paypalAuthorizationId) return { action: "skip", reason: "no authorization" };
  if (!WATCHED.includes(p.status)) return { action: "skip", reason: `authorization is ${p.status}` };
  if (p.authorizationExpiresAt !== undefined && p.authorizationExpiresAt <= now) return { action: "expire" };
  // A partially captured authorization keeps its remainder until expiry or "Close milestone".
  if (p.status !== "authorized") return { action: "skip", reason: "partially captured; only expiry is watched" };
  if (p.honorPeriodEndsAt === undefined || p.honorPeriodEndsAt > now) {
    return { action: "skip", reason: "honor period has not ended" };
  }
  if ((p.reauthorizationCount ?? 0) >= 1) {
    return { action: "skip", reason: "already reauthorized once; PayPal allows one reauthorization" };
  }
  if (p.reauthorizeRetryAfter !== undefined && p.reauthorizeRetryAfter > now) {
    return { action: "skip", reason: "PayPal rejected the last reauthorization; waiting before retrying" };
  }
  return { action: "reauthorize" };
}

/** Request id for the n-th reauthorization of a funding payment (stable, so a retry is idempotent). */
export function reauthorizeRequestId(fundingIdempotencyKey: string, attempt: number): string {
  return `${fundingIdempotencyKey}_reauth_${attempt}`;
}
