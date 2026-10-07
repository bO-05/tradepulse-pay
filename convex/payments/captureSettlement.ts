import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { syncProposalForPayment } from "../payApps/proposalSync";
import { assertPaymentTransition } from "./stateMachine";

/**
 * Capture settlement (architecture §4/§6): a payout is only sent for a capture PayPal reports COMPLETED.
 * A PENDING capture parks its release in capture_pending until a PAYMENT.CAPTURE.COMPLETED webhook or a
 * "Refresh status" GET settles it; a denied capture fails the release without a payout or retainage credit.
 */

const DENIED_CAPTURE_STATUSES: readonly string[] = ["DENIED", "DECLINED", "FAILED"];

export function isCaptureDenied(status: string): boolean {
  return DENIED_CAPTURE_STATUSES.includes(status);
}

/** Whether the platform actually collected the capture, so the release it funds may be paid out. */
export function isCaptureCollected(status: string): boolean {
  return status !== "PENDING" && !isCaptureDenied(status);
}

const SETTLEMENT_EVENT_STATUS: Record<string, string> = {
  "PAYMENT.CAPTURE.COMPLETED": "COMPLETED",
  "PAYMENT.CAPTURE.DENIED": "DENIED",
};

export function isSettlementEvent(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTLEMENT_EVENT_STATUS, eventType);
}

/**
 * Moves the release funded by a capture according to the capture's settled status. COMPLETED resumes a
 * capture_pending release and schedules its payout once (the status guard makes repeats no-ops).
 */
export async function settleRelease(
  ctx: MutationCtx,
  releaseId: Id<"payments"> | undefined,
  captureId: string,
  captureStatus: string,
): Promise<boolean> {
  if (!releaseId) return false;
  const release = await ctx.db.get(releaseId);
  if (release === null || release.kind !== "payout" || release.paypalPayoutBatchId) return false;
  const now = Date.now();
  if (isCaptureDenied(captureStatus) && (release.status === "created" || release.status === "capture_pending")) {
    assertPaymentTransition("payout", release.status, "failed");
    await ctx.db.patch(release._id, {
      status: "failed",
      error: `PayPal denied capture ${captureId} (${captureStatus}). Nothing was collected, so the sub was not paid and no retainage was withheld.`,
      updatedAt: now,
    });
    await syncProposalForPayment(ctx, release._id);
    return true;
  }
  if (captureStatus === "COMPLETED" && release.status === "capture_pending") {
    assertPaymentTransition("payout", "capture_pending", "created");
    await ctx.db.patch(release._id, { status: "created", error: undefined, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.payments.payouts.retryPayoutForFunds, {
      paymentId: release._id,
      actor: "system:capture-completed",
      fundsRetry: 0,
    });
    return true;
  }
  return false;
}

/**
 * A capture that left PENDING never goes back: a PENDING GET response or event read before the
 * settlement committed is stale, and applying it would un-collect money a payout may already be queued for.
 */
export function isStaleCaptureStatus(stored: string, incoming: string): boolean {
  return incoming === "PENDING" && stored !== "PENDING";
}

/** Stores a capture's new PayPal status on its funding row and settles the release it funds. */
export async function applyCaptureStatus(
  ctx: MutationCtx,
  funding: Doc<"payments">,
  captureId: string,
  incomingStatus: string,
  error?: string,
): Promise<{ found: boolean; changed: boolean; status?: string }> {
  const captures = funding.captures ?? [];
  const i = captures.findIndex((c) => c.captureId === captureId);
  if (i < 0) return { found: false, changed: false };
  let status = incomingStatus;
  if (isStaleCaptureStatus(captures[i].status, incomingStatus)) {
    console.warn(
      `Ignored stale capture status for ${captureId}: stored ${captures[i].status}, received ${incomingStatus}.`,
    );
    status = captures[i].status;
    error = undefined;
  }
  let changed = false;
  if (captures[i].status !== status) {
    const next = captures.map((c, j) => (j === i ? { ...c, status } : c));
    await ctx.db.patch(funding._id, { captures: next, error: error ?? funding.error, updatedAt: Date.now() });
    changed = true;
  }
  const settled = await settleRelease(ctx, captures[i].releasePaymentId, captureId, status);
  return { found: true, changed: changed || settled, status };
}

/**
 * Settlement webhooks that arrived before their capture was stored are kept unprocessed. When the capture
 * is recorded, the latest one gives its status and every such event is marked processed.
 */
export async function takeEarlySettlement(ctx: MutationCtx, captureId: string): Promise<string | undefined> {
  const rows = await ctx.db
    .query("paypalEvents")
    .withIndex("by_resourceId", (q) => q.eq("resourceId", captureId))
    .take(50);
  const early = rows.filter((r) => r.verified && !r.processed && isSettlementEvent(r.eventType));
  if (early.length === 0) return undefined;
  for (const r of early) await ctx.db.patch(r._id, { processed: true, error: undefined });
  const latest = early.reduce((a, b) => (b.receivedAt >= a.receivedAt ? b : a));
  return SETTLEMENT_EVENT_STATUS[latest.eventType];
}

/** The capture that funds a release (for "Refresh status"), or null if none is stored yet. */
export const captureForRelease = internalQuery({
  args: { paymentId: v.id("payments") },
  returns: v.union(
    v.null(),
    v.object({ fundingPaymentId: v.id("payments"), captureId: v.string(), captureStatus: v.string(), releaseStatus: v.string() }),
  ),
  handler: async (ctx, { paymentId }) => {
    const release = await ctx.db.get(paymentId);
    if (release === null || release.kind !== "payout" || !release.fundingPaymentId) return null;
    const funding = await ctx.db.get(release.fundingPaymentId);
    const rootId = release.retryOfPaymentId ?? release._id;
    const capture = (funding?.captures ?? []).find((c) => c.releasePaymentId === rootId);
    if (!funding || !capture) return null;
    return { fundingPaymentId: funding._id, captureId: capture.captureId, captureStatus: capture.status, releaseStatus: release.status };
  },
});

/** Applies a capture status read from PayPal (GET /v2/payments/captures/{id}). */
export const applyCaptureSettlement = internalMutation({
  args: { fundingPaymentId: v.id("payments"), captureId: v.string(), status: v.string() },
  returns: v.object({ changed: v.boolean(), status: v.string() }),
  handler: async (ctx, args) => {
    const funding = await ctx.db.get(args.fundingPaymentId);
    if (funding === null || funding.kind !== "funding") return { changed: false, status: args.status };
    const error = isCaptureDenied(args.status) ? `PayPal denied capture ${args.captureId}.` : undefined;
    const out = await applyCaptureStatus(ctx, funding, args.captureId, args.status, error);
    return { changed: out.changed, status: out.status ?? args.status };
  },
});
