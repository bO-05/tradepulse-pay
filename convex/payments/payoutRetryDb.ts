import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { formatCents } from "../lib/money";
import { isCaptureCollected } from "./captureSettlement";
import { attemptsFor, checkRetry, retryKey } from "./payoutRetryMath";
import { payoutBlockedMessage, payoutReceiverForContractor } from "../lib/payee";
import { CAPTURED_NOT_PAID_EFFECT, initiationCheck } from "./resumeDb";

/**
 * Creates the retry payout row for a captured-but-unpaid release (see payoutRetryMath.ts). Runs in one
 * transaction, so two concurrent "Retry payout" clicks create one row: the second sees it as in flight.
 */
export const beginPayoutRetry = internalMutation({
  args: { paymentId: v.id("payments"), actor: v.string() },
  returns: v.object({ retryPaymentId: v.id("payments"), idempotencyKey: v.string(), n: v.number() }),
  handler: async (ctx, { paymentId, actor }) => {
    const given = await ctx.db.get(paymentId);
    if (given === null || given.kind !== "payout") {
      throw new ConvexError({ code: "NOT_FOUND", message: "Release not found." });
    }
    const root: Doc<"payments"> | null = given.retryOfPaymentId ? await ctx.db.get(given.retryOfPaymentId) : given;
    if (root === null || !root.milestoneId || !root.fundingPaymentId) {
      throw new ConvexError({ code: "INVALID_STATE", message: "This release has no milestone funding to pay from." });
    }
    const siblings = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", root.milestoneId))
      .take(200);
    const attempts = attemptsFor(
      siblings.filter((s) => s.kind === "payout"),
      root._id,
    );
    const funding = await ctx.db.get(root.fundingPaymentId);
    const captured = (funding?.captures ?? []).some((c) => c.releasePaymentId === root._id && isCaptureCollected(c.status));
    const check = checkRetry(attempts, root._id, captured);
    if (!check.ok) throw new ConvexError({ code: check.code, message: check.message });

    const agreement = await ctx.db.get(root.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    // The retry pays the payee confirmed now, never the address stored on the failed attempt.
    const receiver = await payoutReceiverForContractor(ctx, agreement.contractorId);
    if (!receiver.ok) {
      throw new ConvexError({
        code: "NO_PAYOUT_ACCOUNT",
        message: payoutBlockedMessage(agreement.subcontractorName, receiver.reason, "Nothing was paid."),
      });
    }
    // A retry sends a new payout batch: a new money write, so the release's pay app must still pass canPay,
    // and it pays the approved G702 split, not the split stored on the failed attempt.
    const initiation = await initiationCheck(ctx, root, CAPTURED_NOT_PAID_EFFECT);
    if (initiation.refusal !== null) throw new ConvexError(initiation.refusal);
    const { retainageCents, netCents } = initiation.figures;
    const receiverEmail = receiver.email;
    const idempotencyKey = retryKey(root.idempotencyKey, check.n);
    const now = Date.now();
    const retryPaymentId = await ctx.db.insert("payments", {
      agreementId: root.agreementId,
      milestoneId: root.milestoneId,
      payAppId: root.payAppId,
      proposalId: root.proposalId,
      kind: "payout",
      status: "created",
      grossCents: root.grossCents,
      retainageCents,
      netCents,
      fundingPaymentId: root.fundingPaymentId,
      receiverEmail,
      retryOfPaymentId: root._id,
      idempotencyKey,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      agreementId: agreement._id,
      eventType: "payout_retry",
      title: `Payout retry ${check.n} for ${agreement.agreementNumber}`,
      description: `${actor} retried the payout of a captured release (${formatCents(root.grossCents)} gross, ${formatCents(netCents)} net) after it ended ${attempts[attempts.length - 1]?.status ?? root.status}. New sender_batch_id ${idempotencyKey}; original ${root.idempotencyKey}.`,
      actor,
      timestamp: now,
      operation: "payout.retry",
    });
    return { retryPaymentId, idempotencyKey, n: check.n };
  },
});
