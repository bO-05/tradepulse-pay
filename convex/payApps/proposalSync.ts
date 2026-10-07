import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";

/**
 * Keeps approved proposals in step with the release payment they started. The payout proposal is
 * executed once PayPal has the payout batch; the paired capture proposal (linked by `paymentId`) is
 * executed once its capture completes. Either fails when the release fails. Called from the payment
 * writers (payout created/failed, capture failed/denied) so deferred retries and webhooks update it too.
 */
export async function syncProposalForPayment(ctx: MutationCtx, paymentId: Id<"payments">): Promise<void> {
  const payment = await ctx.db.get(paymentId);
  if (payment === null || payment.proposalId === undefined) return;
  const payout = await ctx.db.get(payment.proposalId);
  if (payout !== null && payout.status === "approved") {
    if (payment.paypalPayoutBatchId) {
      await finishProposal(ctx, payout, "executed", {
        paymentId: payment._id,
        detail: `payout batch ${payment.paypalPayoutBatchId}: ${formatCents(payment.grossCents)} gross, ${formatCents(payment.retainageCents)} retainage held, ${formatCents(payment.netCents)} net to the sub`,
      });
    } else if (payment.status === "failed") {
      await finishProposal(ctx, payout, "failed", { paymentId: payment._id, error: payment.error ?? "The release failed." });
    }
  }
  if (payout !== null) await syncCaptureProposal(ctx, payment, payout);
}

/** The capture proposal approved together with `payout` (same agent run). */
async function syncCaptureProposal(ctx: MutationCtx, payment: Doc<"payments">, payout: Doc<"agentProposals">): Promise<void> {
  if (payout.payAppId === undefined || payout.agentRunId === undefined) return;
  const proposals = await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payout.payAppId))
    .take(200);
  const capture = proposals.find((p) => p.kind === "capture" && p.status === "approved" && p.agentRunId === payout.agentRunId);
  if (capture === undefined) return;
  const funding = payment.fundingPaymentId ? await ctx.db.get(payment.fundingPaymentId) : null;
  const entry = funding?.captures?.find((c) => c.releasePaymentId === payment._id);
  if (entry !== undefined && entry.status === "COMPLETED") {
    await finishProposal(ctx, capture, "executed", {
      paymentId: payment._id,
      paypalCaptureId: entry.captureId,
      captureStatus: entry.status,
      detail: `capture ${entry.captureId} of ${formatCents(entry.amountCents)} (${entry.finalCapture ? "final" : "partial"})`,
    });
  } else if (payment.status === "failed") {
    await finishProposal(ctx, capture, "failed", {
      paymentId: payment._id,
      paypalCaptureId: entry?.captureId,
      captureStatus: entry?.status,
      error: payment.error ?? "The capture failed.",
    });
  } else if (entry !== undefined && capture.paypalCaptureId !== entry.captureId) {
    await ctx.db.patch(capture._id, { paypalCaptureId: entry.captureId, captureStatus: entry.status });
  }
}

export async function finishProposal(
  ctx: MutationCtx,
  proposal: Doc<"agentProposals">,
  status: "executed" | "failed",
  extra: { paymentId?: Id<"payments">; error?: string; detail?: string; paypalCaptureId?: string; captureStatus?: string },
): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(proposal._id, {
    status,
    ...(extra.paymentId ? { paymentId: extra.paymentId } : {}),
    ...(extra.paypalCaptureId ? { paypalCaptureId: extra.paypalCaptureId } : {}),
    ...(extra.captureStatus ? { captureStatus: extra.captureStatus } : {}),
    error: status === "failed" ? (extra.error ?? "Execution failed.").slice(0, 1000) : undefined,
    executedAt: now,
  });
  const agreement = await ctx.db.get(proposal.agreementId);
  await ctx.db.insert("auditLogs", {
    projectId: agreement?.projectId,
    agreementId: proposal.agreementId,
    eventType: status === "executed" ? "proposal_executed" : "proposal_failed",
    title: status === "executed" ? `Proposal executed (${proposal.kind})` : `Proposal failed (${proposal.kind})`,
    description: `${agreement?.agreementNumber ?? ""} ${proposal.kind} proposal ${proposal._id}: ${
      status === "executed" ? (extra.detail ?? "executed") : (extra.error ?? "failed")
    }`.slice(0, 1000),
    actor: "TradePulse Pay",
    timestamp: now,
  });
}
