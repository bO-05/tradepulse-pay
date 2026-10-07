import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { receiverFor } from "./releaseDb";
import { isInterruptedRelease, releasableRetainageCents } from "./retainageMath";

/**
 * Database side of the closeout retainage release (architecture §4 step 4). One agreement has one sub,
 * so a release pays that sub the agreement's releasable retainage (retainageMath.releasableRetainageCents)
 * through one retainage_release payment.
 * The matching negative ledger row is written when PayPal accepts the batch (payoutDb.recordPayoutCreated),
 * which takes the releasable amount to 0; that is what keeps a second release from paying anything.
 */

async function ledgerRows(ctx: MutationCtx, agreementId: Id<"agreements">) {
  return await ctx.db
    .query("retainageLedger")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .take(1000);
}

const beginRetainageResult = v.union(
  v.object({ state: v.literal("nothing_to_release"), balanceCents: v.number() }),
  v.object({ state: v.literal("in_flight"), paymentId: v.id("payments"), amountCents: v.number() }),
  v.object({ state: v.literal("new"), paymentId: v.id("payments"), amountCents: v.number() }),
);
export type BeginRetainageRelease = Infer<typeof beginRetainageResult>;

/**
 * Creates the retainage_release payment for the current balance. A release that PayPal has not accepted
 * yet (status created) is returned instead of creating another, so double clicks resume the same batch.
 */
export const beginRetainageRelease = internalMutation({
  args: { agreementId: v.id("agreements") },
  returns: beginRetainageResult,
  handler: async (ctx, { agreementId }): Promise<BeginRetainageRelease> => {
    const agreement = await ctx.db.get(agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
      .take(500);
    const releases = payments.filter((p) => p.kind === "retainage_release");
    const inFlight = releases.find((p) => p.status === "created");
    if (inFlight) return { state: "in_flight", paymentId: inFlight._id, amountCents: inFlight.netCents };

    const balanceCents = releasableRetainageCents(payments, await ledgerRows(ctx, agreementId));
    if (balanceCents <= 0) return { state: "nothing_to_release", balanceCents };

    const receiverEmail = await receiverFor(ctx, agreement.contractorId);
    if (!receiverEmail) {
      throw new ConvexError({
        code: "NO_PAYOUT_ACCOUNT",
        message: `${agreement.subcontractorName} has no PayPal payout email on file. No retainage was released.`,
      });
    }
    const paymentId = await ctx.db.insert("payments", {
      agreementId,
      kind: "retainage_release",
      status: "created",
      grossCents: balanceCents,
      retainageCents: 0,
      netCents: balanceCents,
      receiverEmail,
      idempotencyKey: `ret_${agreementId}_${releases.length + 1}`,
      createdAt: Date.now(),
    });
    return { state: "new", paymentId, amountCents: balanceCents };
  },
});

/**
 * Guard for the GC "Resume release" control: only an interrupted created release (no batch id and stale,
 * see retainageMath) may be resumed. The caller then re-sends the same row, so sender_batch_id is unchanged.
 */
export const checkResumableRelease = internalMutation({
  args: { paymentId: v.id("payments") },
  returns: v.object({ amountCents: v.number() }),
  handler: async (ctx, { paymentId }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null || p.kind !== "retainage_release") {
      throw new ConvexError({ code: "NOT_FOUND", message: "Retainage release not found." });
    }
    if (p.status === "created" && !p.paypalPayoutBatchId && !isInterruptedRelease(p, Date.now())) {
      throw new ConvexError({
        code: "RELEASE_IN_PROGRESS",
        message: "This retainage release is still being sent to PayPal. Try resuming in a few minutes if it stays here.",
      });
    }
    return { amountCents: p.netCents };
  },
});
