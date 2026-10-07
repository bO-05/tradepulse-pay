import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { receiverFor } from "./releaseDb";

/**
 * Database side of the closeout retainage release (architecture §4 step 4). One agreement has one sub,
 * so a release pays that sub the agreement's whole ledger balance through one retainage_release payment.
 * The matching negative ledger row is written when PayPal accepts the batch (payoutDb.recordPayoutCreated),
 * which brings the balance to 0; that is what keeps a second release from paying anything.
 */

export async function retainageBalanceCents(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<number> {
  const rows = await ctx.db
    .query("retainageLedger")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .take(1000);
  return rows.reduce((acc, r) => acc + r.deltaCents, 0);
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

    const balanceCents = await retainageBalanceCents(ctx, agreementId);
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
